import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAdminLadderStore, type LadderRow } from '~/stores/admin-ladder';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const row = (overrides: Partial<LadderRow> = {}): LadderRow => ({
	repairId: 'bridge.asyncify_called',
	source: 'worker host tripwire',
	severity: 'critical',
	handle: '/recycle',
	automation: 'auto-with-guard',
	canRunToday: false,
	reason: 'No route on the site worker for this repair yet. It refuses to run.',
	...overrides
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('admin ladder store', () => {
	it('loads the catalogue rows and the switches together', async () => {
		cleanup = registerApi({
			'GET /api/v1/admin/ladder': {
				body: {
					rows: [row()],
					switches: [{ scope: 'global', scopeId: '', auto: false, updatedAt: 1 }]
				}
			}
		});
		const ladder = useAdminLadderStore();

		await ladder.load();

		expect(ladder.status).toBe('ready');
		expect(ladder.rows).toHaveLength(1);
		expect(ladder.rows[0]?.canRunToday).toBe(false);
		expect(ladder.switches).toEqual([
			{ scope: 'global', scopeId: '', auto: false, updatedAt: 1 }
		]);
	});

	it('keeps the failure when the catalogue cannot be read', async () => {
		cleanup = registerApi({
			'GET /api/v1/admin/ladder': failure('internal', 'failed', 'req_ld')
		});
		const ladder = useAdminLadderStore();

		await ladder.load();

		expect(ladder.status).toBe('error');
		expect(ladder.error?.requestId).toBe('req_ld');
	});

	it('sends the global confirmation with the switch and reloads', async () => {
		cleanup = registerApi({
			'PUT /api/v1/admin/ladder/switch': {
				body: { scope: 'global', scopeId: '', auto: false, updatedAt: 2 }
			},
			'GET /api/v1/admin/ladder': { body: { rows: [], switches: [] } }
		});
		await useAdminLadderStore().setSwitch('global', '', false, 'global');

		const put = calls.find((call) => call.method === 'PUT');
		expect(put?.body).toEqual({
			scope: 'global',
			scopeId: '',
			auto: false,
			confirmation: 'global'
		});
		expect(calls.at(-1)?.path).toBe('/api/v1/admin/ladder');
	});
});
