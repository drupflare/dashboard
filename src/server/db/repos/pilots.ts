import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ObservationKind, PilotDecision, PilotState } from '../../../shared/pilots';
import { wasChanged } from '../collegedb';

export interface PilotRow {
	id: string;
	organizationId: string;
	name: string;
	state: PilotState;
	startDate: string;
	sponsor: string | null;
	technicalOwner: string | null;
	baselineHostingSpendCents: number | null;
	baselineStaffHours: number | null;
	baselineLatencyMs: number | null;
	baselineRestoreMinutes: number | null;
	baselineRollbackMinutes: number | null;
	baselinePatchDays: number | null;
	successCriteria: string;
	decision: PilotDecision | null;
	decidedAt: number | null;
	continuationCostCents: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ObservationRow {
	id: string;
	organizationId: string;
	pilotId: string;
	at: number;
	kind: ObservationKind;
	minutes: number | null;
	text: string;
}

interface PilotDb {
	id: string;
	organization_id: string;
	name: string;
	state: PilotState;
	start_date: string;
	sponsor: string | null;
	technical_owner: string | null;
	baseline_hosting_spend_cents: number | null;
	baseline_staff_hours: number | null;
	baseline_latency_ms: number | null;
	baseline_restore_minutes: number | null;
	baseline_rollback_minutes: number | null;
	baseline_patch_days: number | null;
	success_criteria: string;
	decision: PilotDecision | null;
	decided_at: number | null;
	continuation_cost_cents: number | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS = `id, organization_id, name, state, start_date, sponsor, technical_owner,
	baseline_hosting_spend_cents, baseline_staff_hours, baseline_latency_ms,
	baseline_restore_minutes, baseline_rollback_minutes, baseline_patch_days,
	success_criteria, decision, decided_at, continuation_cost_cents, created_at, updated_at`;

function toRow(row: PilotDb): PilotRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		name: row.name,
		state: row.state,
		startDate: row.start_date,
		sponsor: row.sponsor,
		technicalOwner: row.technical_owner,
		baselineHostingSpendCents: row.baseline_hosting_spend_cents,
		baselineStaffHours: row.baseline_staff_hours,
		baselineLatencyMs: row.baseline_latency_ms,
		baselineRestoreMinutes: row.baseline_restore_minutes,
		baselineRollbackMinutes: row.baseline_rollback_minutes,
		baselinePatchDays: row.baseline_patch_days,
		successCriteria: row.success_criteria,
		decision: row.decision,
		decidedAt: row.decided_at,
		continuationCostCents: row.continuation_cost_cents,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function listPilots(db: CollegeDBClient, organizationId: string): Promise<PilotRow[]> {
	const { results } = await db.all<PilotDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM pilots WHERE organization_id = ? ORDER BY created_at, id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getPilot(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<PilotRow | null> {
	const row = await db.first<PilotDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM pilots WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRow(row) : null;
}

export async function insertPilot(db: CollegeDBClient, row: PilotRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO pilots (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.organizationId,
			row.name,
			row.state,
			row.startDate,
			row.sponsor,
			row.technicalOwner,
			row.baselineHostingSpendCents,
			row.baselineStaffHours,
			row.baselineLatencyMs,
			row.baselineRestoreMinutes,
			row.baselineRollbackMinutes,
			row.baselinePatchDays,
			row.successCriteria,
			row.decision,
			row.decidedAt,
			row.continuationCostCents,
			row.createdAt,
			row.updatedAt
		]
	);
}

// every editable column is rewritten, so the service merges the patch onto the stored row first
export async function updatePilot(db: CollegeDBClient, row: PilotRow): Promise<boolean> {
	return wasChanged(
		await db.run(
			row.organizationId,
			`UPDATE pilots SET name = ?, state = ?, start_date = ?, sponsor = ?, technical_owner = ?,
				baseline_hosting_spend_cents = ?, baseline_staff_hours = ?, baseline_latency_ms = ?,
				baseline_restore_minutes = ?, baseline_rollback_minutes = ?, baseline_patch_days = ?,
				success_criteria = ?, decision = ?, decided_at = ?, continuation_cost_cents = ?,
				updated_at = ?
			 WHERE organization_id = ? AND id = ?`,
			[
				row.name,
				row.state,
				row.startDate,
				row.sponsor,
				row.technicalOwner,
				row.baselineHostingSpendCents,
				row.baselineStaffHours,
				row.baselineLatencyMs,
				row.baselineRestoreMinutes,
				row.baselineRollbackMinutes,
				row.baselinePatchDays,
				row.successCriteria,
				row.decision,
				row.decidedAt,
				row.continuationCostCents,
				row.updatedAt,
				row.organizationId,
				row.id
			]
		)
	);
}

export async function listPilotSiteIds(
	db: CollegeDBClient,
	organizationId: string,
	pilotId: string
): Promise<string[]> {
	const { results } = await db.all<{ site_id: string }>(
		organizationId,
		`SELECT site_id FROM pilot_sites WHERE organization_id = ? AND pilot_id = ? ORDER BY site_id`,
		[organizationId, pilotId]
	);
	return results.map((row) => row.site_id);
}

// the set is replaced whole; the caller has already checked every site belongs to the organisation
export async function replacePilotSites(
	db: CollegeDBClient,
	organizationId: string,
	pilotId: string,
	siteIds: readonly string[]
): Promise<void> {
	await db.run(
		organizationId,
		`DELETE FROM pilot_sites WHERE organization_id = ? AND pilot_id = ?`,
		[organizationId, pilotId]
	);
	for (const siteId of siteIds) {
		await db.run(
			organizationId,
			`INSERT INTO pilot_sites (pilot_id, organization_id, site_id) VALUES (?, ?, ?)`,
			[pilotId, organizationId, siteId]
		);
	}
}

export async function insertObservation(db: CollegeDBClient, row: ObservationRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO pilot_observations (id, organization_id, pilot_id, at, kind, minutes, text)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[row.id, row.organizationId, row.pilotId, row.at, row.kind, row.minutes, row.text]
	);
}

export async function listObservations(
	db: CollegeDBClient,
	organizationId: string,
	pilotId: string
): Promise<ObservationRow[]> {
	const { results } = await db.all<{
		id: string;
		organization_id: string;
		pilot_id: string;
		at: number;
		kind: ObservationKind;
		minutes: number | null;
		text: string;
	}>(
		organizationId,
		`SELECT id, organization_id, pilot_id, at, kind, minutes, text FROM pilot_observations
		 WHERE organization_id = ? AND pilot_id = ? ORDER BY at, id`,
		[organizationId, pilotId]
	);
	return results.map((row) => ({
		id: row.id,
		organizationId: row.organization_id,
		pilotId: row.pilot_id,
		at: row.at,
		kind: row.kind,
		minutes: row.minutes,
		text: row.text
	}));
}
