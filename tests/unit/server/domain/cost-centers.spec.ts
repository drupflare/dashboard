import type { UsageInterval } from '@contracts/usage';
import { describe, expect, it } from 'vitest';
import {
	allocate,
	currentMonth,
	elapsedHours,
	monthBounds,
	siteUsage,
	straightLine,
	worstState
} from '../../../../src/server/domain/cost-centers';
import { csvLines } from '../../../../src/server/domain/csv';

const bounds = monthBounds('2026-02');

const hour = (
	index: number,
	views: number,
	accuracy: UsageInterval['accuracy'] = 'exact'
): UsageInterval => {
	const start = new Date(bounds.start + index * 3_600_000).toISOString();
	const end = new Date(bounds.start + (index + 1) * 3_600_000).toISOString();
	return {
		siteId: 'site_a' as UsageInterval['siteId'],
		start,
		end,
		accuracy,
		views,
		lowerBound: accuracy === 'exact' ? views : accuracy === 'estimated' ? 0 : 0,
		observedViews: null,
		settlement: 'closed'
	};
};

describe('cost center usage', () => {
	it('is unaccounted when a month has no intervals', () => {
		expect(siteUsage([], bounds)).toEqual({ views: 0, state: 'unaccounted' });
	});

	it('is unaccounted while any hour of the month is missing', () => {
		const partial = [hour(0, 5), hour(1, 7)];
		expect(siteUsage(partial, bounds)).toEqual({ views: 12, state: 'unaccounted' });
	});

	it('takes the worst accounting state of its hours', () => {
		expect(worstState(['exact', 'estimated'])).toBe('estimated');
		expect(worstState(['exact', 'unaccounted', 'estimated'])).toBe('unaccounted');
		expect(worstState([])).toBe('exact');
	});

	it('counts an unaccounted hour as zero views', () => {
		const rows = [hour(0, 5), hour(1, 9, 'unaccounted')];
		expect(siteUsage(rows, { ...bounds, hours: 2 })).toEqual({
			views: 5,
			state: 'unaccounted'
		});
	});
});

describe('allocation', () => {
	it('splits a total by share and adds up to the total exactly', () => {
		const parts = allocate(1000, [1, 1, 1]);
		expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
		expect(parts).toEqual([334, 333, 333]);
	});

	it('gives nothing to anyone when no site has views', () => {
		expect(allocate(500, [0, 0])).toEqual([0, 0]);
	});
});

describe('straight-line projection', () => {
	it('scales the views so far to the whole month', () => {
		const half = { start: bounds.start, end: bounds.end, hours: bounds.hours };
		const elapsed = bounds.hours / 2;
		expect(straightLine(100, 'exact', elapsed, half)).toBe(200);
	});

	it('projects nothing from unaccounted hours or before the month starts', () => {
		expect(straightLine(100, 'unaccounted', 10, bounds)).toBeNull();
		expect(straightLine(100, 'exact', 0, bounds)).toBeNull();
	});

	it('caps the elapsed time at the month end', () => {
		expect(elapsedHours(bounds, bounds.end + 1_000_000)).toBe(bounds.hours);
		expect(elapsedHours(bounds, bounds.start - 1)).toBe(0);
	});

	it('names the month in UTC', () => {
		expect(currentMonth(Date.UTC(2026, 1, 28, 23, 0))).toBe('2026-02');
	});
});

describe('csv output', () => {
	it('prefixes a formula character with an apostrophe and quotes embedded commas', () => {
		const text = csvLines([
			['code', 'name'],
			['cc-1', '=HYPERLINK("x")'],
			['cc-2', 'Dept, West'],
			['cc-3', '+1']
		]);
		expect(text).toBe(
			'code,name\r\ncc-1,"\'=HYPERLINK(""x"")"\r\ncc-2,"Dept, West"\r\ncc-3,\'+1\r\n'
		);
	});
});
