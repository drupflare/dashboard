import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_SCHEMA_STATEMENTS } from '../../../src/server/db/billing-schema';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { fakeStripeClient } from '../../../src/server/integrations/stripe';
import {
	collegeBillingStore,
	entitlementOf,
	processWebhook,
	type BillingServices,
	type BillingStore
} from '../../../src/server/services/billing';
import {
	NOW,
	WEBHOOK_SECRET,
	checkoutCompleted,
	event,
	signed,
	subscription
} from '../../unit/server/services/billing-support';
import { TWO_SHARD_CONFIG, openBindings, type OpenBindings } from '../support';

async function suite(config: string | undefined, label: string) {
	describe(`billing on D1 (${label})`, () => {
		let open: OpenBindings;
		let db: CollegeDBClient;
		let store: BillingStore;

		beforeAll(async () => {
			open = await openBindings(config);
			db = await ensureCollegeDB(open.env);
			await db.ensureSchema(BILLING_SCHEMA_STATEMENTS);
			store = collegeBillingStore(async () => db);
		});

		afterAll(() => open.close());

		const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
		const apply = (orgId: string, over: Record<string, unknown> = {}) =>
			store.applySubscription({
				organizationId: orgId,
				customerId: `cus-${orgId}`,
				subscriptionId: 'sub_1',
				planId: 'managed-studio',
				addOnIds: [],
				status: 'active',
				entitlementState: 'activated',
				eventAt: 1000,
				now: 5,
				...over
			});

		it('reads an organisation with no row as null and creates the free baseline once', async () => {
			const org = id('org');
			expect(await store.getAccount(org)).toBeNull();
			const first = await store.ensureAccount(org, 10);
			expect(first).toMatchObject({
				planId: 'managed-free',
				status: 'none',
				entitlementState: 'pending',
				revision: 0,
				addOnIds: []
			});
			const second = await store.ensureAccount(org, 99);
			expect(second.createdAt).toBe(10);
			expect(entitlementOf(second).planId).toBe('managed-free');
		});

		it('inserts a subscription row at revision one and bumps it on each newer event', async () => {
			const org = id('org');
			expect(await apply(org)).toBe(1);
			expect(await apply(org, { planId: 'managed-agency', eventAt: 2000 })).toBe(2);
			expect(await apply(org, { planId: 'managed-site', eventAt: 2000 })).toBe(3);
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-site',
				revision: 3,
				lastEventAt: 2000
			});
		});

		it('changes nothing for an event older than the last one applied', async () => {
			const org = id('org');
			await apply(org, { eventAt: 5000 });
			expect(await apply(org, { planId: 'managed-site', eventAt: 4999 })).toBeNull();
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-studio',
				revision: 1,
				lastEventAt: 5000
			});
		});

		it('keeps add-on ids as a list', async () => {
			const org = id('org');
			await apply(org, {
				planId: 'institution-standard',
				addOnIds: ['assurance'],
				entitlementState: 'blocked'
			});
			expect((await store.getAccount(org))?.addOnIds).toEqual(['assurance']);
		});

		it('patches columns without bumping the revision and honours the same staleness rule', async () => {
			const org = id('org');
			await apply(org, { eventAt: 1000 });
			expect(
				await store.patchAccount(
					org,
					{ status: 'past_due', lastInvoiceId: 'in_1' },
					1500,
					7
				)
			).toBe(true);
			expect(await store.getAccount(org)).toMatchObject({
				status: 'past_due',
				lastInvoiceId: 'in_1',
				revision: 1,
				lastEventAt: 1500,
				updatedAt: 7
			});
			expect(await store.patchAccount(org, { status: 'active' }, 1400, 8)).toBe(false);
			expect((await store.getAccount(org))?.status).toBe('past_due');
			expect(await store.patchAccount(org, {}, 2000, 9)).toBe(false);
			expect(await store.patchAccount(id('org'), { status: 'active' }, 2000, 9)).toBe(false);
		});

		it('refuses an out-of-list status through the check constraint', async () => {
			const org = id('org');
			await expect(apply(org, { status: 'paid' })).rejects.toThrow(/CHECK/);
		});

		it('links a customer once and reports a second organisation as a conflict', async () => {
			const customer = id('cus');
			const a = id('org');
			const b = id('org');
			expect(await store.findOrgByCustomer(customer)).toBeNull();
			expect(await store.linkCustomer(customer, a)).toBe('linked');
			expect(await store.linkCustomer(customer, a)).toBe('linked');
			expect(await store.linkCustomer(customer, b)).toBe('conflict');
			expect(await store.findOrgByCustomer(customer)).toBe(a);
		});

		it('records an event id once, however many times and in parallel', async () => {
			const eventId = id('evt');
			expect(await store.hasEvent(eventId)).toBe(false);
			await Promise.all(
				Array.from({ length: 10 }, () => store.recordEvent(eventId, 'invoice.paid', 1))
			);
			expect(await store.hasEvent(eventId)).toBe(true);
			const rows = await open.env.DB.prepare(
				'SELECT count(*) AS n FROM stripe_events WHERE event_id = ?'
			)
				.bind(eventId)
				.first<{ n: number }>();
			expect(rows?.n).toBe(1);
		});

		it('converges when the same subscription event is applied in parallel', async () => {
			const org = id('org');
			await Promise.all(Array.from({ length: 10 }, () => apply(org)));
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-studio',
				entitlementState: 'activated',
				lastEventAt: 1000
			});
		});

		const services = (over: Partial<BillingServices> = {}): BillingServices => ({
			stripe: fakeStripeClient(),
			webhookSecret: WEBHOOK_SECRET,
			store,
			audit: async () => undefined,
			flags: { ssoBuilt: false, overageEnabled: false },
			now: () => NOW,
			log: () => undefined,
			baseUrl: 'https://app.example.test',
			...over
		});

		it('runs a checkout and a subscription through the webhook, and treats a replay as a no-op', async () => {
			const org = id('org');
			const customer = id('cus');
			const s = services();
			const checkout = await signed(
				event('checkout.session.completed', { ...checkoutCompleted({ customer, org }) })
			);
			const sub = await signed(
				event('customer.subscription.created', subscription({ customer, id: 'sub_9' }))
			);
			expect((await processWebhook(s, checkout.raw, checkout.header)).body).toMatchObject({
				outcome: 'handled'
			});
			expect((await processWebhook(s, sub.raw, sub.header)).body).toMatchObject({
				outcome: 'handled'
			});
			const settled = await store.getAccount(org);
			expect(settled).toMatchObject({
				planId: 'managed-studio',
				entitlementState: 'activated',
				subscriptionId: 'sub_9',
				stripeCustomerId: customer,
				revision: 1
			});
			const replay = await processWebhook(s, sub.raw, sub.header);
			expect(replay.body).toEqual({ received: true, duplicate: true });
			expect((await store.getAccount(org))?.revision).toBe(1);
		});

		it('writes no event row when the handler fails and finishes on the retry', async () => {
			const org = id('org');
			const customer = id('cus');
			await store.linkCustomer(customer, org);
			const body = event('customer.subscription.created', subscription({ customer }));
			const { raw, header } = await signed(body);
			const failing = services({
				audit: async () => {
					throw new Error('audit down');
				}
			});
			await expect(processWebhook(failing, raw, header)).rejects.toThrow('audit down');
			expect(await store.hasEvent(body.id)).toBe(false);
			await processWebhook(services(), raw, header);
			expect(await store.hasEvent(body.id)).toBe(true);
			expect((await store.getAccount(org))?.planId).toBe('managed-studio');
		});
	});
}

await suite(undefined, 'one shard');
await suite(TWO_SHARD_CONFIG, 'two shards');
