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
	admin: { username: null, email: null, password: 'unknown' },
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

describe('sites store remove', () => {
	const deletePath = 'POST /api/v1/orgs/org_a/sites/site_1/delete';
	const started = {
		id: 'op_del1',
		type: 'site.delete',
		status: 'planned',
		targetIds: ['site_1']
	};

	it('sends the confirm text and the key, returns the operation and drops the cached list', async () => {
		cleanup = registerApi({
			[sitesPath('org_a')]: { body: { items: [site('site_1', 'org_a')], nextCursor: null } },
			[deletePath]: { status: 202, body: started }
		});
		const sites = useSitesStore();
		await sites.load('org_a');

		const operation = await sites.remove('org_a', 'site_1', 'Site site_1', 'key-delete-1');

		expect(operation).toMatchObject({ id: 'op_del1', type: 'site.delete' });
		const call = calls.find((entry) => entry.path.endsWith('/delete'));
		expect(call?.body).toEqual({ confirm: 'Site site_1' });
		expect(call?.headers['idempotency-key']).toBe('key-delete-1');
		expect(sites.lists.get('org_a')).toBeUndefined();
	});

	it('throws the server message and keeps the cached list when the delete is refused', async () => {
		cleanup = registerApi({
			[sitesPath('org_a')]: { body: { items: [site('site_1', 'org_a')], nextCursor: null } },
			[deletePath]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Another change to this site is still running',
					details: { reason: 'site_busy' },
					requestId: 'req_busy'
				}
			}
		});
		const sites = useSitesStore();
		await sites.load('org_a');

		await expect(
			sites.remove('org_a', 'site_1', 'Site site_1', 'key-delete-2')
		).rejects.toMatchObject({
			code: 'conflict',
			status: 409,
			message: 'Another change to this site is still running',
			requestId: 'req_busy'
		});
		expect(sites.lists.get('org_a')).toMatchObject({ status: 'ready', ids: ['site_1'] });
	});

	it('clears the session when the delete answers 401', async () => {
		useSessionStore().me = {
			id: 'usr_1',
			email: 'owner@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		};
		cleanup = registerApi({
			[deletePath]: {
				status: 401,
				body: {
					code: 'unauthenticated',
					message: 'Sign in',
					details: {},
					requestId: 'req_401'
				}
			}
		});

		await expect(
			useSitesStore().remove('org_a', 'site_1', 'Site site_1', 'key-delete-3')
		).rejects.toMatchObject({ status: 401 });
		expect(useSessionStore().me).toBeNull();
	});
});
