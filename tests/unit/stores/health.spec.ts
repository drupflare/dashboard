import { afterEach, describe, expect, it } from 'vitest';
import { useHealthStore, type SiteHealth } from '~/stores/health';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const PATH = '/api/v1/orgs/org_1/sites/site_1/health';

const healthy: SiteHealth = {
	status: 'healthy',
	level: 'ok',
	reachable: true,
	reason: null,
	step: null,
	nodes: [],
	readiness: { level: 'live', missing: ['admin access verified'], checks: [] },
	observedAt: '2026-11-07T12:00:00.000Z'
};

let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	useHealthStore().reset();
});

describe('health store', () => {
	it('stores a read under the site id and clears an earlier failure', async () => {
		let reply = failure('internal', 'Boom', 'req_0') as { status?: number; body: unknown };
		cleanup = registerApi({ [`GET ${PATH}`]: () => reply });
		const store = useHealthStore();
		await expect(store.fetchOne('org_1', 'site_1')).rejects.toBeDefined();
		reply = { body: healthy };

		await expect(store.fetchOne('org_1', 'site_1')).resolves.toEqual(healthy);
		expect(store.bySite.get('site_1')).toEqual(healthy);
		expect(store.errors.has('site_1')).toBe(false);
	});

	it('records a 404 as known absent', async () => {
		cleanup = registerApi({
			[`GET ${PATH}`]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});
		const store = useHealthStore();

		await expect(store.fetchOne('org_1', 'site_1')).resolves.toBeNull();
		expect(store.bySite.get('site_1')).toBeNull();
	});

	it('keeps the failure, and the last good read, when a later read fails', async () => {
		let reply = { body: healthy } as { status?: number; body: unknown };
		cleanup = registerApi({ [`GET ${PATH}`]: () => reply });
		const store = useHealthStore();
		await store.fetchOne('org_1', 'site_1');
		reply = failure('internal', 'Boom', 'req_2');

		await expect(store.fetchOne('org_1', 'site_1')).rejects.toMatchObject({ status: 500 });
		expect(store.errors.get('site_1')?.requestId).toBe('req_2');
		expect(store.bySite.get('site_1')).toEqual(healthy);
	});

	it('shares one request between callers that ask together', async () => {
		cleanup = registerApi({ [`GET ${PATH}`]: { body: healthy } });
		const store = useHealthStore();
		await Promise.all([
			store.fetchOne('org_1', 'site_1'),
			store.fetchOne('org_1', 'site_1'),
			store.load('org_1', 'site_1')
		]);

		expect(calls).toHaveLength(1);
	});

	it('load reads once and then leaves a loaded site alone', async () => {
		cleanup = registerApi({ [`GET ${PATH}`]: { body: healthy } });
		const store = useHealthStore();
		await store.load('org_1', 'site_1');
		await store.load('org_1', 'site_1');

		expect(calls).toHaveLength(1);
	});

	it('load swallows a failure and leaves it in errors', async () => {
		cleanup = registerApi({ [`GET ${PATH}`]: failure('internal', 'Boom', 'req_3') });
		const store = useHealthStore();

		await expect(store.load('org_1', 'site_1')).resolves.toBeUndefined();
		expect(store.errors.get('site_1')?.message).toBe('Boom');
		expect(store.bySite.has('site_1')).toBe(false);
	});
});
