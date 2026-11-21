import { afterEach, describe, expect, it } from 'vitest';
import { IntervalMismatchError } from '../../../../src/server/integrations/stripe';
import {
	billingFlags,
	billingServices,
	desiredFor,
	entitlementFor,
	entitlementOf,
	HANDLED_EVENTS,
	handleEvent,
	holdsPlanSubscription,
	isBillingAdmin,
	isFreePlanId,
	listPlans,
	missingBillingDetails,
	processWebhook,
	saveBillingDetails,
	setBillingServices,
	startCheckout,
	startPortal,
	type BillingServices
} from '../../../../src/server/services/billing';
import { startAddOnPurchase } from '../../../../src/server/services/billing-addons';
import { ApiError } from '../../../../src/shared/errors';
import { PLANS } from '../../../../src/shared/plans';
import { facts, fresh, member } from '../../domain/fixtures';
import {
	checkoutCompleted,
	CONTACT,
	event,
	NOW,
	packCheckoutCompleted,
	rig,
	signed,
	subscription,
	withDetails
} from './billing-support';

const USER = { kind: 'user', userId: 'user-1' } as const;
const KEY = { kind: 'key', keyId: 'key-1', issuerId: 'user-1' } as const;

afterEach(() => setBillingServices(null));

const handle = (s: BillingServices, type: string, object: unknown, over = {}) =>
	handleEvent(s, event(type, object, over) as never);

const thrown = async (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) => error
	);

async function expectApiError(promise: Promise<unknown>, code: string, details?: object) {
	const error = await thrown(promise);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	if (details) expect((error as ApiError).details).toMatchObject(details);
}

describe('processWebhook', () => {
	it('refuses a bad or stale signature before any handler or store runs', async () => {
		const r = rig();
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const good = await signed(body);
		const wrong = await signed(body, NOW, 'whsec_other');
		const stale = await signed(body, NOW - 301_000);
		for (const [raw, header] of [
			[good.raw, wrong.header],
			[stale.raw, stale.header],
			[good.raw, null],
			['{not json', good.header]
		] as const) {
			await expectApiError(processWebhook(r.services, raw, header), 'validation');
		}
		expect(r.store.accounts.size).toBe(0);
		expect(r.store.events.size).toBe(0);
		expect(r.audits).toEqual([]);
	});

	it('answers not_built without a webhook secret', async () => {
		const r = rig({ webhookSecret: null });
		const { raw, header } = await signed(event('invoice.paid', {}));
		await expectApiError(processWebhook(r.services, raw, header), 'not_built');
	});

	it('handles a verified event, writes its id after the handler, and treats a replay as a no-op', async () => {
		const r = rig();
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const { raw, header } = await signed(body);
		const first = await processWebhook(r.services, raw, header);
		expect(first).toEqual({ status: 200, body: { received: true, outcome: 'handled' } });
		expect(r.store.events.get(body.id)).toBe('customer.subscription.created');
		const revision = r.store.accounts.get('org-1')?.revision;
		const replay = await processWebhook(r.services, raw, header);
		expect(replay).toEqual({ status: 200, body: { received: true, duplicate: true } });
		expect(r.store.accounts.get('org-1')?.revision).toBe(revision);
		expect(r.audits).toHaveLength(1);
	});

	it('leaves no idempotency row when the handler fails, and the retry completes', async () => {
		let fail = true;
		const r = rig({
			audit: async () => {
				if (fail) throw new Error('audit store down');
			}
		});
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const { raw, header } = await signed(body);
		await expect(processWebhook(r.services, raw, header)).rejects.toThrow('audit store down');
		expect(r.store.events.size).toBe(0);
		fail = false;
		const retry = await processWebhook(r.services, raw, header);
		expect(retry.body).toMatchObject({ outcome: 'handled' });
		expect(r.store.events.has(body.id)).toBe(true);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-pro',
			entitlementState: 'activated'
		});
	});

	it('acks and logs an event type it does not handle', async () => {
		const r = rig();
		const body = event('payout.paid', { id: 'po_1' });
		const { raw, header } = await signed(body);
		const result = await processWebhook(r.services, raw, header);
		expect(result.body).toEqual({ received: true, outcome: 'unknown_type' });
		expect(r.logs).toEqual([
			{
				message: 'unknown stripe event type',
				detail: { eventId: body.id, type: 'payout.paid' }
			}
		]);
		expect(r.store.events.has(body.id)).toBe(true);
	});
});

describe('checkout.session.completed', () => {
	it('links the customer to the organisation named by the reference and audits it', async () => {
		const r = rig();
		expect(await handle(r.services, 'checkout.session.completed', checkoutCompleted())).toBe(
			'handled'
		);
		expect(r.store.customers.get('cus_fixture')).toBe('org-1');
		expect(r.store.accounts.get('org-1')).toMatchObject({
			stripeCustomerId: 'cus_fixture',
			subscriptionId: 'sub_fixture',
			planId: 'managed-free'
		});
		expect(r.audits[0]).toMatchObject({
			orgId: 'org-1',
			input: {
				action: 'billing.customer.linked',
				actor: expect.stringMatching(/^stripe:evt_/)
			}
		});
	});

	it('refuses a customer that already belongs to another organisation', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await expect(
			handle(r.services, 'checkout.session.completed', checkoutCompleted({ org: 'org-2' }))
		).rejects.toThrow(/already linked/);
	});

	it('ignores a session with no organisation or no customer', async () => {
		const r = rig();
		expect(
			await handle(r.services, 'checkout.session.completed', checkoutCompleted({ org: null }))
		).toBe('ignored');
		expect(
			await handle(r.services, 'checkout.session.completed', {
				...checkoutCompleted(),
				customer: null
			})
		).toBe('ignored');
		expect(r.store.accounts.size).toBe(0);
	});

	it('falls back to the metadata organisation', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', {
			...checkoutCompleted({ org: null }),
			metadata: { organization_id: 'org-9' }
		});
		expect(r.store.customers.get('cus_fixture')).toBe('org-9');
	});
});

describe('one-time packs', () => {
	const pack = (over = {}, eventOver: { id?: string } = {}) =>
		event('checkout.session.completed', packCheckoutCompleted(over), eventOver);

	it('credits the pack to its meter once, keyed by the event id, and changes no plan', async () => {
		const r = rig();
		const body = pack();
		expect(await handleEvent(r.services, body as never)).toBe('handled');
		expect(r.store.credits.get(body.id)).toEqual({
			organizationId: 'org-1',
			meter: 'support-hours',
			units: 5
		});
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 5 });
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-free',
			addOns: [],
			entitlementState: 'pending'
		});
		expect(r.audits.map((a) => a.input.action)).toEqual([
			'billing.credit.added',
			'billing.customer.linked'
		]);
	});

	it('does not credit twice when the same event arrives again', async () => {
		const r = rig();
		const body = pack();
		const { raw, header } = await signed(body);
		await processWebhook(r.services, raw, header);
		const replay = await processWebhook(r.services, raw, header);
		expect(replay.body).toEqual({ received: true, duplicate: true });
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 5 });
		// the event row can be missing after a crash; the credit still holds
		await handleEvent(r.services, body as never);
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 5 });
		expect(r.audits.filter((a) => a.input.action === 'billing.credit.added')).toHaveLength(1);
	});

	it('adds a second purchase to the first', async () => {
		const r = rig();
		await handleEvent(r.services, pack({ units: 5 }) as never);
		await handleEvent(r.services, pack({ units: 10 }) as never);
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 15 });
	});

	it('reads the pack from the session metadata when stripe sends no line items', async () => {
		const r = rig();
		await handleEvent(r.services, pack({ lines: false, units: 20 }) as never);
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 20 });
	});

	it('multiplies a pack by the quantity on its line', async () => {
		const r = rig();
		const session = {
			...packCheckoutCompleted(),
			line_items: {
				data: [
					{ price: { lookup_key: 'drupflare_addon_support_hours_pack_5' }, quantity: 3 }
				]
			}
		};
		await handle(r.services, 'checkout.session.completed', session);
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 15 });
	});

	it('credits a payment that carries no customer', async () => {
		const r = rig();
		expect(await handleEvent(r.services, pack({ customer: null }) as never)).toBe('handled');
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 5 });
		expect(r.store.customers.size).toBe(0);
	});

	it('logs and ignores a price that is not a pack, and credits nothing', async () => {
		const r = rig();
		for (const key of [
			'someone_elses_price',
			'drupflare_addon_support_hours_pack_7',
			'drupflare_addon_support_hours_monthly',
			'drupflare_managed_pro_monthly'
		]) {
			expect(await handleEvent(r.services, pack({ key }) as never)).toBe('handled');
		}
		expect(r.store.credits.size).toBe(0);
		expect(
			r.logs.filter((l) => l.message === 'payment for a price that is not a pack')
		).toHaveLength(4);
		expect(
			await handle(r.services, 'checkout.session.completed', {
				...packCheckoutCompleted({ customer: null }),
				line_items: { data: [{ price: null }] }
			})
		).toBe('ignored');
	});

	it('credits nothing for a payment that is not paid yet', async () => {
		const r = rig();
		await handleEvent(r.services, pack({ paymentStatus: 'unpaid' }) as never);
		expect(r.store.credits.size).toBe(0);
		expect(r.store.pending.get('cs_pack_fixture')).toEqual({
			organizationId: 'org-1',
			mode: 'payment'
		});
		const bare = { ...packCheckoutCompleted(), payment_status: undefined };
		await handle(r.services, 'checkout.session.completed', bare);
		expect(r.store.credits.size).toBe(0);
	});

	it('credits nothing for a subscription session, whatever its metadata says', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', {
			...checkoutCompleted(),
			metadata: { price_lookup_key: 'drupflare_addon_support_hours_pack_5' }
		});
		expect(r.store.credits.size).toBe(0);
	});

	it('ignores a pack session that names no organisation', async () => {
		const r = rig();
		expect(await handleEvent(r.services, pack({ org: null }) as never)).toBe('ignored');
		expect(r.store.credits.size).toBe(0);
	});

	it('leaves the event open when the credit audit fails, and the retry credits once', async () => {
		let fail = true;
		const r = rig({
			audit: async () => {
				if (fail) throw new Error('audit store down');
			}
		});
		const body = pack();
		const { raw, header } = await signed(body);
		await expect(processWebhook(r.services, raw, header)).rejects.toThrow('audit store down');
		expect(r.store.events.size).toBe(0);
		fail = false;
		await processWebhook(r.services, raw, header);
		expect(await r.store.creditBalances('org-1')).toEqual({ 'support-hours': 5 });
	});
});

describe('customer.subscription events', () => {
	const linked = async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		return r;
	};

	it('activates the plan a running subscription names', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		const account = r.store.accounts.get('org-1');
		expect(account).toMatchObject({
			planId: 'managed-pro',
			status: 'active',
			entitlementState: 'activated',
			subscriptionId: 'sub_fixture'
		});
		expect(entitlementOf(account ?? null).planId).toBe('managed-pro');
		expect(r.audits.at(-1)?.input.action).toBe('billing.entitlement.activated');
	});

	it('runs the activation hook once per activating event and never for a revoked account', async () => {
		const activated: string[] = [];
		const r = rig({
			onActivated: async (orgId) => {
				activated.push(orgId);
			}
		});
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		expect(activated).toEqual(['org-1']);
		await handle(
			r.services,
			'customer.subscription.deleted',
			subscription({ status: 'canceled' })
		);
		expect(activated).toEqual(['org-1']);
	});

	it('handles the event and logs when the activation hook fails', async () => {
		const r = rig({
			onActivated: async () => {
				throw new Error('budget store down');
			}
		});
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		expect(r.store.accounts.get('org-1')?.entitlementState).toBe('activated');
		expect(r.logs.some((entry) => entry.message === 'activation hook failed')).toBe(true);
	});

	it('moves to a new plan on an update and bumps the revision', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		const before = r.store.accounts.get('org-1')?.revision as number;
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-agency'], interval: 'year' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({ planId: 'managed-agency' });
		expect(r.store.accounts.get('org-1')?.revision).toBe(before + 1);
	});

	it('keeps the plan while a payment is past due and trialing counts as running', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ status: 'trialing' })
		);
		expect(r.store.accounts.get('org-1')?.entitlementState).toBe('activated');
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ status: 'past_due' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'past_due',
			planId: 'managed-pro',
			entitlementState: 'activated'
		});
	});

	it.each(['canceled', 'unpaid', 'incomplete_expired'])(
		'revokes to the free plan when the status is %s',
		async (status) => {
			const r = await linked();
			await handle(r.services, 'customer.subscription.created', subscription());
			await handle(r.services, 'customer.subscription.updated', subscription({ status }));
			expect(r.store.accounts.get('org-1')).toMatchObject({
				planId: 'managed-free',
				entitlementState: 'revoked',
				status
			});
			expect(entitlementOf(r.store.accounts.get('org-1') ?? null).planId).toBe(
				'managed-free'
			);
		}
	);

	it('revokes when the subscription is deleted', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		await handle(
			r.services,
			'customer.subscription.deleted',
			subscription({ status: 'canceled' })
		);
		expect(r.store.accounts.get('org-1')?.entitlementState).toBe('revoked');
		expect(r.audits.at(-1)?.input.action).toBe('billing.entitlement.revoked');
	});

	it('stores the status of an incomplete or paused subscription and keeps the plan and state', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ status: 'incomplete' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'incomplete',
			planId: 'managed-free',
			entitlementState: 'pending'
		});
		await handle(r.services, 'customer.subscription.updated', subscription());
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ status: 'paused' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'paused',
			planId: 'managed-pro',
			entitlementState: 'activated'
		});
	});

	it('blocks an entitlement with single sign-on until sso.built is true', async () => {
		const r = await linked();
		const sub = subscription({ plans: ['institution-standard'], interval: 'year' });
		await handle(r.services, 'customer.subscription.created', sub);
		const blocked = r.store.accounts.get('org-1');
		expect(blocked).toMatchObject({
			planId: 'institution-standard',
			entitlementState: 'blocked'
		});
		expect(entitlementOf(blocked ?? null).planId).toBe('managed-free');
		const on = rig({ flags: { ssoBuilt: { oidc: true, saml: true }, overageEnabled: false } });
		await handle(on.services, 'checkout.session.completed', checkoutCompleted());
		await handle(on.services, 'customer.subscription.created', sub);
		expect(on.store.accounts.get('org-1')?.entitlementState).toBe('activated');
	});

	it('takes the assurance add-on on the standard plan only', async () => {
		const r = rig({ flags: { ssoBuilt: { oidc: true, saml: true }, overageEnabled: false } });
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({
				plans: ['institution-standard'],
				addOns: [{ id: 'assurance' }],
				interval: 'year'
			})
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			addOns: [{ id: 'assurance', quantity: 1 }]
		});
		expect(entitlementOf(r.store.accounts.get('org-1') ?? null).assurance).toBe(true);
		await expect(
			handle(
				r.services,
				'customer.subscription.updated',
				subscription({ plans: ['managed-pro'], addOns: [{ id: 'assurance' }] })
			)
		).rejects.toThrow(/add_on_not_offered/);
	});

	it('stores the quantity each add-on item carries and sums the entitlement from it', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ addOns: [{ id: 'extra-site', quantity: 4 }] })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-pro',
			addOns: [{ id: 'extra-site', quantity: 4 }],
			entitlementState: 'activated'
		});
		expect(entitlementOf(r.store.accounts.get('org-1') ?? null).sites).toBe(7);
	});

	it('keeps the current plan as the base of a subscription with add-ons alone', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ plans: [], addOns: [{ id: 'support-hours', quantity: 2 }] })
		);
		const account = r.store.accounts.get('org-1');
		expect(account).toMatchObject({
			planId: 'managed-free',
			addOns: [{ id: 'support-hours', quantity: 2 }],
			status: 'active',
			entitlementState: 'activated'
		});
		expect(entitlementOf(account ?? null).supportHoursPerYear).toBe(24);
	});

	it('takes the base from an account that already holds a paid plan', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: [], addOns: [{ id: 'support-hours' }] })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({ planId: 'managed-pro' });
	});

	it('reads an add-on only subscription for an organisation with no row as the free plan', async () => {
		const r = rig();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ plans: [], addOns: [{ id: 'support-hours' }], organizationId: 'org-7' })
		);
		expect(r.store.accounts.get('org-7')).toMatchObject({ planId: 'managed-free' });
	});

	it('refuses an add-on only subscription whose add-on the free plan cannot hold', async () => {
		const r = await linked();
		await expect(
			handle(
				r.services,
				'customer.subscription.created',
				subscription({ plans: [], addOns: [{ id: 'extra-site' }] })
			)
		).rejects.toThrow(/add_on_not_offered/);
		expect(r.store.accounts.get('org-1')?.addOns).toEqual([]);
	});

	it('revokes an add-on only subscription to the free plan with no add-ons when it ends', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ plans: [], addOns: [{ id: 'support-hours' }] })
		);
		await handle(
			r.services,
			'customer.subscription.deleted',
			subscription({ plans: [], addOns: [{ id: 'support-hours' }], status: 'canceled' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-free',
			addOns: [],
			entitlementState: 'revoked'
		});
	});

	it('ignores a subscription for a customer it cannot place, and links one that carries the organisation', async () => {
		const r = rig();
		expect(await handle(r.services, 'customer.subscription.created', subscription())).toBe(
			'ignored'
		);
		expect(r.logs[0]?.message).toBe('subscription for an unlinked customer');
		expect(r.store.accounts.size).toBe(0);
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ organizationId: 'org-5' })
		);
		expect(r.store.customers.get('cus_fixture')).toBe('org-5');
		expect(r.store.accounts.get('org-5')?.planId).toBe('managed-pro');
	});

	it('fails loudly on a price or plan it does not know, so the event stays open', async () => {
		const r = await linked();
		const unknown = subscription();
		unknown.items.data[0]!.price.lookup_key = 'someone_elses_price';
		await expect(handle(r.services, 'customer.subscription.created', unknown)).rejects.toThrow(
			/does not know/
		);
		const noKey = subscription();
		noKey.items.data[0]!.price.lookup_key = null as never;
		await expect(handle(r.services, 'customer.subscription.created', noKey)).rejects.toThrow(
			/does not know/
		);
		await expect(
			handle(
				r.services,
				'customer.subscription.created',
				subscription({ plans: ['managed-pro', 'managed-agency'] })
			)
		).rejects.toThrow(/exactly one base plan/);
		await expect(
			handle(
				r.services,
				'customer.subscription.created',
				subscription({ plans: [], addOns: [] })
			)
		).rejects.toThrow(/exactly one base plan/);
		await expect(
			handle(r.services, 'customer.subscription.created', { id: 'sub_x' })
		).rejects.toThrow();
		expect(r.store.accounts.get('org-1')?.planId).toBe('managed-free');
	});

	it('drops an event older than the last one applied', async () => {
		const r = await linked();
		const t = Math.floor(NOW / 1000);
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-agency'] }),
			{ created: t + 10 }
		);
		const outcome = await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-pro'] }),
			{ created: t + 5 }
		);
		expect(outcome).toBe('ignored');
		expect(r.store.accounts.get('org-1')?.planId).toBe('managed-agency');
		expect(r.logs.at(-1)?.message).toBe('stale subscription event');
	});
});

describe('invoice, charge and customer events', () => {
	const running = async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		return r;
	};
	const later = (s: number) => ({ created: Math.floor(NOW / 1000) + s });

	it('marks a failed payment past due, audits it, and clears it when the invoice is paid', async () => {
		const r = await running();
		await handle(
			r.services,
			'invoice.payment_failed',
			{ id: 'in_1', customer: 'cus_fixture' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'past_due',
			lastInvoiceId: 'in_1',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input.action).toBe('billing.payment.failed');
		await handle(r.services, 'invoice.paid', { id: 'in_1', customer: 'cus_fixture' }, later(2));
		expect(r.store.accounts.get('org-1')?.status).toBe('active');
	});

	it('records the finalized invoice without touching the status', async () => {
		const r = await running();
		await handle(
			r.services,
			'invoice.finalized',
			{ id: 'in_2', customer: 'cus_fixture' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			lastInvoiceId: 'in_2',
			status: 'active'
		});
	});

	it('ignores an invoice with no customer, an unknown customer, or an older timestamp', async () => {
		const r = await running();
		expect(await handle(r.services, 'invoice.paid', { id: 'in_3', customer: null })).toBe(
			'ignored'
		);
		expect(
			await handle(r.services, 'invoice.paid', { id: 'in_3', customer: 'cus_nobody' })
		).toBe('ignored');
		await handle(r.services, 'customer.subscription.updated', subscription(), later(20));
		expect(
			await handle(
				r.services,
				'invoice.payment_failed',
				{ id: 'in_4', customer: 'cus_fixture' },
				later(5)
			)
		).toBe('ignored');
		expect(r.store.accounts.get('org-1')?.status).toBe('active');
	});

	it('flags a refund for review and leaves the entitlement alone', async () => {
		const r = await running();
		await handle(
			r.services,
			'charge.refunded',
			{ id: 'ch_1', customer: 'cus_fixture', refunded: true },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			reviewReason: 'refunded',
			planId: 'managed-pro',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input.action).toBe('billing.refunded');
		expect(await handle(r.services, 'charge.refunded', { id: 'ch_2', customer: null })).toBe(
			'ignored'
		);
	});

	it('finds the customer of a dispute through the charge and flags the account', async () => {
		const r = await running();
		r.stripe.charges.set('ch_9', 'cus_fixture');
		await handle(
			r.services,
			'charge.dispute.created',
			{ id: 'dp_1', charge: 'ch_9' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			reviewReason: 'disputed',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input).toMatchObject({
			action: 'billing.disputed',
			detail: { disputeId: 'dp_1', chargeId: 'ch_9' }
		});
		expect(
			await handle(r.services, 'charge.dispute.created', { id: 'dp_2', charge: 'ch_none' })
		).toBe('ignored');
		const bare = rig({ stripe: null });
		expect(
			await handle(bare.services, 'charge.dispute.created', { id: 'dp_3', charge: 'ch_9' })
		).toBe('ignored');
	});

	it('copies the billing email from a customer update and ignores one without it', async () => {
		const r = await running();
		await handle(
			r.services,
			'customer.updated',
			{ id: 'cus_fixture', email: 'billing@example.test' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')?.billingEmail).toBe('billing@example.test');
		expect(
			await handle(
				r.services,
				'customer.updated',
				{ id: 'cus_fixture', email: null },
				later(2)
			)
		).toBe('handled');
		expect(r.store.accounts.get('org-1')?.billingEmail).toBeNull();
		expect(
			await handle(r.services, 'customer.updated', {
				id: 'cus_nobody',
				email: 'x@example.test'
			})
		).toBe('ignored');
		expect(
			await handle(r.services, 'customer.updated', {
				id: 'cus_fixture',
				email: 'old@example.test'
			})
		).toBe('ignored');
	});
});

describe('checkout and portal', () => {
	const request = {
		orgId: 'org-1',
		planId: 'managed-pro',
		interval: 'month',
		admin: true,
		principal: USER,
		idempotencyKey: 'idem-1'
	} as const;

	it('refuses an API key', async () => {
		const r = rig();
		await expectApiError(
			startCheckout(r.services, { ...request, principal: KEY }),
			'forbidden',
			{
				requires: 'session'
			}
		);
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: KEY }),
			'forbidden',
			{
				requires: 'session'
			}
		);
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: null }),
			'forbidden'
		);
		expect(r.stripe.calls).toEqual([]);
	});

	it('answers not_built without a Stripe client', async () => {
		const r = rig({ stripe: null });
		await expectApiError(startCheckout(r.services, request), 'not_built');
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: USER }),
			'not_built'
		);
	});

	it('hides an unreviewed price from a non-admin and never reaches Stripe', async () => {
		const r = rig();
		await expectApiError(startCheckout(r.services, { ...request, admin: false }), 'not_found');
		expect(r.stripe.calls).toEqual([]);
	});

	it('opens a checkout for an admin with the price key, the organisation and the idempotency key', async () => {
		const r = rig();
		await withDetails(r);
		expect(await startCheckout(r.services, request)).toEqual({
			url: 'https://checkout.example.test/cs_test_fake'
		});
		expect(r.stripe.calls).toEqual([
			{
				method: 'createCheckoutSession',
				input: {
					organizationId: 'org-1',
					priceLookupKey: 'drupflare_managed_pro_monthly',
					planLookupKey: 'drupflare_managed_pro',
					customerId: null,
					successUrl: 'https://app.example.test/billing?checkout=success',
					cancelUrl: 'https://app.example.test/billing?checkout=cancelled',
					idempotencyKey: 'idem-1'
				}
			}
		]);
	});

	it('refuses plans that cannot be bought online and plans that do not exist', async () => {
		const r = rig();
		await expectApiError(
			startCheckout(r.services, { ...request, planId: 'nope' }),
			'not_found'
		);
		for (const planId of [
			'institution-standard',
			'enterprise',
			'managed-free',
			'self-managed'
		]) {
			await expectApiError(
				startCheckout(r.services, { ...request, planId }),
				'unprocessable',
				{
					reason: 'not_self_serve'
				}
			);
		}
		await expectApiError(
			startCheckout(r.services, {
				...request,
				planId: 'institution-starter',
				interval: 'month'
			}),
			'unprocessable'
		);
	});

	it('refuses a second subscription and reuses a known customer', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await withDetails(r);
		await startCheckout(r.services, request);
		expect(r.stripe.calls[0]).toMatchObject({ input: { customerId: 'cus_fixture' } });
		await handle(r.services, 'customer.subscription.created', subscription());
		await expectApiError(startCheckout(r.services, request), 'conflict', {
			reason: 'already_subscribed'
		});
	});

	it('opens the portal for a known customer and answers not_found for an organisation without one', async () => {
		const r = rig();
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: USER }),
			'not_found',
			{
				reason: 'no_billing_account'
			}
		);
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		expect(await startPortal(r.services, { orgId: 'org-1', principal: USER })).toEqual({
			url: 'https://billing.example.test/session/fake'
		});
		expect(r.stripe.calls.at(-1)).toEqual({
			method: 'createPortalSession',
			input: { customerId: 'cus_fixture', returnUrl: 'https://app.example.test/billing' }
		});
	});
});

describe('plan list and admin check', () => {
	it('lists every plan with no price key for a non-admin', () => {
		const items = listPlans(false);
		expect(items).toHaveLength(PLANS.length);
		expect(JSON.stringify(items)).not.toMatch(/"(monthly|annual)"/);
	});

	it('gives an admin the prices', () => {
		const pro = listPlans(true).find((p) => p.id === 'managed-pro');
		const listed = PLANS.find((p) => p.id === 'managed-pro');
		expect(pro).toMatchObject({
			monthly: listed?.monthly.value,
			annual: listed?.annual.value,
			unreviewed: true
		});
	});

	it('treats only a platform admin with Access and billing support as an admin', () => {
		const base = facts({ ...member('owner'), ...fresh });
		expect(isBillingAdmin(null)).toBe(false);
		expect(isBillingAdmin(base)).toBe(false);
		const platform = (over: object) => ({
			...base,
			platform: {
				admin: true,
				access: true,
				permissions: ['billing_support'] as const,
				...over
			}
		});
		expect(isBillingAdmin(platform({}) as never)).toBe(true);
		expect(isBillingAdmin(platform({ admin: false }) as never)).toBe(false);
		expect(isBillingAdmin(platform({ access: false }) as never)).toBe(false);
		expect(isBillingAdmin(platform({ permissions: ['read'] }) as never)).toBe(false);
	});
});

describe('services and desired state', () => {
	it('answers not_built until services are installed', async () => {
		expect(() => billingServices()).toThrow(ApiError);
		const r = rig();
		setBillingServices(r.services);
		expect(billingServices()).toBe(r.services);
	});

	it('reads both flags as off unless they say true', () => {
		expect(billingFlags({})).toEqual({
			ssoBuilt: { oidc: true, saml: false },
			overageEnabled: false
		});
		expect(billingFlags({ SSO_SAML_BUILT: 'yes', BILLING_OVERAGE_ENABLED: '1' })).toEqual({
			ssoBuilt: { oidc: true, saml: false },
			overageEnabled: false
		});
		expect(billingFlags({ SSO_SAML_BUILT: 'true', BILLING_OVERAGE_ENABLED: 'true' })).toEqual({
			ssoBuilt: { oidc: true, saml: true },
			overageEnabled: true
		});
	});

	it('reads an organisation with no billing row as free and builds the desired state from the row', async () => {
		const r = rig();
		expect((await entitlementFor(r.services, 'org-x')).planId).toBe('managed-free');
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		const desired = await desiredFor(r.services, 'org-1', [{ siteId: 's1', createdAt: 1 }]);
		expect(desired).toMatchObject({ orgId: 'org-1', revision: 1, overage: null });
		expect(desired.entitlement?.planId).toBe('managed-pro');
	});

	it('refuses to read a row that holds a plan it cannot derive', () => {
		expect(() =>
			entitlementOf({
				planId: 'retired-plan',
				entitlementState: 'activated',
				addOns: []
			} as never)
		).toThrow(/unusable plan/);
	});
});

describe('billing details gate', () => {
	const request = {
		orgId: 'org-1',
		planId: 'managed-pro',
		interval: 'month',
		admin: true,
		principal: USER,
		idempotencyKey: 'idem-1'
	} as const;
	const later = (s: number) => ({ created: Math.floor(NOW / 1000) + s });

	const withCustomer = async (r = rig()) => {
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		return r;
	};

	it('refuses a checkout and an add-on purchase with no contact, naming what is missing', async () => {
		const r = await withCustomer();
		for (const attempt of [
			() => startCheckout(r.services, request),
			() =>
				startAddOnPurchase(r.services, {
					orgId: 'org-1',
					admin: true,
					principal: USER,
					idempotencyKey: 'idem-2',
					mode: 'pack',
					addOn: 'support-hours',
					units: 5
				})
		]) {
			await expectApiError(attempt(), 'unprocessable', {
				reason: 'billing_details_required',
				missing: ['name', 'email', 'country']
			});
		}
		expect(r.stripe.calls).toEqual([]);
	});

	it('refuses when the country is missing, and when the name or email is blank', async () => {
		const r = await withCustomer();
		await withDetails(r, 'org-1', { country: '' });
		await expectApiError(startCheckout(r.services, request), 'unprocessable', {
			missing: ['country']
		});
		await withDetails(r, 'org-1', { name: '  ', email: '' });
		await expectApiError(startCheckout(r.services, request), 'unprocessable', {
			missing: ['name', 'email']
		});
		expect(r.stripe.calls).toEqual([]);
	});

	it('opens the checkout once the contact and country are stored', async () => {
		const r = await withCustomer();
		await withDetails(r);
		expect(missingBillingDetails(r.store.accounts.get('org-1') ?? null)).toEqual([]);
		await startCheckout(r.services, request);
		expect(r.stripe.calls.map((call) => call.method)).toEqual(['createCheckoutSession']);
	});

	it('reads the stored copy and never a value in the request', async () => {
		const r = await withCustomer();
		const smuggled = { ...request, name: 'Eve', email: 'eve@example.test', country: 'US' };
		await expectApiError(startCheckout(r.services, smuggled), 'unprocessable', {
			reason: 'billing_details_required'
		});
	});

	it('puts what Checkout collected into the stored copy and keeps a value it left out', async () => {
		const r = rig();
		await handle(
			r.services,
			'checkout.session.completed',
			checkoutCompleted({
				details: { name: 'Grace Hopper', email: 'g@example.test', country: 'GB' }
			})
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			billingName: 'Grace Hopper',
			billingEmail: 'g@example.test',
			billingCountry: 'GB'
		});
		await handle(
			r.services,
			'checkout.session.completed',
			checkoutCompleted({ id: 'cs_2', details: { name: 'Grace H' } }),
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			billingName: 'Grace H',
			billingCountry: 'GB'
		});
	});

	it('follows customer.updated, so a removed address closes the gate again', async () => {
		const r = await withCustomer();
		await handle(
			r.services,
			'customer.updated',
			{
				id: 'cus_fixture',
				name: CONTACT.name,
				email: CONTACT.email,
				address: { country: CONTACT.country }
			},
			later(1)
		);
		await startCheckout(r.services, request);
		await handle(
			r.services,
			'customer.updated',
			{ id: 'cus_fixture', name: CONTACT.name, email: CONTACT.email, address: null },
			later(2)
		);
		expect(r.store.accounts.get('org-1')?.billingCountry).toBeNull();
		await expectApiError(startCheckout(r.services, request), 'unprocessable', {
			missing: ['country']
		});
	});

	it('saves the details, updates a known customer and audits the save', async () => {
		const r = await withCustomer();
		await saveBillingDetails(r.services, {
			orgId: 'org-1',
			principal: USER,
			name: ' Ada Owner ',
			email: 'ada@example.test',
			country: 'us'
		});
		expect(r.store.accounts.get('org-1')).toMatchObject({
			billingName: 'Ada Owner',
			billingEmail: 'ada@example.test',
			billingCountry: 'US'
		});
		expect(r.stripe.calls).toEqual([
			{
				method: 'updateCustomer',
				input: {
					customerId: 'cus_fixture',
					name: 'Ada Owner',
					email: 'ada@example.test',
					country: 'US'
				}
			}
		]);
		expect(r.audits.at(-1)?.input).toMatchObject({
			action: 'billing.details.saved',
			actor: 'user:user-1'
		});
	});

	it('creates the account for an organisation with none, and refuses bad values and an API key', async () => {
		const r = rig();
		const save = (over: object = {}) =>
			saveBillingDetails(r.services, {
				orgId: 'org-1',
				principal: USER,
				...CONTACT,
				...over
			});
		await save();
		expect(missingBillingDetails(r.store.accounts.get('org-1') ?? null)).toEqual([]);
		expect(r.stripe.calls).toEqual([]);
		for (const bad of [
			{ name: ' ' },
			{ email: 'nope' },
			{ country: 'USA' },
			{ country: '1A' }
		]) {
			await expectApiError(save(bad), 'unprocessable', { reason: 'bad_billing_details' });
		}
		await expectApiError(save({ principal: KEY }), 'forbidden', { requires: 'session' });
	});

	it('keeps the save from making a webhook that Stripe made just before it read as stale', async () => {
		const r = await withCustomer();
		await withDetails(r);
		const before = r.store.accounts.get('org-1')?.lastEventAt;
		await saveBillingDetails(r.services, {
			orgId: 'org-1',
			principal: USER,
			...CONTACT,
			country: 'CA'
		});
		expect(r.store.accounts.get('org-1')?.lastEventAt).toBe(before);
	});
});

describe('one subscription per organisation', () => {
	const planRequest = {
		orgId: 'org-1',
		planId: 'managed-pro',
		interval: 'month',
		admin: true,
		principal: USER,
		idempotencyKey: 'idem-1'
	} as const;
	const addOnRequest = {
		orgId: 'org-1',
		admin: true,
		principal: USER,
		idempotencyKey: 'idem-2',
		mode: 'subscription',
		addOn: 'support-hours',
		quantity: 1,
		interval: 'month'
	} as const;

	// a free plan holding a running subscription of add-ons alone
	async function addOnsOnly() {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ plans: [], addOns: [{ id: 'support-hours' }] })
		);
		await withDetails(r);
		return r;
	}

	it('sorts plans into free and paid by their price', () => {
		expect(isFreePlanId('managed-free')).toBe(true);
		expect(isFreePlanId('self-managed')).toBe(true);
		expect(isFreePlanId('managed-pro')).toBe(false);
		expect(isFreePlanId('nope')).toBe(false);
		expect(holdsPlanSubscription(null)).toBe(false);
	});

	it('lets a free org with no subscription open a plan checkout', async () => {
		const r = rig();
		await withDetails(r);
		expect(await startCheckout(r.services, planRequest)).toHaveProperty('url');
		expect(r.stripe.calls.map((call) => call.method)).toEqual(['createCheckoutSession']);
	});

	it('lets a free org with no subscription start an add-ons-only checkout', async () => {
		const r = rig();
		await withDetails(r);
		expect(await startAddOnPurchase(r.services, addOnRequest)).toHaveProperty('url');
	});

	it('records a free org holding add-ons alone as free, with one subscription', async () => {
		const r = await addOnsOnly();
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-free',
			subscriptionId: 'sub_fixture',
			addOns: [{ id: 'support-hours', quantity: 1 }]
		});
		expect(holdsPlanSubscription(r.store.accounts.get('org-1') ?? null)).toBe(false);
	});

	it('lets a free org with add-ons buy a plan, as an item on the one subscription', async () => {
		const r = await addOnsOnly();
		expect(await startCheckout(r.services, planRequest)).toEqual({ applied: true });
		expect(r.stripe.calls).toEqual([
			{
				method: 'setSubscriptionItem',
				input: {
					subscriptionId: 'sub_fixture',
					priceLookupKey: 'drupflare_managed_pro_monthly',
					quantity: 1,
					idempotencyKey: 'idem-1'
				}
			}
		]);
		// the subscription webhook that follows carries the plan and the add-ons together
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-pro'], addOns: [{ id: 'support-hours' }] }),
			{ created: Math.floor(NOW / 1000) + 5 }
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-pro',
			subscriptionId: 'sub_fixture',
			addOns: [{ id: 'support-hours', quantity: 1 }]
		});
	});

	it('refuses a plan on add-ons billed for the other interval', async () => {
		const r = await addOnsOnly();
		r.stripe.setSubscriptionItem = async () => {
			throw new IntervalMismatchError('month', 'year');
		};
		await expectApiError(
			startCheckout(r.services, { ...planRequest, interval: 'year' }),
			'unprocessable',
			{ reason: 'interval_mismatch' }
		);
	});

	it('lets a paid org buy an add-on on its subscription', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		await withDetails(r);
		expect(
			await startAddOnPurchase(r.services, { ...addOnRequest, addOn: 'mail-sends' })
		).toEqual({ applied: true });
		expect(r.stripe.calls.map((call) => call.method)).toEqual(['setSubscriptionItem']);
	});

	it('refuses a second plan for a paid org, with or without add-ons', async () => {
		for (const addOns of [[], [{ id: 'mail-sends' }]]) {
			const r = rig();
			await handle(r.services, 'checkout.session.completed', checkoutCompleted());
			await handle(r.services, 'customer.subscription.created', subscription({ addOns }));
			await withDetails(r);
			await expectApiError(startCheckout(r.services, planRequest), 'conflict', {
				reason: 'already_subscribed'
			});
			expect(r.stripe.calls).toEqual([]);
		}
	});
});

describe('checkout session lifecycle', () => {
	const unpaid = (over: object = {}) => checkoutCompleted({ paymentStatus: 'unpaid', ...over });
	const later = (s: number) => ({ created: Math.floor(NOW / 1000) + s });

	it('grants nothing for an unpaid session and records it as pending', async () => {
		const r = rig();
		expect(await handle(r.services, 'checkout.session.completed', unpaid())).toBe('handled');
		expect(r.store.pending.get('cs_fixture')).toEqual({
			organizationId: 'org-1',
			mode: 'subscription'
		});
		expect(r.store.accounts.size).toBe(0);
		expect(r.store.customers.size).toBe(0);
		expect(r.audits.map((a) => a.input.action)).toEqual(['billing.purchase.pending']);
	});

	it('activates a session that is paid or needs no payment', async () => {
		for (const paymentStatus of ['paid', 'no_payment_required']) {
			const r = rig();
			await handle(
				r.services,
				'checkout.session.completed',
				checkoutCompleted({ paymentStatus })
			);
			expect(r.store.accounts.get('org-1')?.subscriptionId).toBe('sub_fixture');
			expect(r.store.pending.size).toBe(0);
		}
	});

	it('credits a pack only when the async payment succeeds, and clears the pending purchase', async () => {
		const r = rig();
		const unsettled = packCheckoutCompleted({ paymentStatus: 'unpaid' });
		await handle(r.services, 'checkout.session.completed', unsettled);
		expect(r.store.credits.size).toBe(0);
		expect(r.store.pending.size).toBe(1);
		const outcome = await handle(
			r.services,
			'checkout.session.async_payment_succeeded',
			{ ...unsettled, payment_status: 'paid' },
			later(60)
		);
		expect(outcome).toBe('handled');
		expect([...r.store.credits.values()]).toMatchObject([
			{ organizationId: 'org-1', units: 5 }
		]);
		expect(r.store.pending.size).toBe(0);
	});

	it('activates a subscription session on async success', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', unpaid());
		await handle(
			r.services,
			'checkout.session.async_payment_succeeded',
			checkoutCompleted({ paymentStatus: 'paid' }),
			later(60)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			subscriptionId: 'sub_fixture',
			stripeCustomerId: 'cus_fixture'
		});
		expect(r.store.pending.size).toBe(0);
	});

	it('credits once when the same async success event arrives twice', async () => {
		const r = rig();
		const unsettled = packCheckoutCompleted({ paymentStatus: 'unpaid' });
		await handle(r.services, 'checkout.session.completed', unsettled);
		const body = event(
			'checkout.session.async_payment_succeeded',
			{ ...unsettled, payment_status: 'paid' },
			later(60)
		);
		const { raw, header } = await signed(body, NOW + 60_000);
		r.clock.now = NOW + 60_000;
		const first = await processWebhook(r.services, raw, header);
		const replay = await processWebhook(r.services, raw, header);
		expect(first.body).toMatchObject({ outcome: 'handled' });
		expect(replay.body).toEqual({ received: true, duplicate: true });
		expect(r.store.credits.size).toBe(1);
		expect([...r.store.credits.values()][0]?.units).toBe(5);
	});

	it('ignores an async success for a session that still reads as unpaid', async () => {
		const r = rig();
		expect(await handle(r.services, 'checkout.session.async_payment_succeeded', unpaid())).toBe(
			'ignored'
		);
		expect(r.store.pending.size).toBe(0);
		expect(r.store.credits.size).toBe(0);
	});

	it('clears the pending purchase on async failure, audits it and grants nothing', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', unpaid());
		expect(
			await handle(r.services, 'checkout.session.async_payment_failed', unpaid(), later(60))
		).toBe('handled');
		expect(r.store.pending.size).toBe(0);
		expect(r.store.accounts.size).toBe(0);
		expect(r.audits.at(-1)).toMatchObject({
			orgId: 'org-1',
			input: {
				action: 'billing.payment.failed',
				detail: { sessionId: 'cs_fixture', source: 'checkout' }
			}
		});
	});

	it('clears the pending purchase when the session expires, and ignores one that was never pending', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', unpaid());
		expect(await handle(r.services, 'checkout.session.expired', unpaid(), later(60))).toBe(
			'handled'
		);
		expect(r.store.pending.size).toBe(0);
		expect(await handle(r.services, 'checkout.session.expired', unpaid(), later(61))).toBe(
			'ignored'
		);
		expect(
			await handle(r.services, 'checkout.session.expired', unpaid({ org: null }), later(62))
		).toBe('ignored');
	});

	it('does not let one organisation clear another organisation pending purchase', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', unpaid());
		await handle(r.services, 'checkout.session.expired', unpaid({ org: 'org-2' }), later(60));
		expect(r.store.pending.size).toBe(1);
	});

	it('lists the session events it handles', () => {
		expect(HANDLED_EVENTS).toEqual(
			expect.arrayContaining([
				'checkout.session.completed',
				'checkout.session.async_payment_succeeded',
				'checkout.session.async_payment_failed',
				'checkout.session.expired'
			])
		);
	});
});
