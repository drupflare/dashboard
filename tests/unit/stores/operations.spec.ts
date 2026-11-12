import { afterEach, describe, expect, it } from 'vitest';
import { useOperationsStore } from '~/stores/operations';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	useOperationsStore().reset();
});

describe('operations store', () => {
	it('stores a loaded operation under its id', async () => {
		const operation = { id: 'op_1', status: 'running', steps: [] };
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_1': { body: operation }
		});

		const store = useOperationsStore();
		await expect(store.fetchOne('org_1', 'op_1')).resolves.toEqual(operation);
		expect(store.byId.get('op_1')).toEqual(operation);
	});

	it('records a 404 as known absent, not as an error', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_gone': {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});

		const store = useOperationsStore();
		await expect(store.fetchOne('org_1', 'op_gone')).resolves.toBeNull();
		expect(store.byId.get('op_gone')).toBeNull();
	});

	it('rethrows other failures and leaves the entry not loaded', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/operations/op_bad': failure('internal', 'Boom', 'req_2')
		});

		const store = useOperationsStore();
		await expect(store.fetchOne('org_1', 'op_bad')).rejects.toMatchObject({ status: 500 });
		expect(store.byId.has('op_bad')).toBe(false);
	});
});

describe('operations store retry', () => {
	const retryPath = 'POST /api/v1/orgs/org_1/operations/op_bad/retry';

	it('sends a key, caches the new operation and returns it', async () => {
		cleanup = registerApi({
			[retryPath]: {
				status: 202,
				body: { id: 'op_new', status: 'planned', type: 'site.create' }
			}
		});

		const store = useOperationsStore();
		await expect(store.retry('org_1', 'op_bad')).resolves.toMatchObject({ id: 'op_new' });
		expect(store.byId.get('op_new')).toMatchObject({ id: 'op_new' });
		const call = calls.find((entry) => entry.path.endsWith('/retry'));
		expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('throws the refusal with its reason and leaves the cache alone', async () => {
		cleanup = registerApi({
			[retryPath]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Only an operation that failed can be retried.',
					details: { reason: 'not_failed', status: 'running' },
					requestId: 'req_nf'
				}
			}
		});

		const store = useOperationsStore();
		await expect(store.retry('org_1', 'op_bad')).rejects.toMatchObject({
			status: 409,
			details: { reason: 'not_failed' }
		});
		expect(store.byId.has('op_bad')).toBe(false);
	});
});
