import { describe, expect, it } from 'vitest';
import { monthBounds } from '../../../../src/server/domain/cost-centers';
import { billableViews } from '../../../../src/server/domain/usage-ledger';
import {
	dailyViews,
	hoursStarted,
	intervalOf,
	monthView,
	type StoredHour
} from '../../../../src/server/domain/usage-views';

const MONTH = monthBounds('2026-11');
const hour = (h: number) => new Date(MONTH.start + h * 3_600_000).toISOString();

const row = (h: number, over: Partial<StoredHour> = {}): StoredHour => ({
	siteId: 'site-a',
	hourStart: hour(h),
	issued: 10,
	acked: 10,
	accounting: 'exact',
	settlement: 'closed',
	...over
});

describe('usage views', () => {
	it('bills an unaccounted hour at zero, never its stored counts', () => {
		const interval = intervalOf(row(0, { accounting: 'unaccounted', issued: 7, acked: 3 }));
		expect(interval).toMatchObject({ accuracy: 'unaccounted', views: 0, lowerBound: 0 });
		expect(billableViews(interval)).toEqual({ basis: 'unaccounted', views: 0 });
	});

	it('counts the hours that have begun, the hour in progress included', () => {
		expect(hoursStarted(MONTH, MONTH.start - 1)).toBe(0);
		expect(hoursStarted(MONTH, MONTH.start)).toBe(1);
		expect(hoursStarted(MONTH, MONTH.start + 3_600_000 - 1)).toBe(1);
		expect(hoursStarted(MONTH, MONTH.start + 3_600_000)).toBe(2);
		expect(hoursStarted(MONTH, MONTH.end + 1)).toBe(MONTH.hours);
	});

	it('treats a started hour with no row as unaccounted, not as zero', () => {
		const now = MONTH.start + 3 * 3_600_000;
		const view = monthView([row(0), row(1)], MONTH, now);
		expect(view).toMatchObject({
			views: 20,
			lowerBound: 20,
			state: 'unaccounted',
			expectedHours: 4,
			presentHours: 2,
			closed: false
		});
	});

	it('reports an exact month only when every started hour has an exact row', () => {
		const now = MONTH.start + 3_600_000 + 1_000;
		expect(monthView([row(0), row(1)], MONTH, now).state).toBe('exact');
		expect(
			monthView([row(0), row(1, { accounting: 'estimated', acked: 4 })], MONTH, now).state
		).toBe('estimated');
	});

	it('is closed only when the month has ended and no hour is still open', () => {
		const after = MONTH.end + 1;
		const rows = Array.from({ length: MONTH.hours }, (_, h) => row(h));
		expect(monthView(rows, MONTH, after).closed).toBe(true);
		expect(monthView([row(0, { settlement: 'open' })], MONTH, after).closed).toBe(false);
	});

	it('gives each day its own state and counts its missing hours', () => {
		const now = MONTH.start + 26 * 3_600_000;
		const days = dailyViews(
			[row(0), row(1, { accounting: 'unaccounted', issued: 0, acked: 0 }), row(24)],
			MONTH,
			now
		);
		expect(days).toEqual([
			{
				day: '2026-11-01',
				views: 10,
				lowerBound: 10,
				state: 'unaccounted',
				unaccountedHours: 22
			},
			{
				day: '2026-11-02',
				views: 10,
				lowerBound: 10,
				state: 'unaccounted',
				unaccountedHours: 2
			}
		]);
	});
});
