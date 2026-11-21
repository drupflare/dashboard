import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcurementBody, ProcurementView } from '~/shared/procurement';
import { useProcurementStore } from '~/stores/procurement';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_campus';
const OTHER = 'org_other';
const base = `/api/v1/orgs/${ORG}/procurement`;

const record: ProcurementView = {
	id: 'pr_1',
	kind: 'quote',
	reference: 'Q-1042',
	signatory: null,
	amount: '1200',
	issuedOn: '2026-03-02',
	dueOn: null,
	notes: null,
	createdAt: '2026-03-02T00:00:00.000Z',
	updatedAt: '2026-03-02T00:00:00.000Z'
};

const body: ProcurementBody = { kind: 'quote', reference: 'Q-1042', amount: '1200' };

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useProcurementStore().$reset();
});

afterEach(() => {
	cleanup();
});

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

describe('procurement store', () => {
	it('loads the records of one organisation once and keeps them under its id', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: [record] } } });
		const store = useProcurementStore();
		await store.load(ORG);
		await store.load(ORG);
		expect(count('GET', base)).toBe(1);
		expect(store.records.get(ORG)).toEqual([record]);
		expect(store.records.has(OTHER)).toBe(false);
	});

	it('keeps the error and no list when the records cannot be read', async () => {
		cleanup = registerApi({ [`GET ${base}`]: failure('internal', 'Something broke', 'req_1') });
		const store = useProcurementStore();
		await store.load(ORG);
		expect(store.error).not.toBeNull();
		expect(store.records.has(ORG)).toBe(false);
		expect(store.loading).toBe(false);
	});

	it('records a new document, then reads the list again', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: { status: 201, body: record },
			[`GET ${base}`]: { body: { items: [record] } }
		});
		expect(await useProcurementStore().save(ORG, null, body)).toBe(true);
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual(body);
		expect(count('GET', base)).toBe(1);
	});

	it('changes an existing document through its id', async () => {
		cleanup = registerApi({
			[`PUT ${base}/pr_1`]: { body: record },
			[`GET ${base}`]: { body: { items: [record] } }
		});
		expect(await useProcurementStore().save(ORG, 'pr_1', body)).toBe(true);
		expect(count('PUT', `${base}/pr_1`)).toBe(1);
	});

	it('keeps a refused save and does not read the list again', async () => {
		cleanup = registerApi({
			[`POST ${base}`]: {
				status: 400,
				body: {
					code: 'validation',
					message: 'Reference is required',
					details: {},
					requestId: 'req_2'
				}
			}
		});
		const store = useProcurementStore();
		expect(await store.save(ORG, null, { ...body, reference: '' })).toBe(false);
		expect(store.saveError?.message).toBe('Reference is required');
		expect(store.saving).toBe(false);
		expect(count('GET', base)).toBe(0);
	});
});
