import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_SCHEMA_STATEMENTS } from '../../../src/server/db/billing-schema';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { fakeStripeClient } from '../../../src/server/integrations/stripe';
import {
	collegeBillingStore,
	entitlementOf,
	handleEvent,
	processWebhook,
	type BillingServices,
	type BillingStore
} from '../../../src/server/services/billing';
import {
	NOW,
	WEBHOOK_SECRET,
	checkoutCompleted,
	event,
	packCheckoutCompleted,
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
				planId: 'managed-pro',
				addOns: [],
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
				addOns: []
			});
			const second = await store.ensureAccount(org, 99);
			expect(second.createdAt).toBe(10);
			expect(entitlementOf(second).planId).toBe('managed-free');
		});

		it('inserts a subscription row at revision one and bumps it on each newer event', async () => {
			const org = id('org');
			expect(await apply(org)).toBe(1);
			expect(await apply(org, { planId: 'managed-agency', eventAt: 2000 })).toBe(2);
			expect(await apply(org, { planId: 'managed-pro', eventAt: 2000 })).toBe(3);
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-pro',
				revision: 3,
				lastEventAt: 2000
			});
		});

		it('changes nothing for an event older than the last one applied', async () => {
			const org = id('org');
			await apply(org, { eventAt: 5000 });
			expect(await apply(org, { planId: 'managed-pro', eventAt: 4999 })).toBeNull();
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-pro',
				revision: 1,
				lastEventAt: 5000
			});
		});

		it('keeps add-ons with their quantities', async () => {
			const org = id('org');
			await apply(org, {
				planId: 'institution-standard',
				addOns: [
					{ id: 'assurance', quantity: 1 },
					{ id: 'site-block-standard', quantity: 3 }
				],
				entitlementState: 'blocked'
			});
			expect((await store.getAccount(org))?.addOns).toEqual([
				{ id: 'assurance', quantity: 1 },
				{ id: 'site-block-standard', quantity: 3 }
			]);
		});

		it('credits a source id once, however many times and in parallel, and sums per meter', async () => {
			const org = id('org');
			const source = id('evt');
			const credit = (sourceId: string, meter = 'support-hours', units = 5) =>
				store.addCredit({ organizationId: org, meter, units, sourceId, now: 1 });
			expect(await store.creditBalances(org)).toEqual({});
			const results = await Promise.all(Array.from({ length: 10 }, () => credit(source)));
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(await credit(id('evt'), 'support-hours', 10)).toBe(true);
			expect(await credit(id('evt'), 'mail-sends', 1)).toBe(true);
			expect(await store.creditBalances(org)).toEqual({
				'mail-sends': 1,
				'support-hours': 15
			});
			expect(await store.creditBalances(id('org'))).toEqual({});
		});

		it('refuses a credit of no units through the check constraint', async () => {
			await expect(
				store.addCredit({
					organizationId: id('org'),
					meter: 'support-hours',
					units: 0,
					sourceId: id('evt'),
					now: 1
				})
			).rejects.toThrow(/CHECK/);
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

		it('saves the billing details without touching the event clock, and a null patch clears one', async () => {
			const org = id('org');
			await store.ensureAccount(org, 10);
			await store.patchAccount(org, { status: 'active' }, 500, 11);
			await store.setBillingDetails(
				org,
				{ name: 'Ada Owner', email: 'ada@example.test', country: 'US' },
				12
			);
			expect(await store.getAccount(org)).toMatchObject({
				billingName: 'Ada Owner',
				billingEmail: 'ada@example.test',
				billingCountry: 'US',
				lastEventAt: 500,
				updatedAt: 12
			});
			expect(await store.patchAccount(org, { billingCountry: null }, 600, 13)).toBe(true);
			expect(await store.getAccount(org)).toMatchObject({
				billingName: 'Ada Owner',
				billingCountry: null
			});
		});

		it('keeps a pending purchase per organisation until it is cleared once', async () => {
			const org = id('org');
			const other = id('org');
			const session = id('cs');
			await store.addPending({
				sessionId: session,
				organizationId: org,
				mode: 'payment',
				now: 1
			});
			await store.addPending({
				sessionId: session,
				organizationId: org,
				mode: 'payment',
				now: 2
			});
			expect(await store.clearPending(other, session)).toBe(false);
			expect(await store.clearPending(org, session)).toBe(true);
			expect(await store.clearPending(org, session)).toBe(false);
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
				planId: 'managed-pro',
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
				planId: 'managed-pro',
				entitlementState: 'activated',
				subscriptionId: 'sub_9',
				stripeCustomerId: customer,
				revision: 1
			});
			const replay = await processWebhook(s, sub.raw, sub.header);
			expect(replay.body).toEqual({ received: true, duplicate: true });
			expect((await store.getAccount(org))?.revision).toBe(1);
		});

		it('credits a one-time pack through the webhook once, even when the event row is lost', async () => {
			const org = id('org');
			const customer = id('cus');
			const s = services();
			const body = event(
				'checkout.session.completed',
				packCheckoutCompleted({ org, customer })
			);
			const { raw, header } = await signed(body);
			expect((await processWebhook(s, raw, header)).body).toMatchObject({
				outcome: 'handled'
			});
			expect((await processWebhook(s, raw, header)).body).toEqual({
				received: true,
				duplicate: true
			});
			await handleEvent(s, body as never);
			expect(await store.creditBalances(org)).toEqual({ 'support-hours': 5 });
			expect(await store.getAccount(org)).toMatchObject({
				planId: 'managed-free',
				addOns: []
			});
		});

		it('applies an add-on only subscription on the free plan with the item quantity', async () => {
			const org = id('org');
			const customer = id('cus');
			await store.linkCustomer(customer, org);
			const { raw, header } = await signed(
				event(
					'customer.subscription.created',
					subscription({
						customer,
						plans: [],
						addOns: [{ id: 'support-hours', quantity: 3 }]
					})
				)
			);
			await processWebhook(services(), raw, header);
			const account = await store.getAccount(org);
			expect(account).toMatchObject({
				planId: 'managed-free',
				addOns: [{ id: 'support-hours', quantity: 3 }],
				entitlementState: 'activated'
			});
			expect(entitlementOf(account).supportHoursPerYear).toBe(36);
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
			expect((await store.getAccount(org))?.planId).toBe('managed-pro');
		});
	});
}

await suite(undefined, 'one shard');
await suite(TWO_SHARD_CONFIG, 'two shards');
