import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeyView } from '~/shared/api-keys';
import { useApiKeysStore } from '~/stores/api-keys';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_personal';
const keysKey = `GET /api/v1/orgs/${ORG}/api-keys`;
const createKey = `POST /api/v1/orgs/${ORG}/api-keys`;
const revokeKey = (id: string) => `POST /api/v1/orgs/${ORG}/api-keys/${id}/revoke`;

const key = (id: string, over: Partial<KeyView> = {}): KeyView => ({
	id,
	name: `key ${id}`,
	prefix: `dfk_${id}`,
	scopes: ['org.read'],
	createdAt: '2026-11-01T10:00:00.000Z',
	lastUsedAt: null,
	expiresAt: '2027-02-01T10:00:00.000Z',
	revokedAt: null,
	...over
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useApiKeysStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('api keys store', () => {
	it('stays not loaded until the list is read', () => {
		expect(useApiKeysStore().lists.get(ORG)).toBeUndefined();
	});

	it('loads the first page once and keeps an empty list as loaded', async () => {
		cleanup = registerApi({ [keysKey]: { body: { items: [], nextCursor: null } } });
		const store = useApiKeysStore();
		await store.load(ORG);
		await store.load(ORG);
		expect(store.lists.get(ORG)).toEqual({
			items: [],
			nextCursor: null,
			status: 'ready',
			error: null
		});
		expect(calls).toHaveLength(1);
	});

	it('appends the next page and sends the cursor', async () => {
		cleanup = registerApi({
			[keysKey]: (call) =>
				call.query.cursor === undefined
					? { body: { items: [key('a')], nextCursor: 'next' } }
					: { body: { items: [key('b')], nextCursor: null } }
		});
		const store = useApiKeysStore();
		await store.load(ORG);
		await store.loadMore(ORG);
		await store.loadMore(ORG);
		expect(store.lists.get(ORG)?.items.map((item) => item.id)).toEqual(['a', 'b']);
		expect(calls.map((call) => call.query.cursor)).toEqual([undefined, 'next']);
	});

	it('keeps what it has and records the failure when a later page fails', async () => {
		cleanup = registerApi({
			[keysKey]: (call) =>
				call.query.cursor === undefined
					? { body: { items: [key('a')], nextCursor: 'next' } }
					: failure('internal', 'Failed', 'req_more')
		});
		const store = useApiKeysStore();
		await store.load(ORG);
		await store.loadMore(ORG);
		const list = store.lists.get(ORG);
		expect(list?.items).toHaveLength(1);
		expect(list?.status).toBe('error');
		expect(list?.error?.requestId).toBe('req_more');
	});

	it('records a failed first read, and a reload starts again', async () => {
		let reply: 'fail' | 'ok' = 'fail';
		cleanup = registerApi({
			[keysKey]: () =>
				reply === 'fail'
					? failure('internal', 'Failed', 'req_first')
					: { body: { items: [key('a')], nextCursor: null } }
		});
		const store = useApiKeysStore();
		await store.load(ORG);
		expect(store.lists.get(ORG)?.status).toBe('error');
		reply = 'ok';
		await store.reload(ORG);
		expect(store.lists.get(ORG)?.items).toHaveLength(1);
	});

	it('marks an unknown organization as known absent and does not ask again', async () => {
		cleanup = registerApi({
			[keysKey]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});
		const store = useApiKeysStore();
		await store.load(ORG);
		expect(store.lists.get(ORG)).toBeNull();
		await store.load(ORG);
		expect(calls).toHaveLength(1);
	});

	it('creates a key, sends the body, and keeps neither the token nor the key in the list', async () => {
		const made = { ...key('new'), token: 'dfk_aaaaaaaaaaaa_secret' };
		cleanup = registerApi({ [createKey]: { status: 201, body: made } });
		const store = useApiKeysStore();
		const body = { name: 'ci', scopes: ['org.read'], expiry: '30d' as const };
		await expect(store.create(ORG, body)).resolves.toEqual(made);
		expect(calls[0]?.body).toEqual(body);
		expect(JSON.stringify(store.$state)).not.toContain('secret');
		expect(store.lists.get(ORG)).toBeUndefined();
	});

	it('passes a refusal on to the caller', async () => {
		cleanup = registerApi({
			[createKey]: {
				status: 403,
				body: { code: 'forbidden', message: 'No', details: {}, requestId: 'req_1' }
			}
		});
		await expect(
			useApiKeysStore().create(ORG, { name: 'ci', scopes: ['org.read'], expiry: '30d' })
		).rejects.toMatchObject({ code: 'forbidden', status: 403 });
	});

	it('replaces the row with the revoked key', async () => {
		cleanup = registerApi({
			[keysKey]: { body: { items: [key('a'), key('b')], nextCursor: null } },
			[revokeKey('b')]: { body: key('b', { revokedAt: '2026-11-13T00:00:00.000Z' }) }
		});
		const store = useApiKeysStore();
		await store.load(ORG);
		await store.revoke(ORG, 'b');
		expect(store.lists.get(ORG)?.items.map((item) => item.revokedAt)).toEqual([
			null,
			'2026-11-13T00:00:00.000Z'
		]);
		expect(calls[1]?.body).toEqual({});
	});

	it('answers a revoke for a key that is not in the list', async () => {
		cleanup = registerApi({ [revokeKey('x')]: { body: key('x') } });
		await expect(useApiKeysStore().revoke(ORG, 'x')).resolves.toBeUndefined();
	});

	it('forgets every list on reset', async () => {
		cleanup = registerApi({ [keysKey]: { body: { items: [], nextCursor: null } } });
		const store = useApiKeysStore();
		await store.load(ORG);
		store.reset();
		expect(store.lists.size).toBe(0);
	});
});
