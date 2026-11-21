import type { SiteId } from '@contracts/common';
import type { UsageInterval } from '@contracts/usage';
import { worstState, type MonthBounds } from './cost-centers';
import { billableViews } from './usage-ledger';

export const HOUR_MS = 3_600_000;

export type Accounting = 'exact' | 'estimated' | 'unaccounted';

// one stored hour, as the usage repository returns it
export interface StoredHour {
	siteId: string;
	hourStart: string;
	issued: number;
	acked: number;
	accounting: Accounting;
	settlement: UsageInterval['settlement'];
}

export function intervalOf(row: StoredHour): UsageInterval {
	const start = Date.parse(row.hourStart);
	const unaccounted = row.accounting === 'unaccounted';
	// site ids are minted by newId('site'), so a stored id already has the contract's brand
	return {
		siteId: row.siteId as SiteId,
		start: row.hourStart,
		end: new Date(start + HOUR_MS).toISOString(),
		accuracy: row.accounting,
		views: unaccounted ? 0 : row.issued,
		lowerBound: unaccounted ? 0 : row.acked,
		observedViews: null,
		settlement: row.settlement
	};
}

// hours that have begun by `now`, counted from the start of the range; the hour in progress counts
export function hoursStarted(bounds: MonthBounds, now: number): number {
	if (now < bounds.start) return 0;
	return Math.min(bounds.hours, Math.floor((now - bounds.start) / HOUR_MS) + 1);
}

export interface MonthView {
	views: number;
	lowerBound: number;
	state: Accounting;
	closed: boolean;
	expectedHours: number;
	presentHours: number;
}

// a started hour with no row is unaccounted: it was never read, so it is not treated as zero
export function monthView(
	rows: readonly StoredHour[],
	bounds: MonthBounds,
	now: number
): MonthView {
	const intervals = rows.map(intervalOf);
	const expectedHours = hoursStarted(bounds, now);
	const missing = Math.max(0, expectedHours - rows.length);
	const states: Accounting[] = rows.map((row) => row.accounting);
	if (missing > 0) states.push('unaccounted');
	return {
		views: intervals.reduce((sum, i) => sum + billableViews(i).views, 0),
		lowerBound: intervals.reduce((sum, i) => sum + i.lowerBound, 0),
		state: rows.length === 0 ? 'unaccounted' : worstState(states),
		closed: bounds.end <= now && rows.every((row) => row.settlement !== 'open'),
		expectedHours,
		presentHours: rows.length
	};
}

export interface DayView {
	day: string;
	views: number;
	lowerBound: number;
	state: Accounting;
	unaccountedHours: number;
}

// one entry per UTC day that has begun, in order; the day's state is the worst of its hours
export function dailyViews(
	rows: readonly StoredHour[],
	bounds: MonthBounds,
	now: number
): DayView[] {
	const days = new Map<string, { expected: number; rows: StoredHour[] }>();
	const started = hoursStarted(bounds, now);
	for (let k = 0; k < started; k++) {
		const day = new Date(bounds.start + k * HOUR_MS).toISOString().slice(0, 10);
		const entry = days.get(day) ?? { expected: 0, rows: [] };
		entry.expected++;
		days.set(day, entry);
	}
	for (const row of rows) {
		const entry = days.get(row.hourStart.slice(0, 10));
		if (entry) entry.rows.push(row);
	}
	return [...days].map(([day, entry]) => {
		const intervals = entry.rows.map(intervalOf);
		const unaccountedHours = Math.max(0, entry.expected - entry.rows.length);
		const states: Accounting[] = entry.rows.map((row) => row.accounting);
		if (unaccountedHours > 0) states.push('unaccounted');
		return {
			day,
			views: intervals.reduce((sum, i) => sum + billableViews(i).views, 0),
			lowerBound: intervals.reduce((sum, i) => sum + i.lowerBound, 0),
			state: states.length === 0 ? 'unaccounted' : worstState(states),
			unaccountedHours
		};
	});
}
