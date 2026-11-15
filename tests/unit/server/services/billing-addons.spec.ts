import { afterEach, describe, expect, it } from 'vitest';
import { IntervalMismatchError } from '../../../../src/server/integrations/stripe';
import { handleEvent, setBillingServices } from '../../../../src/server/services/billing';
import {
	creditsOf,
	setAddOnQuantity,
	startAddOnPurchase,
	type AddOnPurchase
} from '../../../../src/server/services/billing-addons';
import { ApiError } from '../../../../src/shared/errors';
import {
	checkoutCompleted,
	event,
	packCheckoutCompleted,
	rig,
	subscription,
	withDetails,
	type Rig
} from './billing-support';

const USER = { kind: 'user', userId: 'user-1' } as const;
const KEY = { kind: 'key', keyId: 'key-1', issuerId: 'user-1' } as const;
const CALLER = { orgId: 'org-1', admin: true, principal: USER, idempotencyKey: 'idem-1' } as const;

afterEach(() => setBillingServices(null));

const send = (r: Rig, type: string, object: unknown) =>
	handleEvent(r.services, event(type, object) as never);

// an organisation with a running subscription on managed-pro, holding the add-ons given
async function subscribed(addOns: { id: string; quantity?: number }[] = []) {
	const r = rig();
	await send(r, 'checkout.session.completed', checkoutCompleted());
	await send(r, 'customer.subscription.created', subscription({ addOns }));
	await withDetails(r);
	return r;
}

const buy = (r: Rig, purchase: AddOnPurchase, over: object = {}) =>
	startAddOnPurchase(r.services, { ...CALLER, ...purchase, ...over });

const monthly = (addOn: string, quantity = 1): AddOnPurchase => ({
	mode: 'subscription',
	addOn,
	quantity,
	interval: 'month'
});

const pack = (addOn: string, units: number): AddOnPurchase => ({ mode: 'pack', addOn, units });

async function refused(promise: Promise<unknown>, code: string, details?: object) {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	if (details) expect((error as ApiError).details).toMatchObject(details);
	return error as ApiError;
}

describe('startAddOnPurchase', () => {
	it('refuses an API key and no principal before it reaches Stripe', async () => {
		const r = rig();
		await refused(buy(r, monthly('support-hours'), { principal: KEY }), 'forbidden', {
			requires: 'session'
		});
		await refused(buy(r, pack('support-hours', 5), { principal: null }), 'forbidden');
		expect(r.stripe.calls).toEqual([]);
	});

	it('answers not_built without a Stripe client', async () => {
		const r = rig({ stripe: null });
		await refused(buy(r, monthly('support-hours')), 'not_built');
	});

	it('answers the same not_found for an unknown, a hidden and an unavailable add-on', async () => {
		const r = rig();
		const unknown = await refused(buy(r, monthly('nope')), 'not_found');
		const hidden = await refused(
			buy(r, monthly('support-hours'), { admin: false }),
			'not_found'
		);
		const packHidden = await refused(
			buy(r, pack('support-hours', 5), { admin: false }),
			'not_found'
		);
		const unavailable = await refused(buy(r, monthly('support-critical')), 'not_found');
		const domain = await refused(buy(r, pack('domain', 1)), 'not_found');
		for (const error of [hidden, packHidden, unavailable, domain]) {
			expect(error.message).toBe(unknown.message);
			expect(error.details).toEqual(unknown.details);
		}
		expect(r.stripe.calls).toEqual([]);
	});

	it('refuses an add-on the current plan does not offer', async () => {
		const free = rig();
		await refused(buy(free, monthly('extra-site')), 'unprocessable', {
			reason: 'add_on_not_offered'
		});
		await refused(buy(free, monthly('site-block-agency')), 'unprocessable', {
			reason: 'add_on_not_offered'
		});
		expect(free.stripe.calls).toEqual([]);
		const paid = await subscribed();
		await refused(buy(paid, monthly('support-core')), 'unprocessable', {
			reason: 'add_on_not_offered'
		});
		await refused(buy(paid, monthly('assurance')), 'unprocessable', {
			reason: 'add_on_not_offered'
		});
		expect(paid.stripe.calls).toEqual([]);
	});

	it('reads a blocked or revoked account as the free plan', async () => {
		const r = await subscribed();
		await send(r, 'customer.subscription.updated', subscription({ status: 'canceled' }));
		await refused(buy(r, monthly('extra-site')), 'unprocessable', {
			reason: 'add_on_not_offered'
		});
	});

	it('opens a subscription checkout with the quantity when the organisation has no subscription', async () => {
		const r = rig();
		await withDetails(r);
		expect(await buy(r, monthly('support-hours', 3))).toEqual({
			url: 'https://checkout.example.test/cs_test_fake'
		});
		expect(r.stripe.calls).toEqual([
			{
				method: 'createCheckoutSession',
				input: {
					organizationId: 'org-1',
					priceLookupKey: 'drupflare_addon_support_hours_monthly',
					planLookupKey: 'drupflare_addon_support_hours',
					customerId: null,
					successUrl: 'https://app.example.test/billing?checkout=success',
					cancelUrl: 'https://app.example.test/billing?checkout=cancelled',
					idempotencyKey: 'idem-1',
					mode: 'subscription',
					lines: [
						{ priceLookupKey: 'drupflare_addon_support_hours_monthly', quantity: 3 }
					]
				}
			}
		]);
		expect(r.store.accounts.get('org-1')?.subscriptionId).toBeNull();
	});

	it('refuses a yearly add-on on a monthly subscription instead of failing at Stripe', async () => {
		const r = await subscribed();
		r.stripe.setSubscriptionItem = async () => {
			throw new IntervalMismatchError('month', 'year');
		};
		await refused(
			buy(r, { ...monthly('mail-sends', 2), interval: 'year' } as AddOnPurchase),
			'unprocessable',
			{ reason: 'interval_mismatch' }
		);
	});

	it('uses the annual price for a yearly purchase and reuses a known customer', async () => {
		const r = rig();
		await send(r, 'checkout.session.completed', checkoutCompleted());
		await withDetails(r);
		await buy(r, { ...monthly('mail-sends', 2), interval: 'year' } as AddOnPurchase);
		expect(r.stripe.calls[0]).toMatchObject({
			input: {
				customerId: 'cus_fixture',
				priceLookupKey: 'drupflare_addon_mail_sends_annual',
				lines: [{ priceLookupKey: 'drupflare_addon_mail_sends_annual', quantity: 2 }]
			}
		});
	});

	it('lets a free plan buy support hours as an add-on only subscription', async () => {
		const r = rig();
		await withDetails(r);
		expect(await buy(r, monthly('support-hours'))).toHaveProperty('url');
		// the webhook that follows is what grants it
		await send(r, 'customer.subscription.created', {
			...subscription({
				plans: [],
				addOns: [{ id: 'support-hours' }],
				organizationId: 'org-1'
			})
		});
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-free',
			addOns: [{ id: 'support-hours', quantity: 1 }]
		});
	});

	it('changes the item on a running subscription and answers applied, writing no entitlement', async () => {
		const r = await subscribed();
		const before = structuredClone(r.store.accounts.get('org-1'));
		expect(await buy(r, monthly('extra-site', 2))).toEqual({ applied: true });
		expect(r.stripe.calls).toEqual([
			{
				method: 'setSubscriptionItem',
				input: {
					subscriptionId: 'sub_fixture',
					priceLookupKey: 'drupflare_addon_extra_site_monthly',
					quantity: 2,
					idempotencyKey: 'idem-1'
				}
			}
		]);
		expect(r.store.accounts.get('org-1')).toEqual(before);
	});

	it('opens a checkout, not an item change, when the subscription has ended', async () => {
		const r = await subscribed();
		await send(r, 'customer.subscription.updated', subscription({ status: 'canceled' }));
		await buy(r, monthly('support-hours'));
		expect(r.stripe.calls.map((call) => call.method)).toEqual(['createCheckoutSession']);
	});

	it.each([0, 101, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses a subscription quantity of %s',
		async (quantity) => {
			const r = rig();
			await refused(buy(r, monthly('support-hours', quantity)), 'unprocessable', {
				reason: 'bad_quantity'
			});
			expect(r.stripe.calls).toEqual([]);
		}
	);

	it('accepts the quantity limits 1 and 100', async () => {
		const r = rig();
		await withDetails(r);
		await buy(r, monthly('support-hours', 1));
		await buy(r, monthly('support-hours', 100));
		expect(r.stripe.calls).toHaveLength(2);
	});

	it('opens a one-time payment checkout for a pack size in the catalogue', async () => {
		const r = rig();
		await withDetails(r);
		expect(await buy(r, pack('support-hours', 5))).toEqual({
			url: 'https://checkout.example.test/cs_test_fake'
		});
		expect(r.stripe.calls).toEqual([
			{
				method: 'createCheckoutSession',
				input: {
					organizationId: 'org-1',
					priceLookupKey: 'drupflare_addon_support_hours_pack_5',
					planLookupKey: 'drupflare_addon_support_hours',
					customerId: null,
					successUrl: 'https://app.example.test/billing?checkout=success',
					cancelUrl: 'https://app.example.test/billing?checkout=cancelled',
					idempotencyKey: 'idem-1',
					mode: 'payment',
					lines: [{ priceLookupKey: 'drupflare_addon_support_hours_pack_5', quantity: 1 }]
				}
			}
		]);
		expect(r.store.accounts.get('org-1')?.subscriptionId).toBeNull();
		expect(r.store.credits.size).toBe(0);
	});

	it.each([0, 7, 5.5, -5, 21])(
		'refuses a pack size of %s that is not in the catalogue',
		async (units) => {
			const r = rig();
			await refused(buy(r, pack('support-hours', units)), 'unprocessable', {
				reason: 'bad_pack'
			});
			expect(r.stripe.calls).toEqual([]);
		}
	);

	it('refuses a pack of an add-on that sells none', async () => {
		const r = await subscribed();
		await refused(buy(r, pack('extra-site', 1)), 'unprocessable', { reason: 'bad_pack' });
		expect(r.stripe.calls).toEqual([]);
	});

	it('refuses a pack the current plan does not offer', async () => {
		const r = rig();
		const selfHosted = {
			...r.store,
			getAccount: async () => ({
				...(await r.store.ensureAccount('org-1', 1)),
				planId: 'self-hosted',
				entitlementState: 'activated'
			})
		};
		const s = { ...r.services, store: selfHosted };
		await refused(
			startAddOnPurchase(s, { ...CALLER, ...pack('container-hours', 1) }),
			'unprocessable',
			{ reason: 'add_on_not_offered' }
		);
	});
});

describe('setAddOnQuantity', () => {
	const set = (r: Rig, addOn: string, quantity: number, over: object = {}) =>
		setAddOnQuantity(r.services, {
			orgId: 'org-1',
			principal: USER,
			idempotencyKey: 'idem-2',
			addOn,
			quantity,
			...over
		});

	it('refuses an API key and answers not_built without Stripe', async () => {
		const r = await subscribed([{ id: 'extra-site' }]);
		await refused(set(r, 'extra-site', 1, { principal: KEY }), 'forbidden', {
			requires: 'session'
		});
		expect(r.stripe.calls).toEqual([]);
		await refused(set(rig({ stripe: null }), 'extra-site', 1), 'not_built');
	});

	it('sets the quantity of a held add-on and writes no entitlement', async () => {
		const r = await subscribed([{ id: 'extra-site', quantity: 2 }]);
		const before = structuredClone(r.store.accounts.get('org-1'));
		expect(await set(r, 'extra-site', 5)).toEqual({ applied: true });
		expect(r.stripe.calls).toEqual([
			{
				method: 'setSubscriptionItem',
				input: {
					subscriptionId: 'sub_fixture',
					priceLookupKey: 'drupflare_addon_extra_site_monthly',
					quantity: 5,
					idempotencyKey: 'idem-2'
				}
			}
		]);
		expect(r.store.accounts.get('org-1')).toEqual(before);
	});

	it('removes the add-on at quantity 0', async () => {
		const r = await subscribed([{ id: 'extra-site', quantity: 2 }]);
		expect(await set(r, 'extra-site', 0)).toEqual({ applied: true });
		expect(r.stripe.calls[0]).toMatchObject({ input: { quantity: 0 } });
		// the held list only changes when the subscription event arrives
		expect(r.store.accounts.get('org-1')?.addOns).toEqual([{ id: 'extra-site', quantity: 2 }]);
		await send(r, 'customer.subscription.updated', subscription());
		expect(r.store.accounts.get('org-1')?.addOns).toEqual([]);
	});

	it('answers not_found for an add-on the organisation does not hold, whatever the id is', async () => {
		const r = await subscribed([{ id: 'extra-site' }]);
		const error = await refused(set(r, 'support-hours', 1), 'not_found');
		for (const id of ['nope', 'support-critical', 'domain']) {
			const other = await refused(set(r, id, 1), 'not_found');
			expect(other.message).toBe(error.message);
		}
		await refused(set(rig(), 'extra-site', 1), 'not_found');
		expect(r.stripe.calls).toEqual([]);
	});

	it.each([-1, 101, 2.5, Number.NaN])('refuses a quantity of %s', async (quantity) => {
		const r = await subscribed([{ id: 'extra-site' }]);
		await refused(set(r, 'extra-site', quantity), 'unprocessable', { reason: 'bad_quantity' });
		expect(r.stripe.calls).toEqual([]);
	});

	it('refuses a change when no subscription is running', async () => {
		const r = await subscribed([{ id: 'extra-site' }]);
		await send(
			r,
			'customer.subscription.updated',
			subscription({ status: 'paused', addOns: [{ id: 'extra-site' }] })
		);
		expect(r.store.accounts.get('org-1')?.addOns).toHaveLength(1);
		await refused(set(r, 'extra-site', 2), 'unprocessable', { reason: 'no_subscription' });
		expect(r.stripe.calls).toEqual([]);
	});

	it('lets a held add-on that left sale be removed but not grown', async () => {
		const r = await subscribed();
		await r.store.applySubscription({
			organizationId: 'org-1',
			customerId: 'cus_fixture',
			subscriptionId: 'sub_fixture',
			planId: 'managed-pro',
			addOns: [{ id: 'support-critical', quantity: 1 }],
			status: 'active',
			entitlementState: 'activated',
			eventAt: Date.now() * 2,
			now: 1
		});
		await refused(set(r, 'support-critical', 2), 'unprocessable', { reason: 'not_available' });
		expect(await set(r, 'support-critical', 0)).toEqual({ applied: true });
		expect(r.stripe.calls).toHaveLength(1);
	});
});

describe('creditsOf', () => {
	it('reads an organisation as having none while billing is not installed', async () => {
		expect(await creditsOf('org-1')).toEqual({});
	});

	it('gives the units bought per meter and leaves zeros out', async () => {
		const r = rig();
		await send(r, 'checkout.session.completed', packCheckoutCompleted({ units: 5 }));
		setBillingServices(r.services);
		expect(await creditsOf('org-1')).toEqual({ 'support-hours': 5 });
		expect(await creditsOf('org-2')).toEqual({});
		const zeros = rig({
			store: { ...r.store, creditBalances: async () => ({ mail: 0, 'support-hours': 3 }) }
		});
		setBillingServices(zeros.services);
		expect(await creditsOf('org-1')).toEqual({ 'support-hours': 3 });
	});

	it('passes a store failure through instead of hiding it', async () => {
		const r = rig({
			store: {
				...rig().store,
				creditBalances: async () => {
					throw new Error('db down');
				}
			}
		});
		setBillingServices(r.services);
		await expect(creditsOf('org-1')).rejects.toThrow('db down');
	});
});
