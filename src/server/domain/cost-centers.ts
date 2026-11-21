import type { UsageInterval } from '@contracts/usage';
import type { AccountingState } from '../../shared/cost-centers';
import { billableViews } from './usage-ledger';

const HOUR_MS = 3_600_000;

export interface MonthBounds {
	start: number;
	end: number;
	hours: number;
}

// a calendar month in UTC; the usage intervals are UTC hours
export function monthBounds(month: string): MonthBounds {
	const [year, monthIndex] = month.split('-').map(Number) as [number, number];
	const start = Date.UTC(year, monthIndex - 1, 1);
	const end = Date.UTC(year, monthIndex, 1);
	return { start, end, hours: (end - start) / HOUR_MS };
}

const RANK: Record<AccountingState, number> = { exact: 0, estimated: 1, unaccounted: 2 };

// the worst state wins, so one unaccounted hour makes the whole month unaccounted
export function worstState(states: readonly AccountingState[]): AccountingState {
	let worst: AccountingState = 'exact';
	for (const state of states) if (RANK[state] > RANK[worst]) worst = state;
	return worst;
}

// an hour with no interval is unaccounted; views count only where accounting exists
export function siteUsage(
	intervals: readonly UsageInterval[],
	bounds: MonthBounds
): { views: number; state: AccountingState } {
	const seen = new Set(intervals.map((interval) => Date.parse(interval.start)));
	const missing = bounds.hours - seen.size;
	let views = 0;
	const states: AccountingState[] = missing > 0 ? ['unaccounted'] : [];
	for (const interval of intervals) {
		const billable = billableViews(interval);
		views += billable.views;
		states.push(billable.basis);
	}
	return { views, state: intervals.length === 0 ? 'unaccounted' : worstState(states) };
}

// largest remainder, so the parts add up to the total exactly
export function allocate(totalCents: number, weights: readonly number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	if (sum === 0) return weights.map(() => 0);
	const exact = weights.map((w) => (totalCents * w) / sum);
	const floors = exact.map((x) => Math.floor(x));
	let rest = totalCents - floors.reduce((a, b) => a + b, 0);
	const order = exact
		.map((x, i) => ({ i, frac: x - Math.floor(x) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i);
	for (const { i } of order) {
		if (rest === 0) break;
		floors[i]! += 1;
		rest -= 1;
	}
	return floors;
}

// a straight line through the views seen so far; nothing is projected from unaccounted hours
export function straightLine(
	views: number,
	state: AccountingState,
	elapsedHours: number,
	bounds: MonthBounds
): number | null {
	if (state === 'unaccounted' || elapsedHours <= 0) return null;
	return Math.round((views * bounds.hours) / Math.min(elapsedHours, bounds.hours));
}

// the month the report shows when the caller names none, in UTC like the usage hours
export function currentMonth(now: number): string {
	return new Date(now).toISOString().slice(0, 7);
}

export function elapsedHours(bounds: MonthBounds, now: number): number {
	return Math.max(0, Math.min(now, bounds.end) - bounds.start) / HOUR_MS;
}
