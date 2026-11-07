import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBackupsStore, type BackupView } from '~/stores/backups';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const backup = (id: string): BackupView => ({
	id,
	siteId: 'site_1',
	operationId: `op_${id}`,
	bytes: 2048,
	sha256: 'a'.repeat(64),
	parts: 1,
	restorable: true,
	notRestorableReason: null,
	verified: true,
	label: null,
	createdAt: '2026-11-01T12:00:00.000Z'
});

const listPath = '/api/v1/orgs/org_a/sites/site_1/backups';

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useBackupsStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('backups store', () => {
	it('loads the first page and appends the next one with its cursor', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: ({ query }) =>
				query.cursor === 'next'
					? { body: { items: [backup('bk_2')], nextCursor: null } }
					: { body: { items: [backup('bk_1')], nextCursor: 'next' } }
		});
		const backups = useBackupsStore();

		await backups.load('org_a', 'site_1');
		await backups.loadMore('org_a', 'site_1');

		expect(backups.listFor('org_a', 'site_1')).toMatchObject({
			status: 'ready',
			nextCursor: null
		});
		expect(backups.listFor('org_a', 'site_1')?.items.map((item) => item.id)).toEqual([
			'bk_1',
			'bk_2'
		]);
		expect(calls.at(-1)?.query).toEqual({ cursor: 'next' });
	});

	it('keeps the error with its request ID, then recovers on reload', async () => {
		let fail = true;
		cleanup = registerApi({
			[`GET ${listPath}`]: () =>
				fail
					? failure('internal', 'failed', 'req_bk')
					: { body: { items: [backup('bk_1')], nextCursor: null } }
		});
		const backups = useBackupsStore();

		await backups.load('org_a', 'site_1');
		expect(backups.listFor('org_a', 'site_1')).toMatchObject({ status: 'error' });
		expect(backups.listFor('org_a', 'site_1')?.error?.requestId).toBe('req_bk');

		fail = false;
		await backups.reload('org_a', 'site_1');
		expect(backups.listFor('org_a', 'site_1')).toMatchObject({ status: 'ready' });
	});

	it('does not request a list that is already loaded', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [], nextCursor: null } }
		});
		const backups = useBackupsStore();

		await backups.load('org_a', 'site_1');
		await backups.load('org_a', 'site_1');

		expect(calls.filter((call) => call.path === listPath)).toHaveLength(1);
	});
});
