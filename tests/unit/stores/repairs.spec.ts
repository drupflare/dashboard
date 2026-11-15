import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRepairsStore, type RepairView } from '~/stores/repairs';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const repair = (id: string): RepairView => ({
	id,
	title: 'Blank Page Fixed',
	status: 'succeeded',
	statusText: 'Fixed',
	createdAt: '2026-11-01T12:00:00.000Z',
	before: 'Pages came back blank.',
	after: 'Checked again. The problem is gone.',
	canUndo: false,
	undoReason: null,
	isUndo: false
});

const listPath = '/api/v1/orgs/org_a/sites/site_1/repairs';

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useRepairsStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('repairs store', () => {
	it('loads the first page and appends the next one with its cursor', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: ({ query }) =>
				query.cursor === 'next'
					? { body: { items: [repair('rpr_2')], nextCursor: null } }
					: { body: { items: [repair('rpr_1')], nextCursor: 'next' } }
		});
		const repairs = useRepairsStore();

		await repairs.load('org_a', 'site_1');
		await repairs.loadMore('org_a', 'site_1');

		expect(repairs.listFor('org_a', 'site_1')).toMatchObject({
			status: 'ready',
			nextCursor: null
		});
		expect(repairs.listFor('org_a', 'site_1')?.items.map((item) => item.id)).toEqual([
			'rpr_1',
			'rpr_2'
		]);
		expect(calls.at(-1)?.query).toEqual({ cursor: 'next' });
	});

	it('reports an empty log as loaded with no items', async () => {
		cleanup = registerApi({ [`GET ${listPath}`]: { body: { items: [], nextCursor: null } } });
		const repairs = useRepairsStore();

		await repairs.load('org_a', 'site_1');

		expect(repairs.listFor('org_a', 'site_1')).toMatchObject({ status: 'ready', items: [] });
	});

	it('keeps the error with its request ID, then recovers on reload', async () => {
		let fail = true;
		cleanup = registerApi({
			[`GET ${listPath}`]: () =>
				fail
					? failure('internal', 'failed', 'req_rp')
					: { body: { items: [repair('rpr_1')], nextCursor: null } }
		});
		const repairs = useRepairsStore();

		await repairs.load('org_a', 'site_1');
		expect(repairs.listFor('org_a', 'site_1')).toMatchObject({ status: 'error' });
		expect(repairs.listFor('org_a', 'site_1')?.error?.requestId).toBe('req_rp');

		fail = false;
		await repairs.reload('org_a', 'site_1');
		expect(repairs.listFor('org_a', 'site_1')).toMatchObject({ status: 'ready' });
	});

	it('sends the undo with its Idempotency-Key header', async () => {
		cleanup = registerApi({
			[`POST ${listPath}/rpr_1/undo`]: {
				status: 202,
				body: { id: 'op_1', type: 'site.repair' }
			}
		});
		const operation = await useRepairsStore().undo('org_a', 'site_1', 'rpr_1', 'key-undo-1');

		expect(operation).toMatchObject({ id: 'op_1' });
		expect(calls.at(-1)?.headers['idempotency-key']).toBe('key-undo-1');
	});

	it('does not request a list that is already loaded', async () => {
		cleanup = registerApi({ [`GET ${listPath}`]: { body: { items: [], nextCursor: null } } });
		const repairs = useRepairsStore();

		await repairs.load('org_a', 'site_1');
		await repairs.load('org_a', 'site_1');

		expect(calls.filter((call) => call.path === listPath)).toHaveLength(1);
	});
});
