import { afterEach, describe, expect, it } from 'vitest';
import { useOperationsStore } from '~/stores/operations';
import { clearBrowserState, failure, registerApi } from './store-support';

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
