import { SPEND_BUDGET, findAddOn, viewsPool, type AddOn, type MeterId, type Plan } from './plans';

export type BudgetScope = 'org' | 'site';
export type Enforcement = 'block' | 'alert';

export interface Budget {
	scope: BudgetScope;
	percent: number;
	enforcement: Enforcement;
	meters: readonly MeterId[];
}

const MIN = SPEND_BUDGET.minPercent.value;
const MAX = SPEND_BUDGET.maxPercent.value;

// meters with a counting path in code today; a later meter joins by being added here
export const COUNTED_METERS: readonly MeterId[] = ['views'];

// #region percent

export type PercentResult =
	| { ok: true; percent: number }
	| {
			ok: false;
			reason: 'not-a-number' | 'too-precise' | 'too-low' | 'too-high';
			message: string;
	  };

export function validatePercent(value: unknown): PercentResult {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return { ok: false, reason: 'not-a-number', message: 'Enter a number.' };
	}
	if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
		return {
			ok: false,
			reason: 'too-precise',
			message: 'Use a whole number or one decimal place.'
		};
	}
	if (value < MIN) {
		return {
			ok: false,
			reason: 'too-low',
			message: `The lowest budget is ${MIN} percent, which is the allowance itself.`
		};
	}
	if (value > MAX) {
		return {
			ok: false,
			reason: 'too-high',
			message: `The highest budget is ${MAX} percent of the allowance.`
		};
	}
	return { ok: true, percent: Math.round(value * 10) / 10 };
}

// slider position 0 to 1 over one decade; the log scale makes position the exponent
export function positionToPercent(position: number): number {
	if (!(position > 0)) return MIN;
	if (position >= 1) return MAX;
	return MIN * (MAX / MIN) ** position;
}

export function percentToPosition(percent: number): number {
	if (!(percent > MIN)) return 0;
	if (percent >= MAX) return 1;
	return Math.log(percent / MIN) / Math.log(MAX / MIN);
}

// position to percent to position agrees within this; percent to position to percent within a
// relative 1e-9
export const POSITION_TOLERANCE = 1e-12;

// slider steps; the number field keeps exact values. 200 and 500 are multiples of both neighbours
export function snapPercent(percent: number): number {
	const step = percent < 200 ? 10 : percent < 500 ? 25 : 50;
	return Math.min(MAX, Math.max(MIN, Math.round(percent / step) * step));
}

// #endregion

// #region money

export interface UnitRate {
	perMillion: number | null;
	unreviewed: boolean;
}

export type Money =
	| { kind: 'dollars'; dollars: number }
	| { kind: 'unreviewed'; reason: 'rate-unknown' | 'rate-unreviewed' | 'allowance-unknown' };

export function viewsUnitRate(addOn: AddOn | undefined = findAddOn('views')): UnitRate {
	if (!addOn) return { perMillion: null, unreviewed: true };
	return { perMillion: addOn.recurring?.monthly.value ?? null, unreviewed: addOn.unreviewed };
}

function priced(rate: UnitRate): { ok: true; perMillion: number } | { ok: false; money: Money } {
	if (rate.perMillion === null) {
		return { ok: false, money: { kind: 'unreviewed', reason: 'rate-unknown' } };
	}
	if (rate.unreviewed) {
		return { ok: false, money: { kind: 'unreviewed', reason: 'rate-unreviewed' } };
	}
	return { ok: true, perMillion: rate.perMillion };
}

export function capViews(allowanceViews: number, percent: number): number {
	return (allowanceViews * percent) / 100;
}

export function allowedOverageDollars(
	percent: number,
	allowanceViews: number,
	rate: UnitRate
): Money {
	const r = priced(rate);
	if (!r.ok) return r.money;
	const over = (allowanceViews * (percent - 100)) / 100;
	return { kind: 'dollars', dollars: (over / 1_000_000) * r.perMillion };
}

export function budgetDollars(percent: number, allowanceViews: number, rate: UnitRate): Money {
	const r = priced(rate);
	if (!r.ok) return r.money;
	return {
		kind: 'dollars',
		dollars: (capViews(allowanceViews, percent) / 1_000_000) * r.perMillion
	};
}

// the stored form is a percent with at most one decimal, so a typed dollar figure rounds to it
export function percentFromBudgetDollars(
	dollars: number,
	allowanceViews: number,
	rate: UnitRate
): number | null {
	const r = priced(rate);
	if (!r.ok || allowanceViews <= 0 || r.perMillion <= 0) return null;
	const percent = (dollars * 1_000_000 * 100) / (allowanceViews * r.perMillion);
	return Math.round(percent * 10) / 10;
}

export interface MeterAllowance {
	meter: MeterId;
	allowance: number | null;
	rate: UnitRate;
}

// the same percent applied to the allowance value of every meter that has a counting path
export function orgBudgetDollars(percent: number, meters: readonly MeterAllowance[]): Money {
	let total = 0;
	for (const m of meters) {
		if (!COUNTED_METERS.includes(m.meter)) continue;
		if (m.allowance === null) return { kind: 'unreviewed', reason: 'allowance-unknown' };
		const r = priced(m.rate);
		if (!r.ok) return r.money;
		total += (capViews(m.allowance, percent) / 1_000_000) * r.perMillion;
	}
	return { kind: 'dollars', dollars: total };
}

// #endregion

// #region pooled allowances

export function siteBudgetDefault(
	plan: Pick<Plan, 'views' | 'viewsPooled' | 'sites'>,
	siteCount: number
): number {
	const pool = viewsPool(plan);
	if (pool.pooled && siteCount > 1) return SPEND_BUDGET.pooledSiteDefaultPercent.value;
	return SPEND_BUDGET.defaultPercent.value;
}

export function clampSiteToOrg(sitePercent: number, orgPercent: number): number {
	return Math.min(sitePercent, orgPercent);
}

// #endregion

// #region evaluation

export const ALLOWANCE_THRESHOLDS = [75, 90, 100, 250] as const;

export type AlertKey =
	'allowance-75' | 'allowance-90' | 'allowance-100' | 'allowance-250' | 'budget-90' | 'blocked';

export type EvaluationFlag = 'count-unknown' | 'allowance-unknown' | 'would-block';

export interface SentAlert {
	key: AlertKey;
	period: string;
}

export interface Evaluation {
	state: 'ok' | 'over-budget';
	alerts: AlertKey[];
	flags: EvaluationFlag[];
}

export interface EvaluateInput {
	budget: Pick<Budget, 'percent' | 'enforcement'>;
	allowanceViews: number | null;
	viewsLowerBound: number | null;
	sentAlerts: readonly SentAlert[];
	period: string;
}

export function markSent(
	sent: readonly SentAlert[],
	alerts: readonly AlertKey[],
	period: string
): SentAlert[] {
	return [...sent, ...alerts.map((key) => ({ key, period }))];
}

// 90 percent of the budget has its own alert only when no listed allowance threshold sits there
export function budgetNinetyShown(percent: number): boolean {
	const tenths = Math.round(percent * 10);
	return !ALLOWANCE_THRESHOLDS.some((t) => Math.abs(tenths * 9 - 100 * t) <= 50);
}

// all comparisons are on integers (tenths of a percent), so the cap is exact
export function evaluateBudget(input: EvaluateInput): Evaluation {
	const { budget, allowanceViews: allowance, viewsLowerBound: views } = input;
	if (views === null) return { state: 'ok', alerts: [], flags: ['count-unknown'] };
	if (allowance === null || allowance <= 0) {
		return { state: 'ok', alerts: [], flags: ['allowance-unknown'] };
	}
	const tenths = Math.round(budget.percent * 10);
	const crossed: AlertKey[] = [];
	for (const t of ALLOWANCE_THRESHOLDS) {
		if (views * 100 >= allowance * t) crossed.push(`allowance-${t}` as AlertKey);
	}
	if (budgetNinetyShown(budget.percent) && views * 10_000 >= allowance * 9 * tenths) {
		crossed.push('budget-90');
	}
	const atCap = views * 1000 >= allowance * tenths;
	const blocking = atCap && budget.enforcement === 'block';
	if (blocking) crossed.push('blocked');
	const sent = new Set(
		input.sentAlerts.filter((s) => s.period === input.period).map((s) => s.key)
	);
	return {
		state: blocking ? 'over-budget' : 'ok',
		alerts: crossed.filter((key) => !sent.has(key)),
		flags: atCap && !blocking ? ['would-block'] : []
	};
}

// #endregion

// #region scopes

export interface SiteEvaluation {
	siteId: string;
	evaluation: Pick<Evaluation, 'state'> | null;
}

export interface SiteState {
	state: 'ok' | 'over-budget';
	reason: 'site-budget' | 'org-budget' | null;
}

// a soft budget never reports over-budget, so only hard budgets reach this; null means no budget
export function effectiveState(input: {
	org: Pick<Evaluation, 'state'> | null;
	sites: readonly SiteEvaluation[];
}): Record<string, SiteState> {
	const orgBlocks = input.org?.state === 'over-budget';
	const out: Record<string, SiteState> = {};
	for (const site of input.sites) {
		if (orgBlocks) out[site.siteId] = { state: 'over-budget', reason: 'org-budget' };
		else if (site.evaluation?.state === 'over-budget') {
			out[site.siteId] = { state: 'over-budget', reason: 'site-budget' };
		} else out[site.siteId] = { state: 'ok', reason: null };
	}
	return out;
}

// #endregion

// #region bound

// the unflushed tail the counting mechanism can lose adds to this and is stated separately
export function overshootBoundMs(leaseMs: number, flushMs: number): number {
	return leaseMs + flushMs;
}

export const OVERSHOOT_BOUND_SENTENCE =
	'A stop takes effect within one lease interval plus one counting flush interval, plus any unflushed tail the counting mechanism can lose when a server restarts.';

// #endregion
