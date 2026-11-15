import type { Operation } from '@contracts/operations';
import { z } from 'zod';
import { UNDO_HANDLES } from '../../../engine/src/repair/handles';
import { REPAIR_STATUSES, type RepairStatus } from '../../../engine/src/repair/rows';
import { ApiError } from '../../shared/errors';
import { CATALOGUE } from '../../shared/health/catalogue';
import { NOT_UNDOABLE, UNDO_UNAVAILABLE, repairWords } from '../../shared/health/repair-copy';
import { getRepair, listRepairs, type RepairRecord } from '../db/repos/repairs';
import { getReadySite } from '../db/repos/sites';
import { startSiteRepair } from './site-repair';
import type { SiteServices } from './sites';

export const repairViewSchema = z.strictObject({
	id: z.string(),
	title: z.string(),
	status: z.enum(REPAIR_STATUSES),
	statusText: z.string(),
	createdAt: z.string(),
	before: z.string(),
	after: z.string().nullable(),
	canUndo: z.boolean(),
	undoReason: z.string().nullable(),
	isUndo: z.boolean()
});
export type RepairView = z.infer<typeof repairViewSchema>;

const STATUS_TEXT: Record<RepairStatus, string> = {
	running: 'Running',
	succeeded: 'Fixed',
	failed: 'Not Fixed',
	refused: 'Not Run',
	undone: 'Undone'
};

const observationAfter = z.object({
	predicate: z.object({ cleared: z.boolean() }).optional(),
	escalated: z.boolean().optional()
});

// the words come from the catalogue row and the stored result; the JSON is read for two flags only
function afterWords(record: RepairRecord): string | null {
	if (record.observationAfter === null) return null;
	let parsed: z.infer<typeof observationAfter>;
	try {
		parsed = observationAfter.parse(JSON.parse(record.observationAfter));
	} catch {
		return null;
	}
	if (parsed.escalated)
		return 'The problem is still there. The repair stopped after repeated attempts.';
	if (parsed.predicate?.cleared === true) return 'Checked again. The problem is gone.';
	if (parsed.predicate?.cleared === false) return 'Checked again. The problem is still there.';
	return null;
}

function undoState(record: RepairRecord): { canUndo: boolean; undoReason: string | null } {
	if (record.undoOf !== null) return { canUndo: false, undoReason: NOT_UNDOABLE };
	if (record.status === 'undone')
		return { canUndo: false, undoReason: 'This repair was already undone.' };
	if (record.status !== 'succeeded') return { canUndo: false, undoReason: NOT_UNDOABLE };
	const row = CATALOGUE.get(record.repairId);
	if (row === undefined || !('handle' in row.undo))
		return { canUndo: false, undoReason: NOT_UNDOABLE };
	if (UNDO_HANDLES[row.undo.handle] === undefined)
		return { canUndo: false, undoReason: UNDO_UNAVAILABLE };
	return { canUndo: true, undoReason: null };
}

export function toRepairView(record: RepairRecord): RepairView {
	const words = repairWords(record.repairId);
	const undo = undoState(record);
	return {
		id: record.id,
		title: record.undoOf === null ? words.title : `Undo: ${words.title}`,
		status: record.status,
		statusText: STATUS_TEXT[record.status],
		createdAt: new Date(record.createdAt).toISOString(),
		before: words.found,
		after: afterWords(record),
		canUndo: undo.canUndo,
		undoReason: undo.undoReason,
		isUndo: record.undoOf !== null
	};
}

const notFound = () => new ApiError('not_found', 'Not found');

export async function listSiteRepairs(
	services: SiteServices,
	input: {
		orgId: string;
		siteId: string;
		after?: { createdAt: number; id: string };
		count: number;
	}
): Promise<RepairRecord[]> {
	const db = await services.getDb();
	if ((await getReadySite(db, input.orgId, input.siteId)) === null) throw notFound();
	return listRepairs(db, input.orgId, input.siteId, { after: input.after, count: input.count });
}

export async function undoSiteRepair(
	services: SiteServices,
	input: { orgId: string; siteId: string; repairId: string; idempotencyKey: string }
): Promise<Operation> {
	const db = await services.getDb();
	const record = await getRepair(db, input.orgId, input.repairId);
	if (record === null || record.siteId !== input.siteId) throw notFound();
	const undo = undoState(record);
	if (!undo.canUndo) {
		throw new ApiError('unprocessable', undo.undoReason ?? NOT_UNDOABLE, {
			reason: 'not_undoable'
		});
	}
	const { operation } = await startSiteRepair(services, {
		orgId: input.orgId,
		siteId: input.siteId,
		repairId: record.repairId,
		trigger: 'manual',
		rung: record.rung,
		undoOf: record.id,
		key: input.idempotencyKey
	});
	return operation;
}
