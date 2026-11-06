import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore, type SiteSummary } from '~/stores/sites';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const site = (id: string, orgId: string): SiteSummary => ({
	id,
	orgId,
	name: `Site ${id}`,
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: null,
	hostnames: [],
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
});

const sitesPath = (orgId: string) => `GET /api/v1/orgs/${orgId}/sites`;

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('sites store', () => {
	it('loads the first page and caches each site by id', async () => {
		cleanup = registerApi({
			[sitesPath('org_a')]: { body: { items: [site('site_1', 'org_a')], nextCursor: null } }
		});
		const sites = useSitesStore();

		await sites.load('org_a');

		expect(sites.lists.get('org_a')).toMatchObject({ status: 'ready', ids: ['site_1'] });
		expect(sites.byId.get('site_1')?.name).toBe('Site site_1');
		expect(sites.forOrg('org_a').map((item) => item.id)).toEqual(['site_1']);
		expect(sites.forOrg('org_b')).toEqual([]);
	});

	it('appends the next page with its cursor', async () => {
		cleanup = registerApi({
			[sitesPath('org_a')]: ({ query }) =>
				query.cursor === 'next'
					? { body: { items: [site('site_2', 'org_a')], nextCursor: null } }
					: { body: { items: [site('site_1', 'org_a')], nextCursor: 'next' } }
		});
		const sites = useSitesStore();

		await sites.load('org_a');
		await sites.loadMore('org_a');

		expect(sites.lists.get('org_a')?.ids).toEqual(['site_1', 'site_2']);
		expect(sites.lists.get('org_a')?.nextCursor).toBeNull();
		expect(calls.at(-1)?.query).toEqual({ cursor: 'next' });
	});

	it('shows the error, then recovers on reload', async () => {
		let fail = true;
		cleanup = registerApi({
			[sitesPath('org_a')]: () =>
				fail
					? failure('internal', 'failed', 'req_s')
					: { body: { items: [site('site_1', 'org_a')], nextCursor: null } }
		});
		const sites = useSitesStore();

		await sites.load('org_a');
		expect(sites.lists.get('org_a')).toMatchObject({ status: 'error' });
		expect(sites.lists.get('org_a')?.error?.requestId).toBe('req_s');

		fail = false;
		await sites.reload('org_a');
		expect(sites.lists.get('org_a')).toMatchObject({ status: 'ready', ids: ['site_1'] });
	});

	it('does not request a list that is already loaded', async () => {
		cleanup = registerApi({
			[sitesPath('org_a')]: { body: { items: [], nextCursor: null } }
		});
		const sites = useSitesStore();

		await sites.load('org_a');
		await sites.load('org_a');

		expect(calls.filter((call) => call.path === '/api/v1/orgs/org_a/sites')).toHaveLength(1);
	});
});
