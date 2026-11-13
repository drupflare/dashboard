import { afterEach, describe, expect, it } from 'vitest';
import { useEstateStore } from '~/stores/estate';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

let cleanup: () => void = () => undefined;

const assessment = {
	id: 'asm_0123456789abcdefghijklmnop',
	operationId: 'op_1',
	state: 'running',
	rowCount: 2,
	rejectedTotal: 0,
	progress: {
		pending: 1,
		checking: 0,
		done: 1,
		'needs access': 0,
		'needs proof': 0,
		'could not check': 0,
		skipped: 0
	},
	classes: {
		ready: 1,
		'automatic upgrade': 0,
		'needs decision': 0,
		unsupported: 0,
		information: 0
	},
	report: null,
	createdAt: '2026-11-13T00:00:00.000Z',
	updatedAt: '2026-11-13T00:00:00.000Z'
};

afterEach(() => {
	cleanup();
	clearBrowserState();
	useEstateStore().reset();
});

describe('estate store assessment cache', () => {
	it('leaves an assessment not loaded until it is read', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}`]: { body: assessment }
		});

		const store = useEstateStore();
		expect(store.assessments.get(assessment.id)).toBeUndefined();
		await expect(store.read('org_1', assessment.id)).resolves.toEqual(assessment);
		expect(store.assessments.get(assessment.id)).toEqual(assessment);
	});

	it('records an assessment that does not exist as known absent', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}`]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_1' }
			}
		});

		const store = useEstateStore();
		await expect(store.read('org_1', assessment.id)).resolves.toBeNull();
		expect(store.assessments.get(assessment.id)).toBeNull();
	});

	it('rethrows a read that fails for another reason and caches nothing', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}`]: failure(
				'internal',
				'Something went wrong',
				'req_2'
			)
		});

		const store = useEstateStore();
		await expect(store.read('org_1', assessment.id)).rejects.toMatchObject({ status: 500 });
		expect(store.assessments.has(assessment.id)).toBe(false);
	});

	it('caches the view a cancel returns', async () => {
		const cancelled = { ...assessment, state: 'cancelled' };
		cleanup = registerApi({
			[`POST /api/v1/orgs/org_1/assessments/${assessment.id}/cancel`]: { body: cancelled }
		});

		const store = useEstateStore();
		await store.cancel('org_1', assessment.id);
		expect(store.assessments.get(assessment.id)?.state).toBe('cancelled');
	});

	it('clears the cache on reset', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}`]: { body: assessment }
		});

		const store = useEstateStore();
		await store.read('org_1', assessment.id);
		store.reset();
		expect(store.assessments.has(assessment.id)).toBe(false);
	});
});

describe('estate store listing and proof', () => {
	it('lists the assessments of the organisation and caches each one', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/assessments': {
				body: { items: [assessment], nextCursor: 'c1' }
			}
		});

		const store = useEstateStore();
		await expect(store.list('org_1')).resolves.toEqual({
			items: [assessment],
			nextCursor: 'c1'
		});
		expect(store.assessments.get(assessment.id)).toEqual(assessment);
	});

	it('sends the cursor of the next page to the list route', async () => {
		cleanup = registerApi({
			'GET /api/v1/orgs/org_1/assessments': { body: { items: [], nextCursor: null } }
		});

		await useEstateStore().list('org_1', 'c1');
		const call = calls.find((entry) => entry.path === '/api/v1/orgs/org_1/assessments');
		expect(call?.query).toEqual({ cursor: 'c1' });
	});

	it('posts the domain to the proof route and returns the record and file to publish', async () => {
		const proof = {
			domain: 'example.test',
			proven: false,
			record: {
				type: 'TXT',
				name: '_drupflare-estate.example.test',
				value: 'drupflare-estate=abc123'
			},
			file: { path: '/.well-known/drupflare-estate.txt', content: 'drupflare-estate=abc123' }
		};
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/assessments/proofs': { body: proof }
		});

		await expect(useEstateStore().startProof('org_1', 'shop.example.test')).resolves.toEqual(
			proof
		);
		const call = calls.find((entry) => entry.path === '/api/v1/orgs/org_1/assessments/proofs');
		expect(call?.body).toEqual({ domain: 'shop.example.test' });
	});

	it('posts the domain and the chosen method to the proof check route', async () => {
		const check = {
			domain: 'example.test',
			proven: true,
			method: 'http',
			detail: 'The file is in place.'
		};
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/assessments/proofs/check': { body: check }
		});

		await expect(
			useEstateStore().checkProof('org_1', 'shop.example.test', 'http')
		).resolves.toEqual(check);
		const call = calls.find(
			(entry) => entry.path === '/api/v1/orgs/org_1/assessments/proofs/check'
		);
		expect(call?.body).toEqual({ domain: 'shop.example.test', method: 'http' });
	});
});

describe('estate store requests', () => {
	it('sends the inventory text to the check route and returns the counts', async () => {
		const view = {
			fileError: null,
			rows: 2,
			sites: 1,
			notReconciled: 0,
			rejected: [{ line: 3, reason: 'missing hostname' }],
			rejectedTotal: 1,
			ignoredColumns: ['colour']
		};
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/assessments/check': { body: view }
		});

		await expect(useEstateStore().check('org_1', 'hostname\nexample.test')).resolves.toEqual(
			view
		);
		const call = calls.find((entry) => entry.path === '/api/v1/orgs/org_1/assessments/check');
		expect(call?.body).toEqual({ text: 'hostname\nexample.test' });
	});

	it('sends the Idempotency-Key header when it starts an assessment and caches the result', async () => {
		cleanup = registerApi({
			'POST /api/v1/orgs/org_1/assessments': { status: 202, body: assessment }
		});

		const store = useEstateStore();
		await store.start('org_1', { text: 'hostname\nexample.test' }, 'key-assess-1');
		const call = calls.find((entry) => entry.path === '/api/v1/orgs/org_1/assessments');
		expect(call?.headers['idempotency-key']).toBe('key-assess-1');
		expect(call?.body).toEqual({ text: 'hostname\nexample.test' });
		expect(store.assessments.get(assessment.id)).toEqual(assessment);
	});

	it('passes only the query values that are set to the rows route', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}/rows`]: {
				body: { items: [], nextCursor: null }
			}
		});

		await useEstateStore().readRows('org_1', assessment.id, { class: 'ready', q: '' });
		const call = calls.find((entry) => entry.path.endsWith('/rows'));
		expect(call?.query).toEqual({ class: 'ready' });
	});

	it('returns the CSV text from the export route', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/org_1/assessments/${assessment.id}/export`]: {
				body: 'hostname,class\nexample.test,ready\n'
			}
		});

		await expect(useEstateStore().exportCsv('org_1', assessment.id)).resolves.toBe(
			'hostname,class\nexample.test,ready\n'
		);
	});
});
