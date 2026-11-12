import { beforeEach, describe, expect, it } from 'vitest';
import { useBillingStore } from '~/stores/billing';
import { calls, clearBrowserState, registerApi } from './store-support';

const ORG = 'org_personal';
const plansKey = 'GET /api/v1/billing/plans';
const entitlementKey = `GET /api/v1/orgs/${ORG}/entitlement`;
const checkoutKey = `POST /api/v1/billing/${ORG}/checkout`;
const portalKey = `POST /api/v1/billing/${ORG}/portal`;

const plan = {
	id: 'managed-site',
	name: 'Managed Site',
	kind: 'managed',
	lookupKey: 'k',
	sites: 1,
	views: 500000,
	support: 'Core',
	disabled: false
};
const entitlement = {
	planId: 'managed-site',
	addOns: [],
	sites: 1,
	views: 500000,
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

	it('posts the plan and interval to checkout and returns the hosted URL', async () => {
		cleanup = registerApi({
			[checkoutKey]: { body: { url: 'https://checkout.example.test/s' } }
		});
		const result = await useBillingStore().checkout(ORG, 'managed-site', 'year');
		expect(result).toEqual({ url: 'https://checkout.example.test/s' });
		expect(calls[0]?.body).toEqual({ plan: 'managed-site', interval: 'year' });
		cleanup();
	});

	it('posts to the portal and returns the hosted URL', async () => {
		cleanup = registerApi({ [portalKey]: { body: { url: 'https://portal.example.test/p' } } });
		const result = await useBillingStore().portal(ORG);
		expect(result).toEqual({ url: 'https://portal.example.test/p' });
		expect(calls[0]?.path).toBe(`/api/v1/billing/${ORG}/portal`);
		cleanup();
	});

	it('reset returns every cache to not loaded', async () => {
		cleanup = registerApi({
			[plansKey]: { body: { items: [plan] } },
			[entitlementKey]: { body: entitlement }
		});
		const store = useBillingStore();
		await store.loadPlans();
		await store.loadEntitlement(ORG);
		store.reset();
		expect(store.plans).toBeUndefined();
		expect(store.entitlements.size).toBe(0);
		cleanup();
	});
});
