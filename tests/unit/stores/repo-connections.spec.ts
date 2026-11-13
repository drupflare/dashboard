import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRepoConnectionsStore } from '~/stores/repo-connections';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_personal';
const SITE = 'site_1';
const listKey = `GET /api/v1/orgs/${ORG}/repo-connections`;
const startKey = `POST /api/v1/orgs/${ORG}/repo-connections`;
const reposKey = (id: string) => `GET /api/v1/orgs/${ORG}/repo-connections/${id}/repositories`;
const revokeKey = (id: string) => `POST /api/v1/orgs/${ORG}/repo-connections/${id}/revoke`;
const remotesKey = `GET /api/v1/orgs/${ORG}/sites/${SITE}/remotes`;
const attachKey = `POST /api/v1/orgs/${ORG}/sites/${SITE}/remotes`;

const connection = (over: Record<string, unknown> = {}) => ({
	id: 'rc_1',
	provider: 'github',
	displayName: 'acme',
	scopes: [],
	state: 'active',
	createdAt: 1_700_000_000_000,
	...over
});

const remote = (over: Record<string, unknown> = {}) => ({
	id: 'sr_1',
	siteId: SITE,
	connectionId: 'rc_1',
	repo: 'acme/site',
	branch: 'main',
	mountPath: 'modules/custom/site',
	intervalMinutes: 60,
	lastPullStatus: null,
	lastPullAt: null,
	createdAt: 1_700_000_000_000,
	...over
});

const notFound = {
	status: 404,
	body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_404' }
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useRepoConnectionsStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('repo connections store', () => {
	it('loads the connections of an organization once and keeps them, revoked ones included', async () => {
		const items = [connection(), connection({ id: 'rc_2', state: 'revoked' })];
		cleanup = registerApi({ [listKey]: { body: { items } } });
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		await store.loadConnections(ORG);
		expect(store.connections.get(ORG)).toEqual(items);
		expect(
			calls.filter((call) => call.path === `/api/v1/orgs/${ORG}/repo-connections`)
		).toHaveLength(1);
	});

	it('keeps a known-empty list as loaded, not as missing', async () => {
		cleanup = registerApi({ [listKey]: { body: { items: [] } } });
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		expect(store.connections.get(ORG)).toEqual([]);
		expect(store.connectionsError).toBeNull();
	});

	it('records a missing organization as known absent and does not ask again', async () => {
		cleanup = registerApi({ [listKey]: notFound });
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		await store.loadConnections(ORG);
		expect(store.connections.get(ORG)).toBeNull();
		expect(store.connectionsError).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('keeps a failed list unloaded so the next call retries', async () => {
		cleanup = registerApi({ [listKey]: failure('internal', 'boom', 'req_1') });
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		expect(store.connections.get(ORG)).toBeUndefined();
		expect(store.connectionsError?.code).toBe('internal');
		cleanup();

		cleanup = registerApi({ [listKey]: { body: { items: [connection()] } } });
		await store.loadConnections(ORG);
		expect(store.connections.get(ORG)).toEqual([connection()]);
		expect(store.connectionsError).toBeNull();
	});

	it('fetches the list again after a reload', async () => {
		cleanup = registerApi({ [listKey]: { body: { items: [] } } });
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		cleanup();

		cleanup = registerApi({ [listKey]: { body: { items: [connection()] } } });
		await store.reloadConnections(ORG);
		expect(store.connections.get(ORG)).toEqual([connection()]);
	});

	it('starts a connection and returns the provider address to send the person to', async () => {
		cleanup = registerApi({
			[startKey]: {
				body: {
					kind: 'redirect',
					url: 'https://github.com/apps/drupflare/installations/new'
				}
			}
		});
		const store = useRepoConnectionsStore();
		const start = await store.startConnect(ORG, 'github');
		expect(start).toEqual({
			kind: 'redirect',
			url: 'https://github.com/apps/drupflare/installations/new'
		});
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ provider: 'github' });
	});

	it('loads the repositories of a connection once and throws a failure to the caller', async () => {
		cleanup = registerApi({
			[reposKey('rc_1')]: {
				body: { items: [{ fullName: 'acme/site', defaultBranch: 'main' }] }
			},
			[reposKey('rc_2')]: failure('internal', 'boom', 'req_2')
		});
		const store = useRepoConnectionsStore();
		const first = await store.loadRepositories(ORG, 'rc_1');
		const again = await store.loadRepositories(ORG, 'rc_1');
		expect(first).toEqual([{ fullName: 'acme/site', defaultBranch: 'main' }]);
		expect(again).toEqual(first);
		expect(calls.filter((call) => call.path.endsWith('/rc_1/repositories'))).toHaveLength(1);
		await expect(store.loadRepositories(ORG, 'rc_2')).rejects.toMatchObject({
			code: 'internal'
		});
		expect(store.repositories.has('rc_2')).toBe(false);
	});

	it('replaces a revoked connection in the cached list with the answer', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [connection()] } },
			[revokeKey('rc_1')]: { body: connection({ state: 'revoked' }) }
		});
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		await store.revoke(ORG, 'rc_1');
		expect(store.connections.get(ORG)?.[0]?.state).toBe('revoked');
	});

	it('leaves the cache alone when the revoke answer arrives for a list that was never loaded', async () => {
		cleanup = registerApi({ [revokeKey('rc_1')]: { body: connection({ state: 'revoked' }) } });
		const store = useRepoConnectionsStore();
		await store.revoke(ORG, 'rc_1');
		expect(store.connections.has(ORG)).toBe(false);
	});

	it('loads the remotes of a site and records a missing site as known absent', async () => {
		cleanup = registerApi({ [remotesKey]: { body: { items: [remote()] } } });
		const store = useRepoConnectionsStore();
		await store.loadRemotes(ORG, SITE);
		await store.loadRemotes(ORG, SITE);
		expect(store.remotes.get(SITE)).toEqual([remote()]);
		expect(calls.filter((call) => call.path.endsWith('/remotes'))).toHaveLength(1);
	});

	it('keeps a failed remote list unloaded with its error', async () => {
		cleanup = registerApi({ [remotesKey]: failure('internal', 'boom', 'req_3') });
		const store = useRepoConnectionsStore();
		await store.loadRemotes(ORG, SITE);
		expect(store.remotes.get(SITE)).toBeUndefined();
		expect(store.remotesError?.code).toBe('internal');
		cleanup();

		cleanup = registerApi({ [remotesKey]: notFound });
		await store.loadRemotes(ORG, SITE);
		expect(store.remotes.get(SITE)).toBeNull();
		expect(store.remotesError).toBeNull();
	});

	it('sends the attach input and adds the saved remote to a loaded list', async () => {
		cleanup = registerApi({
			[remotesKey]: { body: { items: [] } },
			[attachKey]: { status: 201, body: remote() }
		});
		const store = useRepoConnectionsStore();
		await store.loadRemotes(ORG, SITE);
		const input = {
			connectionId: 'rc_1',
			repo: 'acme/site',
			branch: 'main',
			mountPath: 'modules/custom/site',
			intervalMinutes: 60
		};
		const saved = await store.attachRemote(ORG, SITE, input);
		expect(saved).toEqual(remote());
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual(input);
		expect(store.remotes.get(SITE)).toEqual([remote()]);
	});

	it('returns the saved remote without touching a list that was never loaded', async () => {
		cleanup = registerApi({ [attachKey]: { status: 201, body: remote() } });
		const store = useRepoConnectionsStore();
		const saved = await store.attachRemote(ORG, SITE, {
			connectionId: 'rc_1',
			repo: 'acme/site',
			branch: 'main',
			mountPath: 'modules/custom/site'
		});
		expect(saved).toEqual(remote());
		expect(store.remotes.has(SITE)).toBe(false);
	});

	it('clears every cache and error on reset', async () => {
		cleanup = registerApi({
			[listKey]: failure('internal', 'boom', 'req_4'),
			[remotesKey]: failure('internal', 'boom', 'req_5')
		});
		const store = useRepoConnectionsStore();
		await store.loadConnections(ORG);
		await store.loadRemotes(ORG, SITE);
		store.reset();
		expect(store.connections.size).toBe(0);
		expect(store.connectionsError).toBeNull();
		expect(store.remotes.size).toBe(0);
		expect(store.remotesError).toBeNull();
	});
});
