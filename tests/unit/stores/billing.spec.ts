import { beforeEach, describe, expect, it } from 'vitest';
import { FREE_PLAN_IDS, useBillingStore, type PlanEntitlement } from '~/stores/billing';
import { calls, clearBrowserState, registerApi } from './store-support';

const ORG = 'org_personal';
const plansKey = 'GET /api/v1/billing/plans';
const addOnsKey = 'GET /api/v1/billing/add-ons';
const entitlementKey = `GET /api/v1/orgs/${ORG}/entitlement`;
const checkoutKey = `POST /api/v1/billing/${ORG}/checkout`;
const portalKey = `POST /api/v1/billing/${ORG}/portal`;
const addOnPostKey = `POST /api/v1/billing/${ORG}/add-ons`;
const addOnPutKey = `PUT /api/v1/billing/${ORG}/add-ons/extra-site`;

const plan = {
	id: 'managed-pro',
	name: 'Managed Pro',
	kind: 'managed',
	plane: 'managed',
	lookupKey: 'k',
	sites: 3,
	sitesUnlimited: false,
	views: 1000000,
	support: 'Core',
	supportHoursPerYear: 2,
	included: {},
	disabled: false
};
const addOn = {
	id: 'extra-site',
	name: 'Extra Site',
	meter: 'sites',
	lookupKey: 'drupflare_addon_extra_site',
	unit: '1 site above the plan',
	grants: 1,
	planes: ['managed'],
	requires: ['managed-pro'],
	subscription: true,
	packSizes: [],
	available: true,
	availableNote: null
};
const entitlement: PlanEntitlement = {
	planId: 'managed-pro',
	managedPlanId: 'managed-pro',
	plane: 'managed',
	addOns: [],
	sites: 3,
	views: 1000000,
	storageGb: 10,
	writes: 3000000,
	backupGb: 10,
	mailSends: 2000,
	containerHours: 5,
	invitees: 100,
	supportHoursPerYear: 2,
	support: 'core',
	billingAccount: true
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useBillingStore().$reset();
});

describe('billing store', () => {
	it('loads the plan list once and keeps it', async () => {
		cleanup = registerApi({ [plansKey]: { body: { items: [plan] } } });
		const store = useBillingStore();
		await store.loadPlans();
		await store.loadPlans();
		expect(store.plans).toEqual([plan]);
		expect(calls.filter((call) => call.path === '/api/v1/billing/plans')).toHaveLength(1);
		cleanup();
	});

	it('keeps the plan list unloaded after a failure so the next call retries', async () => {
		cleanup = registerApi({
			[plansKey]: {
				status: 500,
				body: { code: 'internal', message: 'boom', details: {}, requestId: 'req_1' }
			}
		});
		const store = useBillingStore();
		await store.loadPlans();
		expect(store.plans).toBeUndefined();
		expect(store.plansError?.code).toBe('internal');
		cleanup();

		cleanup = registerApi({ [plansKey]: { body: { items: [] } } });
		await store.loadPlans();
		expect(store.plans).toEqual([]);
		expect(store.plansError).toBeNull();
		cleanup();
	});

	it('loads the add-on list once and keeps it', async () => {
		cleanup = registerApi({ [addOnsKey]: { body: { items: [addOn] } } });
		const store = useBillingStore();
		await store.loadAddOns();
		await store.loadAddOns();
		expect(store.addOns).toEqual([addOn]);
		expect(calls.filter((call) => call.path === '/api/v1/billing/add-ons')).toHaveLength(1);
		cleanup();
	});

	it('keeps the add-on list unloaded after a failure so the next call retries', async () => {
		cleanup = registerApi({
			[addOnsKey]: {
				status: 500,
				body: { code: 'internal', message: 'boom', details: {}, requestId: 'req_4' }
			}
		});
		const store = useBillingStore();
		await store.loadAddOns();
		expect(store.addOns).toBeUndefined();
		expect(store.addOnsError?.requestId).toBe('req_4');
		cleanup();

		cleanup = registerApi({ [addOnsKey]: { body: { items: [] } } });
		await store.loadAddOns();
		expect(store.addOns).toEqual([]);
		expect(store.addOnsError).toBeNull();
		cleanup();
	});

	it('caches the plan for an organization', async () => {
		cleanup = registerApi({ [entitlementKey]: { body: entitlement } });
		const store = useBillingStore();
		await store.loadEntitlement(ORG);
		await store.loadEntitlement(ORG);
		expect(store.entitlements.get(ORG)).toEqual(entitlement);
		expect(calls).toHaveLength(1);
		cleanup();
	});

	it('records a missing plan record as known absent', async () => {
		cleanup = registerApi({
			[entitlementKey]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_2' }
			}
		});
		const store = useBillingStore();
		await store.loadEntitlement(ORG);
		expect(store.entitlements.get(ORG)).toBeNull();
		expect(store.entitlementError).toBeNull();
		cleanup();
	});

	it('keeps the organization unloaded and sets the error on a failed read', async () => {
		cleanup = registerApi({
			[entitlementKey]: {
				status: 500,
				body: { code: 'internal', message: 'boom', details: {}, requestId: 'req_3' }
			}
		});
		const store = useBillingStore();
		await store.loadEntitlement(ORG);
		expect(store.entitlements.has(ORG)).toBe(false);
		expect(store.entitlementError?.requestId).toBe('req_3');
		cleanup();
	});

	it('refreshes the plan and replaces the cached one', async () => {
		cleanup = registerApi({
			[entitlementKey]: () => ({
				body: { ...entitlement, addOns: [{ id: 'extra-site', quantity: 2 }], sites: 5 }
			})
		});
		const store = useBillingStore();
		store.entitlements.set(ORG, entitlement);
		await store.refreshEntitlement(ORG);
		expect(store.entitlements.get(ORG)).toMatchObject({ sites: 5 });
		cleanup();
	});

	it('keeps the cached plan and rethrows when a refresh fails', async () => {
		cleanup = registerApi({
			[entitlementKey]: {
				status: 500,
				body: { code: 'internal', message: 'boom', details: {}, requestId: 'req_5' }
			}
		});
		const store = useBillingStore();
		store.entitlements.set(ORG, entitlement);
		await expect(store.refreshEntitlement(ORG)).rejects.toMatchObject({ code: 'internal' });
		expect(store.entitlements.get(ORG)).toEqual(entitlement);
		cleanup();
	});

	it('posts the plan and interval to checkout and returns the hosted URL', async () => {
		cleanup = registerApi({
			[checkoutKey]: { body: { url: 'https://checkout.example.test/s' } }
		});
		const result = await useBillingStore().checkout(ORG, 'managed-pro', 'year');
		expect(result).toEqual({ url: 'https://checkout.example.test/s' });
		expect(calls[0]?.body).toEqual({ plan: 'managed-pro', interval: 'year' });
		cleanup();
	});

	it('reads an applied answer from checkout when the plan joins a running subscription', async () => {
		cleanup = registerApi({ [checkoutKey]: { body: { applied: true } } });
		expect(await useBillingStore().checkout(ORG, 'managed-pro', 'month')).toEqual({
			applied: true
		});
		cleanup();
	});

	it('puts the billing details', async () => {
		cleanup = registerApi({
			[`PUT /api/v1/billing/${ORG}/details`]: { body: { saved: true } }
		});
		const details = { name: 'Ada Owner', email: 'ada@example.test', country: 'US' };
		expect(await useBillingStore().saveDetails(ORG, details)).toEqual({ saved: true });
		expect(calls[0]).toMatchObject({
			method: 'PUT',
			path: `/api/v1/billing/${ORG}/details`,
			body: details
		});
		cleanup();
	});

	it('posts a subscription add-on and returns the hosted URL', async () => {
		cleanup = registerApi({
			[addOnPostKey]: { body: { url: 'https://checkout.example.test/a' } }
		});
		const purchase = {
			mode: 'subscription',
			addOn: 'extra-site',
			quantity: 2,
			interval: 'month'
		} as const;
		const result = await useBillingStore().buyAddOn(ORG, purchase);
		expect(result).toEqual({ url: 'https://checkout.example.test/a' });
		expect(calls[0]?.body).toEqual(purchase);
		cleanup();
	});

	it('posts a one-time pack and reads an applied answer', async () => {
		cleanup = registerApi({ [addOnPostKey]: { body: { applied: true } } });
		const purchase = { mode: 'pack', addOn: 'support-hours', units: 5 } as const;
		const result = await useBillingStore().buyAddOn(ORG, purchase);
		expect(result).toEqual({ applied: true });
		expect(calls[0]?.body).toEqual(purchase);
		cleanup();
	});

	it('puts a new quantity for an add-on the organization holds', async () => {
		cleanup = registerApi({ [addOnPutKey]: { body: { applied: true } } });
		const result = await useBillingStore().setAddOnQuantity(ORG, 'extra-site', 0);
		expect(result).toEqual({ applied: true });
		expect(calls[0]).toMatchObject({
			method: 'PUT',
			path: `/api/v1/billing/${ORG}/add-ons/extra-site`,
			body: { quantity: 0 }
		});
		cleanup();
	});

	it('posts to the portal and returns the hosted URL', async () => {
		cleanup = registerApi({ [portalKey]: { body: { url: 'https://portal.example.test/p' } } });
		const result = await useBillingStore().portal(ORG);
		expect(result).toEqual({ url: 'https://portal.example.test/p' });
		expect(calls[0]?.path).toBe(`/api/v1/billing/${ORG}/portal`);
		cleanup();
	});

	it('names the base plans that carry no price', () => {
		expect([...FREE_PLAN_IDS]).toEqual(['managed-free', 'self-managed', 'self-hosted']);
	});

	it('reset returns every cache to not loaded', async () => {
		cleanup = registerApi({
			[plansKey]: { body: { items: [plan] } },
			[addOnsKey]: { body: { items: [addOn] } },
			[entitlementKey]: { body: entitlement }
		});
		const store = useBillingStore();
		await store.loadPlans();
		await store.loadAddOns();
		await store.loadEntitlement(ORG);
		store.reset();
		expect(store.plans).toBeUndefined();
		expect(store.addOns).toBeUndefined();
		expect(store.entitlements.size).toBe(0);
		cleanup();
	});
});
