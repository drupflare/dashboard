import type { UsageInterval } from '@contracts/usage';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	type AccountingState,
	type AssignSiteBody,
	type CostCenterBody,
	type CostCenterView,
	type CostReport,
	type CostReportRow,
	type CostSite
} from '../../shared/cost-centers';
import { ApiError } from '../../shared/errors';
import { DuplicateRowError } from '../db/collegedb';
import {
	getCostCenter,
	insertCostCenter,
	listCostCenters,
	listOrgSites,
	setSiteAssignment,
	updateCostCenter,
	type CostCenterRow,
	type OrgSiteRow
} from '../db/repos/cost-centers';
import {
	allocate,
	elapsedHours,
	monthBounds,
	siteUsage,
	straightLine,
	worstState,
	type MonthBounds
} from '../domain/cost-centers';
import { csvLines } from '../domain/csv';
import { hoursStarted } from '../domain/usage-views';

// #region collaborators

// the usage intervals of each site for one month; the dashboard stores none yet, so the
// production reader answers nothing and every hour is reported unaccounted
export interface UsageReads {
	intervals(
		orgId: string,
		siteIds: readonly string[],
		bounds: MonthBounds
	): Promise<Map<string, UsageInterval[]>>;
}

export const noUsageReads: UsageReads = {
	intervals: async () => new Map()
};

export interface CostCenterServices {
	getDb: () => Promise<CollegeDBClient>;
	usage: UsageReads;
	newId: () => string;
	now: () => number;
}

let installed: CostCenterServices | null = null;

export function setCostCenterServices(services: CostCenterServices | null): void {
	installed = services;
}

export function costCenterServices(): CostCenterServices {
	if (installed === null) throw new ApiError('not_built', 'Cost centers are not available yet');
	return installed;
}

// #endregion

const iso = (ms: number) => new Date(ms).toISOString();

function viewOf(row: CostCenterRow): CostCenterView {
	return {
		id: row.id,
		code: row.code,
		name: row.name,
		departmentId: row.departmentId,
		ownerContact: row.ownerContact,
		createdAt: iso(row.createdAt)
	};
}

export async function listCostCenterViews(
	deps: CostCenterServices,
	orgId: string
): Promise<CostCenterView[]> {
	return (await listCostCenters(await deps.getDb(), orgId)).map(viewOf);
}

function fieldsOf(body: CostCenterBody) {
	return {
		code: body.code,
		name: body.name,
		departmentId: body.departmentId ?? null,
		ownerContact: body.ownerContact ?? null
	};
}

export async function createCostCenter(
	deps: CostCenterServices,
	orgId: string,
	body: CostCenterBody
): Promise<CostCenterView> {
	const row: CostCenterRow = {
		id: `cc_${deps.newId()}`,
		organizationId: orgId,
		createdAt: deps.now(),
		...fieldsOf(body)
	};
	try {
		await insertCostCenter(await deps.getDb(), row);
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'A cost center already uses that code');
		}
		throw error;
	}
	return viewOf(row);
}

export async function editCostCenter(
	deps: CostCenterServices,
	orgId: string,
	id: string,
	body: CostCenterBody
): Promise<CostCenterView> {
	const db = await deps.getDb();
	const current = await getCostCenter(db, orgId, id);
	if (current === null) throw new ApiError('not_found', 'Not found');
	const row: CostCenterRow = { ...current, ...fieldsOf(body) };
	try {
		await updateCostCenter(db, row);
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'A cost center already uses that code');
		}
		throw error;
	}
	return viewOf(row);
}

export async function assignSite(
	deps: CostCenterServices,
	orgId: string,
	siteId: string,
	body: AssignSiteBody
): Promise<CostSite> {
	const db = await deps.getDb();
	const site = (await listOrgSites(db, orgId)).find((row) => row.id === siteId);
	if (site === undefined) throw new ApiError('not_found', 'Not found');
	if (
		body.costCenterId !== null &&
		(await getCostCenter(db, orgId, body.costCenterId)) === null
	) {
		throw new ApiError('validation', 'Choose a cost center from this organisation');
	}
	const next: Omit<OrgSiteRow, 'id' | 'name'> = {
		costCenterId: body.costCenterId,
		technicalOwner:
			body.technicalOwner === undefined ? site.technicalOwner : body.technicalOwner,
		businessOwner: body.businessOwner === undefined ? site.businessOwner : body.businessOwner
	};
	await setSiteAssignment(db, orgId, siteId, next);
	return { id: site.id, name: site.name, costCenterId: next.costCenterId };
}

export async function listCostSites(deps: CostCenterServices, orgId: string): Promise<CostSite[]> {
	return (await listOrgSites(await deps.getDb(), orgId)).map((row) => ({
		id: row.id,
		name: row.name,
		costCenterId: row.costCenterId
	}));
}

interface ReportInput {
	month: string;
	amountCents: number | null;
}

interface CostBuild {
	rows: CostReportRow[];
	report: CostReport;
}

// usage, allocation, forecast and the central summary for one month, from the same site reads
async function build(
	deps: CostCenterServices,
	orgId: string,
	input: ReportInput
): Promise<CostBuild> {
	const db = await deps.getDb();
	const bounds = monthBounds(input.month);
	const [centers, sites] = await Promise.all([
		listCostCenters(db, orgId),
		listOrgSites(db, orgId)
	]);
	const intervals = await deps.usage.intervals(
		orgId,
		sites.map((site) => site.id),
		bounds
	);
	const siteStates = new Map<string, { views: number; state: AccountingState }>();
	for (const site of sites) {
		// hours after now have no row yet, so only the hours that have begun are expected
		const begun = { ...bounds, hours: hoursStarted(bounds, deps.now()) };
		siteStates.set(site.id, siteUsage(intervals.get(site.id) ?? [], begun));
	}
	const hours = elapsedHours(bounds, deps.now());
	const partial = centers.map((center) => {
		const members = sites.filter((site) => site.costCenterId === center.id);
		const views = members.reduce((sum, site) => sum + siteStates.get(site.id)!.views, 0);
		const state = worstState(members.map((site) => siteStates.get(site.id)!.state));
		return {
			costCenterId: center.id,
			code: center.code,
			name: center.name,
			siteCount: members.length,
			views,
			state,
			projectedViews: straightLine(views, state, hours, bounds)
		};
	});
	const weights = partial.map((row) => row.views);
	const totalViews = weights.reduce((a, b) => a + b, 0);
	const allocated = input.amountCents === null ? null : allocate(input.amountCents, weights);
	const rows: CostReportRow[] = partial.map((row, index) => ({
		...row,
		allocatedCents: allocated === null ? null : allocated[index]!,
		share: totalViews === 0 ? null : row.views / totalViews
	}));
	const central = {
		costCenters: centers.length,
		sites: sites.length,
		unassignedSites: sites.filter((site) => site.costCenterId === null).length,
		views: [...siteStates.values()].reduce((sum, s) => sum + s.views, 0),
		state: worstState([...siteStates.values()].map((s) => s.state))
	};
	return {
		rows,
		report: {
			month: input.month,
			method: 'straight-line',
			amountCents: input.amountCents,
			rows,
			central
		}
	};
}

export async function costReport(
	deps: CostCenterServices,
	orgId: string,
	input: ReportInput
): Promise<CostReport> {
	return (await build(deps, orgId, input)).report;
}

export async function costReportCsv(
	deps: CostCenterServices,
	orgId: string,
	input: ReportInput
): Promise<string> {
	const { rows, report } = await build(deps, orgId, input);
	return csvLines([
		['code', 'name', 'sites', 'views', 'state', 'allocated_cents', 'share', 'projected_views'],
		...rows.map((row) => [
			row.code,
			row.name,
			row.siteCount,
			row.views,
			row.state,
			row.allocatedCents,
			row.share === null ? null : row.share.toFixed(4),
			row.projectedViews
		]),
		[
			'central',
			'All cost centers',
			report.central.sites,
			report.central.views,
			report.central.state,
			null,
			null,
			null
		]
	]);
}
