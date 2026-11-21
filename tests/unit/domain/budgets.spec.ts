import { describe, expect, it } from 'vitest';
import { DEFAULT_LEASE_MS } from '../../../contracts/src/site-auth';
import {
	ALLOWANCE_THRESHOLDS,
	OVERSHOOT_BOUND_SENTENCE,
	POSITION_TOLERANCE,
	allowedOverageDollars,
	budgetDollars,
	clampSiteToOrg,
	effectiveState,
	evaluateBudget,
	markSent,
	orgBudgetDollars,
	overshootBoundMs,
	percentFromBudgetDollars,
	percentToPosition,
	positionToPercent,
	siteBudgetDefault,
	snapPercent,
	validatePercent,
	viewsUnitRate,
	type AlertKey,
	type EvaluateInput,
	type SentAlert,
	type UnitRate
} from '../../../src/shared/budget-rules';
import { SPEND_BUDGET, findAddOn, findPlan, viewsPool } from '../../../src/shared/plans';

function findViews() {
	const addOn = findAddOn('views');
	if (!addOn) throw new Error('no views add-on');
	return addOn;
}

const RATE: UnitRate = { perMillion: 25, unreviewed: false };
const plan = (id: string) => {
	const found = findPlan(id);
	if (!found) throw new Error(`no plan ${id}`);
	return found;
};

function seeded(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const input = (over: Partial<EvaluateInput> & { views: number | null }): EvaluateInput => ({
	budget: { percent: 500, enforcement: 'block' },
	allowanceViews: 1000,
	viewsLowerBound: over.views,
	sentAlerts: [],
	period: '2026-11',
	...over
});

describe('constants', () => {
	it('holds the decided range as unreviewed assumptions', () => {
		expect(SPEND_BUDGET.minPercent.value).toBe(100);
		expect(SPEND_BUDGET.defaultPercent.value).toBe(500);
		expect(SPEND_BUDGET.maxPercent.value).toBe(1000);
		expect(SPEND_BUDGET.pooledSiteDefaultPercent.value).toBe(250);
		expect(SPEND_BUDGET.defaultPercent.label).toBe('assumption');
		expect(SPEND_BUDGET.unreviewed).toBe(true);
	});

	it('reads pooling from the plans', () => {
		expect(viewsPool(plan('managed-pro'))).toEqual({ pooled: true, sites: 3 });
		expect(viewsPool(plan('managed-agency'))).toEqual({ pooled: true, sites: 50 });
		expect(viewsPool(plan('institution-starter')).pooled).toBe(false);
	});
});

describe('validatePercent', () => {
	it('accepts integers and one decimal inside the range', () => {
		for (const v of [100, 500, 1000, 250.5, 100.1]) {
			expect(validatePercent(v)).toEqual({ ok: true, percent: v });
		}
	});

	it('refuses with a reason and a plain message', () => {
		expect(validatePercent(99.9)).toMatchObject({ ok: false, reason: 'too-low' });
		expect(validatePercent(1000.1)).toMatchObject({ ok: false, reason: 'too-high' });
		expect(validatePercent(250.55)).toMatchObject({ ok: false, reason: 'too-precise' });
		for (const v of ['500', null, NaN, Infinity, undefined]) {
			expect(validatePercent(v)).toMatchObject({ ok: false, reason: 'not-a-number' });
		}
		const low = validatePercent(50);
		if (!low.ok)
			expect(low.message).toBe(
				'The lowest budget is 100 percent, which is the allowance itself.'
			);
	});
});

describe('slider', () => {
	it('has exact endpoints', () => {
		expect(positionToPercent(0)).toBe(100);
		expect(positionToPercent(1)).toBe(1000);
		expect(percentToPosition(100)).toBe(0);
		expect(percentToPosition(1000)).toBe(1);
		expect(positionToPercent(0.5)).toBeCloseTo(316.2277, 3);
	});

	it('is monotonic and round-trips across 200 points', () => {
		let last = -Infinity;
		for (let i = 0; i < 200; i++) {
			const p = i / 199;
			const percent = positionToPercent(p);
			expect(percent).toBeGreaterThanOrEqual(last);
			last = percent;
			expect(Math.abs(percentToPosition(percent) - p)).toBeLessThan(POSITION_TOLERANCE);
			const back = positionToPercent(percentToPosition(percent));
			expect(Math.abs(back - percent) / percent).toBeLessThan(1e-9);
		}
	});

	it('clamps out-of-range input', () => {
		expect(positionToPercent(-1)).toBe(100);
		expect(positionToPercent(2)).toBe(1000);
		expect(percentToPosition(50)).toBe(0);
		expect(percentToPosition(5000)).toBe(1);
	});

	it('snaps to steps, stays in range and never goes backwards', () => {
		expect(snapPercent(104)).toBe(100);
		expect(snapPercent(106)).toBe(110);
		expect(snapPercent(212)).toBe(200);
		expect(snapPercent(213)).toBe(225);
		expect(snapPercent(520)).toBe(500);
		expect(snapPercent(530)).toBe(550);
		expect(snapPercent(1000)).toBe(1000);
		let last = 0;
		for (let v = 100; v <= 1000; v += 0.5) {
			const s = snapPercent(v);
			expect(s).toBeGreaterThanOrEqual(last);
			last = s;
		}
	});
});

describe('money', () => {
	it('computes overage and budget dollars', () => {
		expect(allowedOverageDollars(500, 1_000_000, RATE)).toEqual({
			kind: 'dollars',
			dollars: 100
		});
		expect(budgetDollars(500, 1_000_000, RATE)).toEqual({ kind: 'dollars', dollars: 125 });
		expect(allowedOverageDollars(100, 1_000_000, RATE)).toEqual({
			kind: 'dollars',
			dollars: 0
		});
	});

	it('returns unreviewed for an unknown or unreviewed rate, never a figure', () => {
		const unknown: UnitRate = { perMillion: null, unreviewed: false };
		const pending: UnitRate = { perMillion: 25, unreviewed: true };
		expect(budgetDollars(500, 1e6, unknown)).toEqual({
			kind: 'unreviewed',
			reason: 'rate-unknown'
		});
		expect(allowedOverageDollars(500, 1e6, pending)).toEqual({
			kind: 'unreviewed',
			reason: 'rate-unreviewed'
		});
		expect(percentFromBudgetDollars(125, 1e6, pending)).toBeNull();
	});

	it('reads the views add-on, which is unreviewed today', () => {
		const rate = viewsUnitRate();
		expect(rate.perMillion).toBe(25);
		expect(rate.unreviewed).toBe(true);
		expect(budgetDollars(500, 1e6, rate).kind).toBe('unreviewed');
		expect(viewsUnitRate({ ...findViews(), recurring: null }).perMillion).toBeNull();
	});

	it('applies the organisation percent to every counted meter only', () => {
		const views = { meter: 'views' as const, allowance: 1e6, rate: RATE };
		expect(orgBudgetDollars(500, [views])).toEqual({ kind: 'dollars', dollars: 125 });
		expect(orgBudgetDollars(500, [views, views])).toEqual({ kind: 'dollars', dollars: 250 });
		const writes = {
			meter: 'writes' as const,
			allowance: 5,
			rate: { perMillion: null, unreviewed: true }
		};
		expect(orgBudgetDollars(500, [views, writes])).toEqual({ kind: 'dollars', dollars: 125 });
		expect(orgBudgetDollars(500, [{ ...views, allowance: null }])).toEqual({
			kind: 'unreviewed',
			reason: 'allowance-unknown'
		});
		expect(
			orgBudgetDollars(500, [{ ...views, rate: { perMillion: 25, unreviewed: true } }]).kind
		).toBe('unreviewed');
	});

	it('round-trips percent to dollars to percent within a cent per million views', () => {
		const rand = seeded(1);
		for (let i = 0; i < 2000; i++) {
			const percent = 100 + Math.floor(rand() * 9001) / 10;
			const allowance = Math.round(1000 + rand() * 1e9);
			const rate: UnitRate = { perMillion: 0.01 + rand() * 100, unreviewed: false };
			const d = budgetDollars(percent, allowance, rate);
			if (d.kind !== 'dollars') throw new Error('expected dollars');
			const back = percentFromBudgetDollars(d.dollars, allowance, rate);
			expect(back).toBe(percent);
			const d2 = budgetDollars(back as number, allowance, rate);
			if (d2.kind !== 'dollars') throw new Error('expected dollars');
			expect(Math.abs(d2.dollars - d.dollars)).toBeLessThanOrEqual((0.01 * allowance) / 1e6);
		}
	});

	it('rounds a typed dollar figure to the stored one-decimal percent', () => {
		const rand = seeded(2);
		for (let i = 0; i < 500; i++) {
			const allowance = Math.round(1e5 + rand() * 1e8);
			const rate: UnitRate = { perMillion: 1 + rand() * 50, unreviewed: false };
			const typed = 1 + rand() * 1000;
			const percent = percentFromBudgetDollars(typed, allowance, rate) as number;
			const d = budgetDollars(percent, allowance, rate);
			if (d.kind !== 'dollars') throw new Error('expected dollars');
			const step = (0.05 / 100) * (allowance / 1e6) * (rate.perMillion as number);
			expect(Math.abs(d.dollars - typed)).toBeLessThanOrEqual(step + 1e-9);
		}
	});
});

describe('pooled allowances', () => {
	it('defaults a site to 250 percent of the pool on a pooled plan with several sites', () => {
		expect(siteBudgetDefault(plan('managed-pro'), 3)).toBe(250);
		expect(siteBudgetDefault(plan('managed-agency'), 12)).toBe(250);
	});

	it('uses the plan default for one site or an unpooled plan', () => {
		expect(siteBudgetDefault(plan('managed-pro'), 1)).toBe(500);
		expect(siteBudgetDefault(plan('institution-starter'), 40)).toBe(500);
		expect(siteBudgetDefault({ ...plan('managed-pro'), viewsPooled: false }, 3)).toBe(500);
	});

	it('never lets a site exceed its organisation', () => {
		expect(clampSiteToOrg(800, 500)).toBe(500);
		expect(clampSiteToOrg(250, 500)).toBe(250);
		expect(clampSiteToOrg(500, 500)).toBe(500);
	});
});

describe('evaluateBudget', () => {
	it('sends each threshold once per period when sent alerts are fed back', () => {
		let sent: SentAlert[] = [];
		const seen: AlertKey[] = [];
		for (const views of [
			0, 749, 750, 751, 900, 1000, 2400, 2500, 4000, 4500, 4999, 5000, 9000
		]) {
			const r = evaluateBudget(input({ views, sentAlerts: sent }));
			seen.push(...r.alerts);
			sent = markSent(sent, r.alerts, '2026-11');
		}
		expect(seen).toEqual([
			'allowance-75',
			'allowance-90',
			'allowance-100',
			'allowance-250',
			'budget-90',
			'blocked'
		]);
		expect(ALLOWANCE_THRESHOLDS).toEqual([75, 90, 100, 250]);
	});

	it('fires again in a new period', () => {
		const sent = markSent([], ['allowance-75'], '2026-10');
		expect(evaluateBudget(input({ views: 750, sentAlerts: sent })).alerts).toEqual([
			'allowance-75'
		]);
		expect(
			evaluateBudget(input({ views: 750, sentAlerts: sent, period: '2026-10' })).alerts
		).toEqual([]);
	});

	it('reports each alert only as it is crossed', () => {
		expect(evaluateBudget(input({ views: 749 })).alerts).toEqual([]);
		expect(evaluateBudget(input({ views: 750 })).alerts).toEqual(['allowance-75']);
		expect(evaluateBudget(input({ views: 2500 })).alerts).toEqual([
			'allowance-75',
			'allowance-90',
			'allowance-100',
			'allowance-250'
		]);
	});

	it('drops budget-90 only when it coincides with a listed threshold', () => {
		const at = (percent: number) => {
			const allowance = 100_000;
			const r = evaluateBudget({
				budget: { percent, enforcement: 'alert' },
				allowanceViews: allowance,
				viewsLowerBound: allowance * (percent / 100),
				sentAlerts: [],
				period: 'p'
			});
			return r.alerts.includes('budget-90');
		};
		expect(at(100)).toBe(false);
		expect(at(250)).toBe(true);
		expect(at(500)).toBe(true);
		expect(at(1000)).toBe(true);
		expect(at(111.1)).toBe(false);
		expect(at(277.8)).toBe(false);
		expect(at(120)).toBe(true);
	});

	it('fires budget-90 at 90 percent of the budget and not before', () => {
		expect(evaluateBudget(input({ views: 4499 })).alerts).not.toContain('budget-90');
		expect(evaluateBudget(input({ views: 4500 })).alerts).toContain('budget-90');
	});

	it('blocks a hard budget at exactly the cap and not one view before', () => {
		const before = evaluateBudget(input({ views: 4999 }));
		expect(before.state).toBe('ok');
		expect(before.alerts).not.toContain('blocked');
		const at = evaluateBudget(input({ views: 5000 }));
		expect(at.state).toBe('over-budget');
		expect(at.alerts).toContain('blocked');
	});

	it('lifts the block when the cap is raised', () => {
		const raised = evaluateBudget(
			input({ views: 5000, budget: { percent: 600, enforcement: 'block' } })
		);
		expect(raised.state).toBe('ok');
	});

	it('never blocks a soft budget but reports alerts and would-block', () => {
		const soft = { percent: 500, enforcement: 'alert' as const };
		const before = evaluateBudget(input({ views: 4999, budget: soft }));
		expect(before.flags).toEqual([]);
		for (const views of [5000, 50_000]) {
			const r = evaluateBudget(input({ views, budget: soft }));
			expect(r.state).toBe('ok');
			expect(r.alerts).not.toContain('blocked');
			expect(r.alerts).toContain('allowance-250');
			expect(r.flags).toEqual(['would-block']);
		}
	});

	it('handles one-decimal percents exactly', () => {
		const budget = { percent: 100.1, enforcement: 'block' as const };
		expect(evaluateBudget(input({ views: 1000, budget })).state).toBe('ok');
		expect(evaluateBudget(input({ views: 1001, budget })).state).toBe('over-budget');
	});

	it('never blocks on an unknown count or allowance', () => {
		const r = evaluateBudget(input({ views: null }));
		expect(r).toEqual({ state: 'ok', alerts: [], flags: ['count-unknown'] });
		for (const allowanceViews of [null, 0]) {
			expect(evaluateBudget(input({ views: 9e9, allowanceViews }))).toEqual({
				state: 'ok',
				alerts: [],
				flags: ['allowance-unknown']
			});
		}
	});
});

describe('effectiveState', () => {
	const ok = { state: 'ok' as const };
	const over = { state: 'over-budget' as const };
	const sites = (a: typeof ok | typeof over | null, b: typeof ok | typeof over | null) => [
		{ siteId: 'a', evaluation: a },
		{ siteId: 'b', evaluation: b }
	];
	const blocked = (reason: 'site-budget' | 'org-budget') => ({ state: 'over-budget', reason });
	const free = { state: 'ok', reason: null };

	it('hard org at its cap blocks every site it owns', () => {
		expect(effectiveState({ org: over, sites: sites(ok, null) })).toEqual({
			a: blocked('org-budget'),
			b: blocked('org-budget')
		});
		expect(effectiveState({ org: over, sites: sites(over, ok) })).toEqual({
			a: blocked('org-budget'),
			b: blocked('org-budget')
		});
	});

	it('hard org under its cap leaves a hard site to its own cap', () => {
		expect(effectiveState({ org: ok, sites: sites(over, ok) })).toEqual({
			a: blocked('site-budget'),
			b: free
		});
	});

	it('soft org never blocks, even over its cap, but a hard site still stops itself', () => {
		const evalSoft = evaluateBudget(
			input({ views: 9000, budget: { percent: 500, enforcement: 'alert' } })
		);
		expect(evalSoft.state).toBe('ok');
		expect(effectiveState({ org: evalSoft, sites: sites(over, ok) })).toEqual({
			a: blocked('site-budget'),
			b: free
		});
	});

	it('soft site and soft org block nothing', () => {
		const soft = evaluateBudget(
			input({ views: 9000, budget: { percent: 500, enforcement: 'alert' } })
		);
		expect(effectiveState({ org: soft, sites: sites(soft, null) })).toEqual({
			a: free,
			b: free
		});
	});

	it('works without an organisation budget', () => {
		expect(effectiveState({ org: null, sites: sites(ok, over) })).toEqual({
			a: free,
			b: blocked('site-budget')
		});
	});
});

describe('overshoot bound', () => {
	it('adds the lease and the flush interval', () => {
		expect(overshootBoundMs(DEFAULT_LEASE_MS, 5_000)).toBe(35_000);
		expect(overshootBoundMs(5_000, 5_000)).toBe(10_000);
	});

	it('states a bound, never instant', () => {
		expect(OVERSHOOT_BOUND_SENTENCE).toMatch(
			/within one lease interval plus one counting flush/
		);
		expect(OVERSHOOT_BOUND_SENTENCE).toMatch(/unflushed tail/);
		expect(OVERSHOOT_BOUND_SENTENCE.toLowerCase()).not.toContain('instant');
	});
});
