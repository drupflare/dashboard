import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	assignSite,
	costReport,
	costReportCsv,
	createCostCenter,
	editCostCenter,
	listCostCenterViews,
	listCostSites,
	noUsageReads,
	type CostCenterServices,
	type UsageReads
} from '../../../src/server/services/cost-centers';
import { openBindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;
let counter = 0;
const NOW = Date.parse('2026-02-15T12:00:00Z');

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env);
});

afterAll(() => open.close());

beforeEach(() => {
	counter = 0;
});

const deps = (): CostCenterServices => ({
	getDb: async () => db,
	usage: noUsageReads,
	newId: () => crypto.randomUUID(),
	now: () => NOW
});

const org = () => `org-${crypto.randomUUID()}`;

async function site(orgId: string, id: string, name: string) {
	await db.run(
		orgId,
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES (?, ?, ?, 'managed', 'active', 0, 0)`,
		[id, orgId, name]
	);
}

describe('cost center services', () => {
	it('creates and lists cost centers, and refuses a second code in the same organisation', async () => {
		const orgId = org();
		const created = await createCostCenter(deps(), orgId, {
			code: 'CC-100',
			name: 'Library',
			departmentId: null,
			ownerContact: 'ada@example.edu'
		});
		expect(created).toMatchObject({ code: 'CC-100', name: 'Library' });
		expect((await listCostCenterViews(deps(), orgId)).map((row) => row.code)).toEqual([
			'CC-100'
		]);
		await expect(
			createCostCenter(deps(), orgId, { code: 'CC-100', name: 'Other', departmentId: null })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('keeps the same code free in another organisation', async () => {
		const first = org();
		const second = org();
		await createCostCenter(deps(), first, { code: 'CC-7', name: 'A', departmentId: null });
		await expect(
			createCostCenter(deps(), second, { code: 'CC-7', name: 'B', departmentId: null })
		).resolves.toMatchObject({ code: 'CC-7' });
	});

	it('changes a cost center only inside its own organisation', async () => {
		const orgId = org();
		const created = await createCostCenter(deps(), orgId, {
			code: 'CC-1',
			name: 'Old',
			departmentId: null
		});
		await expect(
			editCostCenter(deps(), org(), created.id, {
				code: 'CC-1',
				name: 'New',
				departmentId: null
			})
		).rejects.toMatchObject({ code: 'not_found' });
		await expect(
			editCostCenter(deps(), orgId, created.id, {
				code: 'CC-1',
				name: 'New',
				departmentId: null
			})
		).resolves.toMatchObject({ name: 'New' });
	});

	it('assigns a site, keeps its owners when they are omitted, and refuses a cost center from another organisation', async () => {
		const orgId = org();
		await site(orgId, 'site_a', 'Main');
		const center = await createCostCenter(deps(), orgId, {
			code: 'CC-2',
			name: 'Press',
			departmentId: null
		});
		await assignSite(deps(), orgId, 'site_a', {
			costCenterId: center.id,
			technicalOwner: 'Web Team',
			businessOwner: 'Press Office'
		});
		await assignSite(deps(), orgId, 'site_a', { costCenterId: center.id });
		const after = (await listCostSites(deps(), orgId)).find((row) => row.id === 'site_a');
		expect(after?.costCenterId).toBe(center.id);
		await expect(
			assignSite(deps(), org(), 'site_a', { costCenterId: center.id })
		).rejects.toMatchObject({ code: 'not_found' });
		const foreign = await createCostCenter(deps(), org(), {
			code: 'CC-9',
			name: 'Elsewhere',
			departmentId: null
		});
		await expect(
			assignSite(deps(), orgId, 'site_a', { costCenterId: foreign.id })
		).rejects.toMatchObject({ code: 'validation' });
	});

	it('reports every hour as unaccounted when no usage is stored, and shares an amount across no views as zero', async () => {
		const orgId = org();
		await site(orgId, 'site_b', 'Annex');
		const center = await createCostCenter(deps(), orgId, {
			code: 'CC-3',
			name: 'Annex',
			departmentId: null
		});
		await assignSite(deps(), orgId, 'site_b', { costCenterId: center.id });
		const report = await costReport(deps(), orgId, { month: '2026-02', amountCents: 10_000 });
		expect(report.rows).toEqual([
			expect.objectContaining({
				code: 'CC-3',
				siteCount: 1,
				views: 0,
				state: 'unaccounted',
				allocatedCents: 0,
				share: null,
				projectedViews: null
			})
		]);
		expect(report.central).toMatchObject({
			costCenters: 1,
			sites: 1,
			unassignedSites: 0,
			state: 'unaccounted'
		});
	});

	it('expects only the hours that have begun in the month, so a current month with every begun hour stored is exact', async () => {
		const orgId = org();
		await site(orgId, 'site_c', 'Current');
		const center = await createCostCenter(deps(), orgId, {
			code: 'CC-4',
			name: 'Current',
			departmentId: null
		});
		await assignSite(deps(), orgId, 'site_c', { costCenterId: center.id });
		const first = Date.UTC(2026, 1, 1);
		const begun = [0, 1, 2].map((h) => ({
			siteId: 'site_c',
			start: new Date(first + h * 3_600_000).toISOString(),
			end: new Date(first + (h + 1) * 3_600_000).toISOString(),
			accuracy: 'exact' as const,
			views: 5,
			lowerBound: 5,
			observedViews: null,
			settlement: 'closed' as const
		}));
		const usage: UsageReads = { intervals: async () => new Map([['site_c', begun]]) };
		const early = { ...deps(), usage, now: () => Date.parse('2026-02-01T02:30:00Z') };
		const report = await costReport(early, orgId, { month: '2026-02', amountCents: null });
		expect(report.rows).toEqual([
			expect.objectContaining({ code: 'CC-4', views: 15, state: 'exact' })
		]);
	});

	it('writes the report as CSV and guards a formula in a cost center name', async () => {
		const orgId = org();
		await createCostCenter(deps(), orgId, {
			code: 'CC-4',
			name: '=SUM(A1)',
			departmentId: null
		});
		const csv = await costReportCsv(deps(), orgId, { month: '2026-02', amountCents: null });
		expect(csv.split('\r\n')[0]).toBe(
			'code,name,sites,views,state,allocated_cents,share,projected_views'
		);
		expect(csv).toContain("CC-4,'=SUM(A1)");
		expect(csv).toContain('central,All cost centers');
	});
});
