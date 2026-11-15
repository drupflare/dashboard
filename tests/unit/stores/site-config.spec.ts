import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientError } from '~/composables/useApi';
import { conflictOf, useSiteConfigStore, type SettingsView } from '~/stores/site-config';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const PATH = '/api/v1/orgs/org_1/sites/site_1/settings';

const view: SettingsView = {
	state: 'ready',
	source: 'live',
	stale: false,
	observedAt: '2026-11-07T12:00:00.000Z',
	reason: null,
	etag: null,
	groups: [{ id: 'runtime', label: 'Runtime', fields: [] }],
	redirects: []
};

let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	useSiteConfigStore().reset();
});

describe('site config store', () => {
	it('stores the settings under the site id and clears an earlier failure', async () => {
		let reply = failure('internal', 'Boom', 'req_0') as { status?: number; body: unknown };
		cleanup = registerApi({ [`GET ${PATH}`]: () => reply });
		const store = useSiteConfigStore();
		await expect(store.read('org_1', 'site_1')).rejects.toBeDefined();
		reply = { body: view };

		await expect(store.read('org_1', 'site_1')).resolves.toEqual(view);
		expect(store.bySite.get('site_1')).toEqual(view);
		expect(store.errors.has('site_1')).toBe(false);
		expect(calls.at(-1)?.path).toBe(PATH);
	});

	it('records a 404 as known absent', async () => {
		cleanup = registerApi({
			[`GET ${PATH}`]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});
		const store = useSiteConfigStore();

		await expect(store.read('org_1', 'site_1')).resolves.toBeNull();
		expect(store.bySite.get('site_1')).toBeNull();
	});
});

describe('site config store writes', () => {
	it('sends the etag and the changes with an Idempotency-Key and returns the operation', async () => {
		cleanup = registerApi({ [`PUT ${PATH}`]: { status: 202, body: { id: 'op_1' } } });
		const operation = await useSiteConfigStore().write(
			'org_1',
			'site_1',
			'"tag"',
			[{ key: 'SPOOL', value: '0' }],
			'key-1'
		);
		expect(operation).toEqual({ id: 'op_1' });
		expect(calls.at(-1)).toMatchObject({
			method: 'PUT',
			body: { etag: '"tag"', changes: [{ key: 'SPOOL', value: '0' }] }
		});
		expect(calls.at(-1)?.headers['idempotency-key']).toBe('key-1');
	});

	it('fails with the server message, and a conflict carries the current values', async () => {
		cleanup = registerApi({
			[`PUT ${PATH}`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'These settings changed on the site after you opened them.',
					details: { etag: '"new"', current: { SPOOL: '1' } },
					requestId: 'req_9'
				}
			}
		});
		const error = await useSiteConfigStore()
			.write('org_1', 'site_1', '"old"', [{ key: 'SPOOL', value: '0' }], 'key-2')
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiClientError);
		expect(conflictOf(error as ApiClientError)).toEqual({
			etag: '"new"',
			current: { SPOOL: '1' }
		});
	});

	it('reads a conflict only from a 409 that names the etag and the values', () => {
		const make = (status: number, details: unknown) =>
			new ApiClientError('conflict', 'x', status, details, null);
		expect(conflictOf(make(500, { etag: 'a', current: {} }))).toBeNull();
		expect(conflictOf(make(409, null))).toBeNull();
		expect(conflictOf(make(409, { etag: 'a' }))).toBeNull();
	});

	it('stores the history, records a 404 as absent and keeps a failure', async () => {
		let reply: { status?: number; body: unknown } = { body: { items: [{ id: 'cfg_1' }] } };
		cleanup = registerApi({ [`GET ${PATH}/history`]: () => reply });
		const store = useSiteConfigStore();
		await store.loadHistory('org_1', 'site_1');
		expect(store.history.get('site_1')).toEqual([{ id: 'cfg_1' }]);
		reply = { status: 404, body: { code: 'not_found', message: 'Not found', details: {} } };
		await store.loadHistory('org_1', 'site_1');
		expect(store.history.get('site_1')).toBeNull();
		reply = failure('internal', 'Boom', 'req_2') as typeof reply;
		await expect(store.loadHistory('org_1', 'site_1')).rejects.toBeDefined();
		expect(store.historyErrors.has('site_1')).toBe(true);
	});

	it('posts a revert with an Idempotency-Key, and asks for a fresh read when told to', async () => {
		cleanup = registerApi({
			[`POST ${PATH}/history/cfg_1/revert`]: { status: 202, body: { id: 'op_2' } },
			[`GET ${PATH}`]: { body: view }
		});
		const store = useSiteConfigStore();
		expect(await store.revert('org_1', 'site_1', 'cfg_1', 'key-3')).toEqual({ id: 'op_2' });
		expect(calls.at(-1)?.headers['idempotency-key']).toBe('key-3');
		await store.read('org_1', 'site_1', true);
		expect(calls.at(-1)?.query).toEqual({ fresh: '1' });
	});
});
