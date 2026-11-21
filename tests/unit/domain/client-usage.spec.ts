import { describe, expect, it } from 'vitest';
import { siteId } from '../../../contracts/src/common';
import {
	csvField,
	monthlyUsage,
	monthSpan,
	nextMonth,
	usageCsv,
	type UsageSample
} from '../../../src/server/domain/client-usage';

describe('csv fields', () => {
	it.each([
		['=1+1', "'=1+1"],
		['+1+1', "'+1+1"],
		['-2+3', "'-2+3"],
		['@SUM(A1)', "'@SUM(A1)"],
		['\tcmd', "'\tcmd"],
		['\rcmd', `"'\rcmd"`]
	])('prefixes %j so a spreadsheet reads it as text', (value, expected) => {
		expect(csvField(value)).toBe(expected);
	});

	it('doubles the quotes of a formula that holds them', () => {
		expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
	});

	it('quotes a field that holds a comma, a quote or a line break, and doubles its quotes', () => {
		expect(csvField('a,b')).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField('line\nbreak')).toBe('"line\nbreak"');
	});

	it('leaves plain text and non-negative numbers alone', () => {
		expect(csvField('site-one')).toBe('site-one');
		expect(csvField(0)).toBe('0');
		expect(csvField(1234)).toBe('1234');
	});

	it('escapes a formula that also needs quoting', () => {
		expect(csvField('=1,2')).toBe(`"'=1,2"`);
	});
});

describe('monthly usage', () => {
	const hour = (site: string, start: string, over: Partial<UsageSample> = {}): UsageSample => ({
		siteId: siteId.parse(site),
		start,
		accuracy: 'exact',
		views: 10,
		lowerBound: 10,
		...over
	});

	it('sums hours into one row per site and UTC month, sorted', () => {
		const rows = monthlyUsage([
			hour('site_bbbbbbbb', '2026-03-01T00:00:00.000Z'),
			hour('site_aaaaaaaa', '2026-03-31T23:00:00.000Z'),
			hour('site_aaaaaaaa', '2026-03-01T00:00:00.000Z', {
				views: 5,
				lowerBound: 4,
				accuracy: 'estimated'
			}),
			hour('site_aaaaaaaa', '2026-04-01T00:00:00.000Z', {
				accuracy: 'unaccounted',
				views: 0,
				lowerBound: 0
			})
		]);
		expect(rows).toEqual([
			{
				month: '2026-03',
				siteId: 'site_aaaaaaaa',
				views: 15,
				lowerBound: 14,
				unaccountedHours: 0
			},
			{
				month: '2026-03',
				siteId: 'site_bbbbbbbb',
				views: 10,
				lowerBound: 10,
				unaccountedHours: 0
			},
			{
				month: '2026-04',
				siteId: 'site_aaaaaaaa',
				views: 0,
				lowerBound: 0,
				unaccountedHours: 1
			}
		]);
	});

	it('writes the header and one line per row', () => {
		const csv = usageCsv([
			{
				month: '2026-03',
				siteId: 'site_aaaaaaaa',
				views: 25,
				lowerBound: 24,
				unaccountedHours: 0
			}
		]);
		expect(csv).toBe(
			'month,site_id,views,lower_bound,unaccounted_hours\n2026-03,site_aaaaaaaa,25,24,0\n'
		);
	});
});

describe('month range', () => {
	it('counts both ends of a range and refuses a reversed or malformed one', () => {
		expect(monthSpan('2026-01', '2026-12')).toBe(12);
		expect(monthSpan('2026-03', '2026-03')).toBe(1);
		expect(monthSpan('2026-05', '2026-03')).toBeNull();
		expect(monthSpan('2026-13', '2026-14')).toBeNull();
		expect(monthSpan('March', '2026-03')).toBeNull();
	});

	it('moves to the next month across a year', () => {
		expect(nextMonth('2026-03')).toBe('2026-04');
		expect(nextMonth('2026-12')).toBe('2027-01');
	});
});
