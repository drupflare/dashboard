import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBudgetStore } from '~/stores/budget';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_1';
const orgPath = `/api/v1/orgs/${ORG}/budget`;
const sitePath = `/api/v1/orgs/${ORG}/sites/site_1/budget`;

const view = (overrides: Record<string, unknown> = {}) => ({
	status: 'ok',
	scope: 'org',
	siteId: null,
	percent: 500,
	enforcement: 'block',
	ownerSet: true,
	allowanceViews: 1000000,
	dollars: { kind: 'unreviewed', reason: 'rate-unreviewed' },
	viewsLowerBound: 0,
	accounting: 'counted',
	state: 'ok',
	flags: [],
	alertsSent: [],
	enforcementFlag: 'on',
	appliesWithin: 'A stop takes effect within one lease interval.',
	...overrides
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useBudgetStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('budget store', () => {
	it('reads the organization budget once and keeps it', async () => {
		cleanup = registerApi({ [`GET ${orgPath}`]: { body: view() } });
		const store = useBudgetStore();
		await store.loadOrg(ORG);
		await store.loadOrg(ORG);
		expect(store.org.get(ORG)).toMatchObject({ status: 'ok', percent: 500 });
		expect(calls.filter((call) => call.path === orgPath)).toHaveLength(1);
	});

	it('records a known absent budget as null, not as an error', async () => {
		cleanup = registerApi({ [`GET ${orgPath}`]: { status: 404, body: { code: 'not_found' } } });
		const store = useBudgetStore();
		await store.loadOrg(ORG);
		expect(store.org.get(ORG)).toBeNull();
		expect(store.orgError.has(ORG)).toBe(false);
	});

	it('keeps a failed read as an error until the next read succeeds', async () => {
		cleanup = registerApi({
			[`GET ${orgPath}`]: failure('internal', 'Something broke', 'req_1')
		});
		const store = useBudgetStore();
		await store.loadOrg(ORG);
		expect(store.org.has(ORG)).toBe(false);
		expect(store.orgError.get(ORG)?.requestId).toBe('req_1');
	});

	it('writes a site budget and stores the reply', async () => {
		cleanup = registerApi({
			[`PUT ${sitePath}`]: {
				body: { ...view({ scope: 'site', siteId: 'site_1', percent: 300 }), changed: true }
			}
		});
		const store = useBudgetStore();
		const reply = await store.saveSite(ORG, 'site_1', { percent: 300, enforcement: 'alert' });
		expect(reply).toMatchObject({ changed: true, percent: 300 });
		expect(store.sites.get('site_1')).toMatchObject({ percent: 300 });
		expect(calls.at(-1)?.body).toEqual({ percent: 300, enforcement: 'alert' });
	});

	it('throws a failed save to the caller and leaves the stored reply alone', async () => {
		cleanup = registerApi({
			[`PUT ${orgPath}`]: failure('validation', 'Too high', 'req_2'),
			[`GET ${orgPath}`]: { body: view() }
		});
		const store = useBudgetStore();
		await store.loadOrg(ORG);
		await expect(store.saveOrg(ORG, { percent: 900, enforcement: 'block' })).rejects.toThrow();
		expect(store.org.get(ORG)).toMatchObject({ percent: 500 });
	});
});
