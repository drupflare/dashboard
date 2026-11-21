import { describe, expect, it } from 'vitest';
import { csvLines } from '../../../../src/server/domain/csv';
import { buildPilotReport, reportCsvRows } from '../../../../src/server/domain/pilot-report';
import type { ObservationKind, PilotView } from '../../../../src/shared/pilots';

const pilot = (over: Partial<PilotView> = {}): PilotView => ({
	id: 'pil_1',
	name: 'Migration Pilot',
	state: 'running',
	startDate: '2026-01-05',
	sponsor: 'Dean of Libraries',
	technicalOwner: 'Web Team',
	baselineHostingSpendCents: 120_000,
	baselineStaffHours: 40,
	baselineLatencyMs: 900,
	baselineRestoreMinutes: 240,
	baselineRollbackMinutes: 60,
	baselinePatchDays: 14,
	successCriteria: '',
	decision: null,
	decidedAt: null,
	continuationCostCents: null,
	siteIds: ['site_a'],
	createdAt: '2026-01-01T00:00:00.000Z',
	...over
});

const obs = (id: string, kind: ObservationKind, text: string, minutes: number | null = null) => ({
	id,
	at: '2026-01-10T00:00:00.000Z',
	kind,
	minutes,
	text
});

describe('pilot report', () => {
	it('keeps the negative results of a pilot that did not succeed', () => {
		const report = buildPilotReport({
			pilot: pilot({ decision: 'stop', decidedAt: '2026-02-01T00:00:00.000Z' }),
			sites: [{ id: 'site_a', name: 'Main', views: 0, state: 'unaccounted' }],
			observations: [
				obs('o1', 'failure', 'Rollback did not restore the menu'),
				obs('o2', 'unsupported', 'Image styles on the press site'),
				obs('o3', 'manual-work', 'Re-ran the patch by hand', 90),
				obs('o4', 'manual-work', 'Checked the mail queue', 30)
			]
		});
		expect(report.decision).toBe('stop');
		expect(report.failures).toHaveLength(1);
		expect(report.unsupported).toHaveLength(1);
		expect(report.negativeResults).toBe(2);
		expect(report.staff).toMatchObject({
			observedMinutes: 120,
			observedEntries: 2,
			baselineHours: 40
		});
		expect(report.drupflare).toMatchObject({
			costCents: null,
			costStatus: 'not measured',
			state: 'unaccounted'
		});
		expect(report.successCriteria).toBe('');
	});

	it('reports a missing hosting baseline as not measured instead of zero', () => {
		const report = buildPilotReport({
			pilot: pilot({ baselineHostingSpendCents: null }),
			sites: [],
			observations: []
		});
		expect(report.hosting).toEqual({ baselineSpendCents: null, status: 'not measured' });
	});

	it('writes one csv row per observation with the formula guard applied', () => {
		const report = buildPilotReport({
			pilot: pilot(),
			sites: [],
			observations: [obs('o1', 'note', '=cmd', null)]
		});
		expect(csvLines(reportCsvRows(report))).toBe(
			"at,kind,minutes,text\r\n2026-01-10T00:00:00.000Z,note,,'=cmd\r\n"
		);
	});
});
