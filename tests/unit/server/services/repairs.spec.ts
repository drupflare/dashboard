import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import type { RepairRecord } from '../../../../src/server/db/repos/repairs';
import { toRepairView, undoSiteRepair } from '../../../../src/server/services/repairs';
import type { SiteServices } from '../../../../src/server/services/sites';
import { ApiError } from '../../../../src/shared/errors';
import { NOT_UNDOABLE, UNDO_UNAVAILABLE } from '../../../../src/shared/health/repair-copy';

const ORG = 'org_a';
const SITE = 'site_1';

function record(overrides: Partial<RepairRecord> = {}): RepairRecord {
	return {
		id: 'rpr_1',
		organizationId: ORG,
		siteId: SITE,
		repairId: 'render.empty',
		rung: 'observe',
		status: 'succeeded',
		observationBefore: JSON.stringify({ reading: 'empty' }),
		observationAfter: JSON.stringify({
			reading: 'ok',
			predicate: { id: 'render.nonempty', cleared: true }
		}),
		operationId: 'op_1',
		undoOf: null,
		createdAt: Date.parse('2026-11-01T12:00:00.000Z'),
		finishedAt: Date.parse('2026-11-01T12:01:00.000Z'),
		...overrides
	};
}

// the undo path reads one repair row and refuses before any start call
function servicesWith(row: RepairRecord | null): SiteServices {
	const db = {
		first: async () =>
			row === null
				? null
				: {
						id: row.id,
						organization_id: row.organizationId,
						site_id: row.siteId,
						repair_id: row.repairId,
						rung: row.rung,
						status: row.status,
						observation_before: row.observationBefore,
						observation_after: row.observationAfter,
						operation_id: row.operationId,
						undo_of: row.undoOf,
						created_at: row.createdAt,
						finished_at: row.finishedAt
					}
	} as unknown as CollegeDBClient;
	return { getDb: async () => db } as unknown as SiteServices;
}

describe('the owner view of a repair', () => {
	it('says what was seen and that the check cleared', () => {
		const view = toRepairView(record());
		expect(view.title).toBe('Blank Page Fixed');
		expect(view.statusText).toBe('Fixed');
		expect(view.before).toBe('Pages came back blank.');
		expect(view.after).toBe('Checked again. The problem is gone.');
		expect(view.canUndo).toBe(false);
		expect(view.undoReason).toBe(NOT_UNDOABLE);
	});

	it('a failed repair says the problem is still there when the check fails', () => {
		const view = toRepairView(
			record({
				status: 'failed',
				observationAfter: JSON.stringify({
					predicate: { id: 'render.nonempty', cleared: false }
				})
			})
		);
		expect(view.statusText).toBe('Not Fixed');
		expect(view.after).toBe('Checked again. The problem is still there.');
	});

	it('an escalated repair names the stop and not the raw flag', () => {
		const view = toRepairView(
			record({ status: 'failed', observationAfter: JSON.stringify({ escalated: true }) })
		);
		expect(view.after).toBe(
			'The problem is still there. The repair stopped after repeated attempts.'
		);
	});

	it('an undo row is titled as an undo and cannot be undone again', () => {
		const view = toRepairView(record({ undoOf: 'rpr_0', repairId: 'render.empty' }));
		expect(view.title).toBe('Undo: Blank Page Fixed');
		expect(view.isUndo).toBe(true);
		expect(view.canUndo).toBe(false);
	});

	it('a repair with no words of its own falls back to a generic line', () => {
		const view = toRepairView(record({ repairId: 'not.in.catalogue' }));
		expect(view.title).toBe('Automatic Repair');
	});

	it('an undone repair says so and is not offered again', () => {
		const view = toRepairView(record({ status: 'undone' }));
		expect(view.undoReason).toBe('This repair was already undone.');
	});
});

describe('undo refusals', () => {
	const refusal = async (row: RepairRecord | null) => {
		try {
			await undoSiteRepair(servicesWith(row), {
				orgId: ORG,
				siteId: SITE,
				repairId: 'rpr_1',
				idempotencyKey: 'key-1'
			});
		} catch (error) {
			return error;
		}
		return null;
	};

	it('refuses a repair that is not on this site as not found', async () => {
		const error = await refusal(record({ siteId: 'site_other' }));
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe('not_found');
	});

	it('refuses a repair the catalogue names no undo for, with the plain reason', async () => {
		const error = await refusal(record({ repairId: 'render.empty' }));
		expect((error as ApiError).message).toBe(NOT_UNDOABLE);
	});

	it('refuses a row whose undo has no route yet, with the plain reason', async () => {
		const error = await refusal(record({ repairId: 'overhead.updb-beat-snapshot' }));
		expect((error as ApiError).message).toBe(UNDO_UNAVAILABLE);
	});

	it('refuses an undo of an undo', async () => {
		const error = await refusal(record({ undoOf: 'rpr_0' }));
		expect((error as ApiError).message).toBe(NOT_UNDOABLE);
	});
});
