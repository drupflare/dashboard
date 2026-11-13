import { describe, expect, it } from 'vitest';
import {
	admitHours,
	HOUR_MS,
	hoursUsedSince,
	type ImportRun,
	utcDayStart,
	utcMonthStart
} from '../../../src/shared/import-hours';

const JOB = HOUR_MS / 2;
const at = (iso: string) => Date.parse(iso);
const MIDDAY = at('2026-11-13T12:00:00Z');
const FREE = { perMonthHours: 1, perDayHours: 0.5 };

describe('the UTC windows', () => {
	it('starts a day at UTC midnight and a month on its first day, whatever the hour', () => {
		expect(utcDayStart(at('2026-11-13T00:00:00Z'))).toBe(at('2026-11-13T00:00:00Z'));
		expect(utcDayStart(at('2026-11-13T23:59:59.999Z'))).toBe(at('2026-11-13T00:00:00Z'));
		expect(utcMonthStart(at('2026-11-30T23:59:59.999Z'))).toBe(at('2026-11-01T00:00:00Z'));
		expect(utcMonthStart(at('2026-12-01T00:00:00Z'))).toBe(at('2026-12-01T00:00:00Z'));
	});
});

describe('hoursUsedSince', () => {
	it('counts only runs that started at or after the window start', () => {
		const runs: ImportRun[] = [
			{ startedAt: at('2026-11-12T23:59:00Z'), wallMs: 10 * 60_000 },
			{ startedAt: at('2026-11-13T00:00:00Z'), wallMs: 5 * 60_000 }
		];
		expect(hoursUsedSince(runs, utcDayStart(MIDDAY), JOB)).toBe(5 * 60_000);
	});

	it('counts an open run, one with no wall clock yet, as a whole job', () => {
		expect(hoursUsedSince([{ startedAt: MIDDAY, wallMs: null }], 0, JOB)).toBe(JOB);
	});
});

describe('admitHours', () => {
	it('admits a first start on a plan with room for one whole job', () => {
		expect(admitHours([], FREE, MIDDAY, JOB)).toBeNull();
	});

	it('refuses a start that could take the day past its hours, even when the last run was short', () => {
		const runs = [{ startedAt: MIDDAY, wallMs: 10 * 60_000 }];
		expect(admitHours(runs, FREE, MIDDAY, JOB)).toBe('import_hours_today');
	});

	it('admits again on the next UTC day, when yesterday no longer counts', () => {
		const runs = [{ startedAt: at('2026-11-12T13:00:00Z'), wallMs: JOB }];
		expect(admitHours(runs, FREE, MIDDAY, JOB)).toBeNull();
	});

	it('refuses on the month when the day has room but the month does not', () => {
		const earlier = at('2026-11-02T10:00:00Z');
		const runs = [
			{ startedAt: earlier, wallMs: JOB },
			{ startedAt: earlier + HOUR_MS, wallMs: JOB / 2 }
		];
		const cap = { perMonthHours: 1, perDayHours: 2 };
		expect(admitHours(runs, cap, MIDDAY, JOB)).toBe('import_hours_this_month');
	});

	it('resets the month at its first UTC instant', () => {
		const runs = [{ startedAt: at('2026-10-31T23:00:00Z'), wallMs: JOB * 2 }];
		const cap = { perMonthHours: 1, perDayHours: 2 };
		expect(admitHours(runs, cap, at('2026-11-01T00:30:00Z'), JOB)).toBeNull();
	});

	it('refuses an approval plan until an approval step exists, whatever the hours', () => {
		expect(admitHours([], 'approval', MIDDAY, JOB)).toBe('import_approval_needed');
	});
});
