import { describe, expect, it } from 'vitest';
import {
	capacityWarnings,
	dollars,
	formatPercent,
	type CreditsView,
	type HeadroomView
} from '../../../src/shared/capacity';

const credits = (over: Partial<Extract<CreditsView, { state: 'ok' }>> = {}): CreditsView => ({
	state: 'ok',
	currency: 'USD',
	balanceCents: 999_958,
	originalCents: 1_000_000,
	usedCents: 42,
	daysRemaining: 363,
	validFrom: '2026-11-12T00:00:00Z',
	validTo: '2027-11-12T00:00:00Z',
	projectedDepletion: null,
	...over
});

const headroom = (kvNamespaces: number): HeadroomView => ({
	state: 'ok',
	kvNamespaces,
	kvLimit: 1000,
	buckets: 2,
	scripts: 7,
	databases: 1,
	rate: { remaining: null, quota: null, resetSeconds: null, windowSeconds: null }
});

const ids = (view: Parameters<typeof capacityWarnings>[0]) =>
	capacityWarnings(view).map((warning) => warning.id);

describe('capacityWarnings', () => {
	it('stays quiet on the grant as it stood on 2026-11-12', () => {
		expect(ids({ credits: credits(), headroom: headroom(40) })).toEqual([]);
	});

	it('warns when namespaces pass 80 percent of the limit and not at exactly 80', () => {
		expect(ids({ credits: credits(), headroom: headroom(800) })).toEqual([]);
		const [warning] = capacityWarnings({ credits: credits(), headroom: headroom(801) });
		expect(warning?.id).toBe('namespaces');
		expect(warning?.text).toContain('801 of 1,000');
		expect(warning?.text).toContain('80 percent');
		expect(
			capacityWarnings({ credits: credits(), headroom: headroom(1000) })[0]?.text
		).toContain('100 percent');
	});

	it('warns when fewer than 30 days remain and not at exactly 30', () => {
		expect(ids({ credits: credits({ daysRemaining: 30 }), headroom: headroom(1) })).toEqual([]);
		const [warning] = capacityWarnings({
			credits: credits({ daysRemaining: 29 }),
			headroom: headroom(1)
		});
		expect(warning).toMatchObject({ id: 'expiry' });
		expect(warning?.text).toBe('The grant ends in 29 days on 2027-11-12.');
		const last = capacityWarnings({
			credits: credits({ daysRemaining: 1, validTo: null }),
			headroom: headroom(1)
		});
		expect(last[0]?.text).toBe('The grant ends in 1 day.');
	});

	it('warns when the grant would run out before it expires', () => {
		const early = credits({ projectedDepletion: '2027-03-01T00:00:00Z' });
		const [warning] = capacityWarnings({ credits: early, headroom: headroom(1) });
		expect(warning).toMatchObject({ id: 'depletion' });
		expect(warning?.text).toBe(
			'At the current pace the grant is used up on 2027-03-01, before it expires on 2027-11-12.'
		);
		const late = credits({ projectedDepletion: '2028-01-01T00:00:00Z' });
		expect(ids({ credits: late, headroom: headroom(1) })).toEqual([]);
	});

	it('does not guess from a missing or unreadable date', () => {
		for (const over of [
			{ projectedDepletion: null },
			{ projectedDepletion: 'soon' },
			{ validTo: null, projectedDepletion: '2027-03-01T00:00:00Z' }
		]) {
			expect(ids({ credits: credits(over), headroom: headroom(1) })).toEqual([]);
		}
	});

	it('raises every warning that applies, namespaces first', () => {
		expect(
			ids({
				credits: credits({ daysRemaining: 5, projectedDepletion: '2026-11-15T00:00:00Z' }),
				headroom: headroom(900)
			})
		).toEqual(['namespaces', 'expiry', 'depletion']);
	});

	it('raises nothing from a section that could not be read', () => {
		const unread = { state: 'unavailable' } as const;
		expect(ids({ credits: unread, headroom: unread })).toEqual([]);
		expect(ids({ credits: { state: 'no_billing_access' }, headroom: headroom(900) })).toEqual([
			'namespaces'
		]);
	});
});

describe('the words', () => {
	it('formats cents as dollars, defaulting to USD when the usage has no rows', () => {
		expect(dollars(999_958, 'USD')).toBe('$9,999.58');
		expect(dollars(0, null)).toBe('$0.00');
		expect(dollars(-250, 'USD')).toBe('-$2.50');
	});

	it('formats a percent and names a share too small to show', () => {
		expect(formatPercent(0)).toBe('0 percent');
		expect(formatPercent(0.0042)).toBe('under 0.01 percent');
		expect(formatPercent(12.345)).toBe('12.35 percent');
		expect(formatPercent(50)).toBe('50 percent');
	});
});
