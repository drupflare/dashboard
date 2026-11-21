import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { noUsageReads } from '../../../src/server/services/cost-centers';
import {
	addObservation,
	createPilot,
	editPilot,
	getPilotView,
	pilotReport,
	pilotReportCsv,
	recordDecision,
	setPilotSites,
	type PilotServices
} from '../../../src/server/services/pilots';
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

const deps = (): PilotServices => ({
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

const body = (over: Record<string, unknown> = {}) => ({
	name: 'Hosting Pilot',
	startDate: '2026-02-01',
	sponsor: 'CIO',
	technicalOwner: null,
	baselineHostingSpendCents: 250_000,
	baselineStaffHours: 30,
	successCriteria: '',
	...over
});

describe('pilot services', () => {
	it('starts a pilot with an empty success line, which the owner writes', async () => {
		const orgId = org();
		const pilot = await createPilot(deps(), orgId, body());
		expect(pilot).toMatchObject({ state: 'planned', successCriteria: '', decision: null });
	});

	it('refuses a site from another organisation and a pilot from another organisation', async () => {
		const orgId = org();
		await site(orgId, 'site_p1', 'Campus');
		const pilot = await createPilot(deps(), orgId, body());
		await expect(setPilotSites(deps(), orgId, pilot.id, ['site_other'])).rejects.toMatchObject({
			code: 'validation'
		});
		await expect(getPilotView(deps(), org(), pilot.id)).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(setPilotSites(deps(), orgId, pilot.id, ['site_p1'])).resolves.toMatchObject({
			siteIds: ['site_p1'],
			state: 'running'
		});
	});

	it('keeps a stored baseline when a patch leaves it out', async () => {
		const orgId = org();
		const pilot = await createPilot(deps(), orgId, body());
		const edited = await editPilot(deps(), orgId, pilot.id, {
			successCriteria: 'Hosting cost falls by a fifth.'
		});
		expect(edited).toMatchObject({
			baselineHostingSpendCents: 250_000,
			successCriteria: 'Hosting cost falls by a fifth.'
		});
	});

	it('refuses a new start date after a decision is recorded', async () => {
		const orgId = org();
		const pilot = await createPilot(deps(), orgId, body());
		await recordDecision(deps(), orgId, pilot.id, {
			decision: 'stop',
			continuationCostCents: null
		});
		await expect(
			editPilot(deps(), orgId, pilot.id, { startDate: '2026-03-01' })
		).rejects.toMatchObject({
			code: 'conflict'
		});
	});

	it('reports a negative result pilot with its failures, unsupported items and manual minutes', async () => {
		const orgId = org();
		await site(orgId, 'site_p2', 'Press');
		const pilot = await createPilot(deps(), orgId, body({ baselineHostingSpendCents: null }));
		await setPilotSites(deps(), orgId, pilot.id, ['site_p2']);
		await addObservation(deps(), orgId, pilot.id, {
			kind: 'failure',
			text: 'Restore took two days',
			minutes: null
		});
		await addObservation(deps(), orgId, pilot.id, {
			kind: 'unsupported',
			text: 'Custom module',
			minutes: null
		});
		await addObservation(deps(), orgId, pilot.id, {
			kind: 'manual-work',
			text: 'Patched by hand',
			minutes: 45
		});
		await recordDecision(deps(), orgId, pilot.id, {
			decision: 'stop',
			continuationCostCents: null
		});
		const report = await pilotReport(deps(), orgId, pilot.id);
		expect(report.decision).toBe('stop');
		expect(report.failures.map((row) => row.text)).toEqual(['Restore took two days']);
		expect(report.unsupported.map((row) => row.text)).toEqual(['Custom module']);
		expect(report.staff).toMatchObject({ observedMinutes: 45, observedEntries: 1 });
		expect(report.hosting.status).toBe('not measured');
		expect(report.drupflare.costStatus).toBe('not measured');
		expect(report.negativeResults).toBe(2);
	});

	it('writes the observations as CSV with the formula guard', async () => {
		const orgId = org();
		const pilot = await createPilot(deps(), orgId, body());
		await addObservation(deps(), orgId, pilot.id, {
			kind: 'note',
			text: '+SUM(A1)',
			minutes: null
		});
		const csv = await pilotReportCsv(deps(), orgId, pilot.id);
		expect(csv.split('\r\n')[0]).toBe('at,kind,minutes,text');
		expect(csv).toContain(",note,,'+SUM(A1)");
	});
});
