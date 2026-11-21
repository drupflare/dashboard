import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	type DecisionBody,
	type ObservationBody,
	type PilotBody,
	type PilotState,
	type PilotView
} from '../../shared/pilots';
import { listOrgSites } from '../db/repos/cost-centers';
import {
	getPilot,
	insertObservation,
	insertPilot,
	listObservations,
	listPilotSiteIds,
	listPilots,
	replacePilotSites,
	updatePilot,
	type ObservationRow,
	type PilotRow
} from '../db/repos/pilots';
import { siteUsage } from '../domain/cost-centers';
import { csvLines } from '../domain/csv';
import { buildPilotReport, reportCsvRows, type PilotReport } from '../domain/pilot-report';
import { type UsageReads } from './cost-centers';

// #region collaborators

export interface PilotServices {
	getDb: () => Promise<CollegeDBClient>;
	usage: UsageReads;
	newId: () => string;
	now: () => number;
}

let installed: PilotServices | null = null;

export function setPilotServices(services: PilotServices | null): void {
	installed = services;
}

export function pilotServices(): PilotServices {
	if (installed === null) throw new ApiError('not_built', 'Pilots are not available yet');
	return installed;
}

// #endregion

const HOUR_MS = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// a decided pilot is decided; one with sites is running; otherwise it is planned
function stateOf(decision: PilotRow['decision'], siteCount: number): PilotState {
	if (decision !== null) return 'decided';
	return siteCount > 0 ? 'running' : 'planned';
}

async function viewOf(db: CollegeDBClient, row: PilotRow): Promise<PilotView> {
	const siteIds = await listPilotSiteIds(db, row.organizationId, row.id);
	return {
		id: row.id,
		name: row.name,
		state: stateOf(row.decision, siteIds.length),
		startDate: row.startDate,
		sponsor: row.sponsor,
		technicalOwner: row.technicalOwner,
		baselineHostingSpendCents: row.baselineHostingSpendCents,
		baselineStaffHours: row.baselineStaffHours,
		baselineLatencyMs: row.baselineLatencyMs,
		baselineRestoreMinutes: row.baselineRestoreMinutes,
		baselineRollbackMinutes: row.baselineRollbackMinutes,
		baselinePatchDays: row.baselinePatchDays,
		successCriteria: row.successCriteria,
		decision: row.decision,
		decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
		continuationCostCents: row.continuationCostCents,
		siteIds,
		createdAt: iso(row.createdAt)
	};
}

async function loadOrThrow(db: CollegeDBClient, orgId: string, id: string): Promise<PilotRow> {
	const row = await getPilot(db, orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

export async function listPilotViews(deps: PilotServices, orgId: string): Promise<PilotView[]> {
	const db = await deps.getDb();
	return Promise.all((await listPilots(db, orgId)).map((row) => viewOf(db, row)));
}

export async function getPilotView(
	deps: PilotServices,
	orgId: string,
	id: string
): Promise<PilotView> {
	const db = await deps.getDb();
	return viewOf(db, await loadOrThrow(db, orgId, id));
}

function baselinesOf(body: Partial<PilotBody>) {
	return {
		baselineHostingSpendCents: body.baselineHostingSpendCents ?? null,
		baselineStaffHours: body.baselineStaffHours ?? null,
		baselineLatencyMs: body.baselineLatencyMs ?? null,
		baselineRestoreMinutes: body.baselineRestoreMinutes ?? null,
		baselineRollbackMinutes: body.baselineRollbackMinutes ?? null,
		baselinePatchDays: body.baselinePatchDays ?? null
	};
}

export async function createPilot(
	deps: PilotServices,
	orgId: string,
	body: PilotBody
): Promise<PilotView> {
	const db = await deps.getDb();
	const now = deps.now();
	const row: PilotRow = {
		id: `pil_${deps.newId()}`,
		organizationId: orgId,
		name: body.name,
		state: 'planned',
		startDate: body.startDate,
		sponsor: body.sponsor ?? null,
		technicalOwner: body.technicalOwner ?? null,
		...baselinesOf(body),
		successCriteria: body.successCriteria ?? '',
		decision: null,
		decidedAt: null,
		continuationCostCents: null,
		createdAt: now,
		updatedAt: now
	};
	await insertPilot(db, row);
	return viewOf(db, row);
}

// a patch only changes the fields it names; a missing baseline stays as it was
export async function editPilot(
	deps: PilotServices,
	orgId: string,
	id: string,
	patch: Partial<PilotBody>
): Promise<PilotView> {
	const db = await deps.getDb();
	const current = await loadOrThrow(db, orgId, id);
	const next: PilotRow = {
		...current,
		name: patch.name ?? current.name,
		startDate: patch.startDate ?? current.startDate,
		sponsor: patch.sponsor === undefined ? current.sponsor : patch.sponsor,
		technicalOwner:
			patch.technicalOwner === undefined ? current.technicalOwner : patch.technicalOwner,
		baselineHostingSpendCents:
			patch.baselineHostingSpendCents === undefined
				? current.baselineHostingSpendCents
				: patch.baselineHostingSpendCents,
		baselineStaffHours:
			patch.baselineStaffHours === undefined
				? current.baselineStaffHours
				: patch.baselineStaffHours,
		baselineLatencyMs:
			patch.baselineLatencyMs === undefined
				? current.baselineLatencyMs
				: patch.baselineLatencyMs,
		baselineRestoreMinutes:
			patch.baselineRestoreMinutes === undefined
				? current.baselineRestoreMinutes
				: patch.baselineRestoreMinutes,
		baselineRollbackMinutes:
			patch.baselineRollbackMinutes === undefined
				? current.baselineRollbackMinutes
				: patch.baselineRollbackMinutes,
		baselinePatchDays:
			patch.baselinePatchDays === undefined
				? current.baselinePatchDays
				: patch.baselinePatchDays,
		successCriteria: patch.successCriteria ?? current.successCriteria,
		updatedAt: deps.now()
	};
	if (current.decision !== null && patch.startDate !== undefined) {
		throw new ApiError('conflict', 'A decided pilot keeps its start date');
	}
	await updatePilot(db, next);
	return viewOf(db, next);
}

export async function setPilotSites(
	deps: PilotServices,
	orgId: string,
	id: string,
	siteIds: readonly string[]
): Promise<PilotView> {
	const db = await deps.getDb();
	const current = await loadOrThrow(db, orgId, id);
	const known = new Set((await listOrgSites(db, orgId)).map((site) => site.id));
	if (siteIds.some((siteId) => !known.has(siteId))) {
		throw new ApiError('validation', 'Choose sites from this organisation');
	}
	await replacePilotSites(db, orgId, id, [...new Set(siteIds)]);
	return viewOf(db, current);
}

export async function addObservation(
	deps: PilotServices,
	orgId: string,
	id: string,
	body: ObservationBody
): Promise<ObservationRow> {
	const db = await deps.getDb();
	await loadOrThrow(db, orgId, id);
	const row: ObservationRow = {
		id: `obs_${deps.newId()}`,
		organizationId: orgId,
		pilotId: id,
		at: body.at === undefined ? deps.now() : Date.parse(body.at),
		kind: body.kind,
		minutes: body.minutes ?? null,
		text: body.text
	};
	await insertObservation(db, row);
	return row;
}

export async function recordDecision(
	deps: PilotServices,
	orgId: string,
	id: string,
	body: DecisionBody
): Promise<PilotView> {
	const db = await deps.getDb();
	const current = await loadOrThrow(db, orgId, id);
	const next: PilotRow = {
		...current,
		decision: body.decision,
		decidedAt: deps.now(),
		continuationCostCents: body.continuationCostCents ?? null,
		updatedAt: deps.now()
	};
	await updatePilot(db, next);
	return viewOf(db, next);
}

// the report reads the pilot's own sites and observations; a missing cost figure is reported as not measured
export async function pilotReport(
	deps: PilotServices,
	orgId: string,
	id: string
): Promise<PilotReport> {
	const db = await deps.getDb();
	const view = await viewOf(db, await loadOrThrow(db, orgId, id));
	const observations = await listObservations(db, orgId, id);
	const names = new Map((await listOrgSites(db, orgId)).map((site) => [site.id, site.name]));
	const start = Date.parse(`${view.startDate}T00:00:00Z`);
	const end = Math.max(deps.now(), start + HOUR_MS);
	const bounds = { start, end, hours: Math.ceil((end - start) / HOUR_MS) };
	const usage = await deps.usage.intervals(orgId, view.siteIds, bounds);
	const sites = view.siteIds.map((siteId) => {
		const { views, state } = siteUsage(usage.get(siteId) ?? [], bounds);
		return { id: siteId, name: names.get(siteId) ?? siteId, views, state };
	});
	return buildPilotReport({
		pilot: view,
		sites,
		observations: observations.map((row) => ({
			id: row.id,
			at: iso(row.at),
			kind: row.kind,
			minutes: row.minutes,
			text: row.text
		}))
	});
}

export async function pilotReportCsv(
	deps: PilotServices,
	orgId: string,
	id: string
): Promise<string> {
	return csvLines(reportCsvRows(await pilotReport(deps, orgId, id)));
}
