import type { Rung } from '../../../src/shared/health/vocab';

export const REPAIR_STATUSES = ['running', 'succeeded', 'failed', 'refused', 'undone'] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const LADDER_SCOPES = ['global', 'organization', 'site'] as const;
export type LadderScope = (typeof LADDER_SCOPES)[number];

// observations are stored as the JSON text they were written as
export interface RepairRecord {
	id: string;
	organizationId: string;
	siteId: string;
	repairId: string;
	rung: Rung;
	status: RepairStatus;
	observationBefore: string;
	observationAfter: string | null;
	operationId: string;
	undoOf: string | null;
	createdAt: number;
	finishedAt: number | null;
}

export interface RepairRow {
	id: string;
	organization_id: string;
	site_id: string;
	repair_id: string;
	rung: string;
	status: RepairStatus;
	observation_before: string;
	observation_after: string | null;
	operation_id: string;
	undo_of: string | null;
	created_at: number;
	finished_at: number | null;
}

export const REPAIR_COLUMNS = `id, organization_id, site_id, repair_id, rung, status,
	observation_before, observation_after, operation_id, undo_of, created_at, finished_at`;

export const toRepairRecord = (row: RepairRow): RepairRecord => ({
	id: row.id,
	organizationId: row.organization_id,
	siteId: row.site_id,
	repairId: row.repair_id,
	rung: row.rung as Rung,
	status: row.status,
	observationBefore: row.observation_before,
	observationAfter: row.observation_after,
	operationId: row.operation_id,
	undoOf: row.undo_of,
	createdAt: row.created_at,
	finishedAt: row.finished_at
});

export interface SwitchRow {
	scope: LadderScope;
	scope_id: string;
	auto: number;
}

export interface LadderSwitches {
	global: boolean | undefined;
	org?: boolean;
	site?: boolean;
}

// an unset level stays unset, so autoRepairOn can tell off from never asked
export function switchesOf(
	rows: readonly SwitchRow[],
	orgId: string,
	siteId: string
): LadderSwitches {
	const out: LadderSwitches = { global: undefined };
	for (const row of rows) {
		const on = row.auto === 1;
		if (row.scope === 'global') out.global = on;
		else if (row.scope === 'organization' && row.scope_id === orgId) out.org = on;
		else if (row.scope === 'site' && row.scope_id === siteId) out.site = on;
	}
	return out;
}

// the id is derived from the operation, so a step that runs twice writes one row
export const repairRecordId = (operationId: string) => `rpr_${operationId.replace(/^op_/, '')}`;
