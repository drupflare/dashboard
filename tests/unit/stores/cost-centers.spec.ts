import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	AssignSiteBody,
	CostCenterBody,
	CostCenterView,
	CostSite
} from '~/shared/cost-centers';
import { useCostCentersStore } from '~/stores/cost-centers';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/cost-centers`;

const centers = [{ id: 'cc_1', name: 'Web' }] as CostCenterView[];
const sites = [{ id: 'site_1', name: 'Front door' }] as CostSite[];

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useCostCentersStore().$reset();
});

afterEach(() => {
	cleanup();
});

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

describe('cost centers store', () => {
	it('loads the centers once and reads them again only when forced', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: centers } } });
		const store = useCostCentersStore();
		await store.loadCenters(ORG);
		await store.loadCenters(ORG);
		expect(count('GET', base)).toBe(1);
		expect(store.centers.get(ORG)).toEqual(centers);
		await store.loadCenters(ORG, true);
		expect(count('GET', base)).toBe(2);
	});

	it('keeps the error and no list when the centers cannot be read', async () => {
		cleanup = registerApi({ [`GET ${base}`]: failure('internal', 'Something broke', 'req_1') });
		const store = useCostCentersStore();
		await store.loadCenters(ORG);
		expect(store.error).not.toBeNull();
		expect(store.centers.has(ORG)).toBe(false);
		expect(store.loading).toBe(false);
	});

	it('saves a new center, then reads the list again', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: { status: 201, body: { id: 'cc_2' } },
			[`GET ${base}`]: { body: { items: centers } }
		});
		const body = { name: 'Web' } as CostCenterBody;
		const store = useCostCentersStore();
		expect(await store.save(ORG, null, body)).toBe(true);
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual(body);
		expect(count('GET', base)).toBe(1);
		expect(store.saving).toBe(false);
	});

	it('edits an existing center through its id', async () => {
		cleanup = registerApi({
			[`PUT ${base}/cc_1`]: { body: { id: 'cc_1' } },
			[`GET ${base}`]: { body: { items: centers } }
		});
		expect(
			await useCostCentersStore().save(ORG, 'cc_1', { name: 'Web' } as CostCenterBody)
		).toBe(true);
		expect(count('PUT', `${base}/cc_1`)).toBe(1);
	});

	it('refuses a save, keeps the error, and does not read the list again', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: failure('validation', 'Name is required', 'req_2')
		});
		const store = useCostCentersStore();
		expect(await store.save(ORG, null, { name: '' } as CostCenterBody)).toBe(false);
		expect(store.saveError).not.toBeNull();
		expect(count('GET', base)).toBe(0);
	});

	it('sends the month and the amount with the report and reads it back by the same key', async () => {
		cleanup = registerApi({
			[`GET ${base}/report`]: (call) => ({ body: { month: call.query.month } })
		});
		const store = useCostCentersStore();
		await store.loadReport(ORG, '2026-03', 500);
		const report = calls.find((call) => call.path === `${base}/report`);
		expect(report?.query).toEqual({ month: '2026-03', amountCents: '500' });
		expect(store.reportOf(ORG, '2026-03', 500)).toEqual({ month: '2026-03' });
		expect(store.reportOf(ORG, '2026-03')).toBeUndefined();
	});

	it('stores a report that cannot be read as null', async () => {
		cleanup = registerApi({
			[`GET ${base}/report`]: failure('internal', 'Something broke', 'req_3')
		});
		const store = useCostCentersStore();
		expect(await store.loadReport(ORG, '2026-03')).toBeNull();
		expect(store.reportOf(ORG, '2026-03')).toBeNull();
	});

	it('assigns a site to a center and reads the site list again', async () => {
		cleanup = registerApi({
			[`PUT ${base}/sites/site_1`]: { body: { id: 'site_1' } },
			[`GET ${base}/sites`]: { body: { items: sites } }
		});
		const store = useCostCentersStore();
		const body = { costCenterId: 'cc_1' } as AssignSiteBody;
		expect(await store.assign(ORG, 'site_1', body)).toBe(true);
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual(body);
		expect(store.sites.get(ORG)).toEqual(sites);
	});
});
