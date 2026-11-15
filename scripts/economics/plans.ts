import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADD_ONS, PLANS, type AddOn, type Interval, type Plan } from '../../src/shared/plans';
import { containerCost } from './template-delivery';

export type Label = 'published' | 'derived' | 'assumption';

export interface Rate {
	perUnit: number;
	label: Label;
	source: string;
}

const SURVEY = 'Cloudflare pricing pages, survey read 2026-11-14';

// every view is costed as a render of this many CPU milliseconds, the survey's own example
export const CPU_MS_PER_VIEW = 10;
const REQUESTS_PER_MILLION = 0.3;
const CPU_PER_MILLION_MS = 0.02;

// gross list rates: no account allowance is applied, so a figure here is never optimistic
export const RATES = {
	// the raw cost of keeping one more site warm once the account allowances are spent: the worker
	// docs' kept-warm table, (1,000 sites $350.03 less 100 sites $9.80) over 900 sites at 1,000 views.
	// The fleet average of $0.351 is not used: it folds in the $5 subscription and the allowances
	siteMonth: {
		perUnit: 0.378,
		label: 'derived',
		source: 'worker docs, economics, kept-warm table; marginal site past the allowances'
	},
	viewMillion: {
		perUnit: REQUESTS_PER_MILLION + CPU_MS_PER_VIEW * CPU_PER_MILLION_MS,
		label: 'derived',
		source: `requests $0.30 plus ${CPU_MS_PER_VIEW} ms CPU a view at $0.02 per million ms; ${SURVEY}`
	},
	writeMillion: {
		perUnit: 1,
		label: 'published',
		source: `Durable Object rows written above 50 million; ${SURVEY}`
	},
	storageGbMonth: {
		perUnit: 0.2,
		label: 'published',
		source: `Durable Object SQLite storage above 5 GB-month; ${SURVEY}`
	},
	backupGbMonth: {
		perUnit: 0.015,
		label: 'published',
		source: `R2 Standard storage, before Class A operations; ${SURVEY}`
	},
	mailThousand: {
		perUnit: 0.35,
		label: 'published',
		source: `Email Service overage rate, charged from the first send because the 3,000 a month included on the account is shared by every plan; ${SURVEY}`
	},
	containerHour: {
		perUnit: containerCost(3600),
		label: 'derived',
		source: `standard-2 at 100 percent CPU for an hour; ${SURVEY}`
	},
	supportHour: { perUnit: 62.5, label: 'derived', source: 'loaded rate, roadmap, Pricing' }
} as const satisfies Record<string, Rate>;

// paid plans cost at most this share of their price with every allowance used
export const TARGET_SHARE = 0.5;
// a free plan costs at most this many dollars a month with every allowance used
export const FREE_CEILING = 2;

type Line = 'sites' | 'views' | 'writes' | 'storage' | 'backup' | 'mail' | 'containers' | 'support';

export interface Breakdown {
	lines: Record<Line, number>;
	total: number;
	// dollars that are infrastructure, without support hours
	infra: number;
	// figures the plan leaves unstated, so the total is a floor
	unstated: string[];
}

const SITE_SCOPED = ['sites', 'views', 'writes', 'storageGb'];

function figure(plan: Plan, key: keyof Plan): number | null {
	const value = plan[key] as { value: number | null };
	return value.value;
}

// a paid plan keeps its sites warm by default and a free plan lets them sleep; an admin can move
// any site along the gradient, so this is the default and not the bill of every site
export const keepsWarm = (plan: Plan) => (plan.monthly.value ?? 0) > 0;

// what one month costs us when every allowance on the plan is used
export function monthlyCost(plan: Plan): Breakdown {
	const unstated: string[] = [];
	// a plan off the managed plane runs its sites on the customer's own account
	const ours = (key: string) => plan.plane === 'managed' || !SITE_SCOPED.includes(key);
	const warmRate = keepsWarm(plan) ? RATES.siteMonth.perUnit : 0;
	const amount = (key: keyof Plan, rate: number, per = 1): number => {
		if (!ours(key)) return 0;
		const value = figure(plan, key);
		if (value === null) {
			if (!('unlimited' in (plan[key] as object))) unstated.push(key);
			return 0;
		}
		return (value / per) * rate;
	};
	const lines = {
		sites: amount('sites', warmRate),
		views: amount('views', RATES.viewMillion.perUnit, 1_000_000),
		writes: amount('writes', RATES.writeMillion.perUnit, 1_000_000),
		storage: amount('storageGb', RATES.storageGbMonth.perUnit),
		backup: amount('backupGb', RATES.backupGbMonth.perUnit),
		mail: amount('mailSends', RATES.mailThousand.perUnit, 1000),
		containers: amount('containerHours', RATES.containerHour.perUnit),
		support: amount('supportHoursPerYear', RATES.supportHour.perUnit, 12)
	};
	const total = Object.values(lines).reduce((sum, line) => sum + line, 0);
	return { lines, total, infra: total - lines.support, unstated };
}

// the smallest support pack on sale is one hour, so a smaller bundled figure cannot be spent
export const MIN_BUNDLED_HOURS_PER_YEAR = 1;

// a plan bundles hours only when the rest of its cost plus those hours stays inside the target
// and the figure is at least the smallest unit a customer can buy
export function hoursAffordable(plan: Plan): boolean {
	const hours = figure(plan, 'supportHoursPerYear') ?? 0;
	if (hours === 0) return true;
	const price = plan.monthly.value;
	if (price === null || price <= 0 || hours < MIN_BUNDLED_HOURS_PER_YEAR) return false;
	return monthlyCost(plan).total <= price * TARGET_SHARE;
}

export type Verdict = 'ok' | 'over' | 'no price' | 'no figures';

export interface PlanMargin {
	id: string;
	price: number | null;
	cost: Breakdown;
	// total cost over price; null when the plan has no price to divide by
	share: number | null;
	verdict: Verdict;
}

export function planMargin(plan: Plan, interval: Interval = 'month'): PlanMargin {
	const cost = monthlyCost(plan);
	const priced = interval === 'month' ? plan.monthly.value : plan.annual.value;
	const price = priced === null ? null : interval === 'month' ? priced : priced / 12;
	if (price === null) return { id: plan.id, price, cost, share: null, verdict: 'no price' };
	// a plan that states no site count has no basis to cost, and a zero would read as free
	if (plan.plane === 'managed' && cost.unstated.includes('sites')) {
		return { id: plan.id, price, cost, share: null, verdict: 'no figures' };
	}
	if (price === 0) {
		return {
			id: plan.id,
			price,
			cost,
			share: null,
			verdict: cost.total <= FREE_CEILING ? 'ok' : 'over'
		};
	}
	const share = cost.total / price;
	return { id: plan.id, price, cost, share, verdict: share <= TARGET_SHARE ? 'ok' : 'over' };
}

// a typical site is kept warm at 10,000 views a month and holds 4.7 MB (worker docs, economics)
export const TYPICAL_VIEWS = 10_000;
export const TYPICAL_STORAGE_GB = 0.0047;

const perSiteInfra = (warm = true) =>
	(warm ? RATES.siteMonth.perUnit : 0) +
	(TYPICAL_VIEWS / 1_000_000) * RATES.viewMillion.perUnit +
	TYPICAL_STORAGE_GB * RATES.storageGbMonth.perUnit;

// what a plan costs us a month when its sites are typical, not when every allowance is spent
export function typicalCost(plan: Plan): number | null {
	const sites = figure(plan, 'sites');
	if (sites === null || plan.plane !== 'managed') return null;
	return sites * perSiteInfra(keepsWarm(plan));
}

// no customer exists yet, so support load per site is a number to set, not to read. It applies
// only to a plan that bundles hours; a small plan bundles none and its price carries no support time
export const SUPPORT_HOURS_PER_SITE_YEAR = 0.25;

// what cost plus charges a month for kept-warm sites at a markup on typical infrastructure, plus
// the support time of a plan that bundles hours
export function costPlusPrice(sites: number, markup: number, withSupport = false): number {
	const support = withSupport
		? (SUPPORT_HOURS_PER_SITE_YEAR * RATES.supportHour.perUnit) / 12
		: 0;
	return sites * (perSiteInfra() + support) * markup;
}

// no site is sold for less than this a month, whatever the markup says
export const PRICE_FLOOR_PER_SITE = 1;

// dollars a month per site, or null when the plan has no price or no site count to divide by
export function pricePerSite(plan: Plan): number | null {
	const price = plan.monthly.value;
	const sites = figure(plan, 'sites');
	if (price === null || sites === null || sites <= 0) return null;
	return price / sites;
}

// a plan with no site count or no price is not below a floor it cannot be measured against;
// a free plan sells nothing, so the floor does not apply to it
export function belowFloor(plan: Plan): boolean {
	const each = pricePerSite(plan);
	return each !== null && each > 0 && each < PRICE_FLOOR_PER_SITE;
}

// dollars a month a plan leaves after infrastructure at full use; support and everything else is paid from it
export function leftAfterInfra(plan: Plan): number | null {
	const price = plan.monthly.value;
	return price === null ? null : price - monthlyCost(plan).infra;
}

// the largest write allowance, in steps, that keeps a plan inside its target
export function maxWrites(plan: Plan, step = 500_000): number | null {
	const price = plan.monthly.value;
	if (price === null || plan.plane !== 'managed' || figure(plan, 'writes') === null) return null;
	const budget = price === 0 ? FREE_CEILING : price * TARGET_SHARE;
	const cost = monthlyCost(plan);
	const writes = figure(plan, 'writes') ?? 0;
	const others = cost.total - (writes / 1_000_000) * RATES.writeMillion.perUnit;
	const room = budget - others;
	if (room < 0) return 0;
	const units = Math.floor(room / RATES.writeMillion.perUnit / (step / 1_000_000)) * step;
	return units;
}

export interface AddOnMargin {
	id: string;
	// per add-on unit
	price: number;
	cost: number;
	share: number;
}

// the monthly subscription price, else the smallest pack's price per unit
export function addOnMargin(addOn: AddOn): AddOnMargin | null {
	const cost = addOn.unitCost.value;
	if (cost === null || cost <= 0) return null;
	const monthly = addOn.recurring?.monthly.value ?? null;
	const pack = addOn.packs[0];
	const packPrice = pack?.price.value ?? null;
	const price = monthly ?? (packPrice === null || !pack ? null : packPrice / pack.units);
	if (price === null || price <= 0) return null;
	return { id: addOn.id, price, cost, share: cost / price };
}

const money = (value: number) => `$${value.toFixed(2)}`;
const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

export function planTable(): string {
	const rows = PLANS.map((plan) => {
		const margin = planMargin(plan);
		const writes = maxWrites(plan);
		return [
			plan.id,
			margin.price === null ? '-' : money(margin.price),
			money(margin.cost.total),
			money(margin.cost.infra),
			percent(margin.share),
			margin.verdict,
			writes === null ? '-' : String(writes),
			margin.cost.unstated.join(' ') || '-'
		].join(' | ');
	});
	return ['plan | price | cost | infra | share | verdict | max writes | unstated', ...rows].join(
		'\n'
	);
}

export function addOnTable(): string {
	const rows = ADD_ONS.flatMap((addOn) => {
		const margin = addOnMargin(addOn);
		if (!margin) return [];
		return [
			[addOn.id, money(margin.price), money(margin.cost), percent(margin.share)].join(' | ')
		];
	});
	return ['add-on | price | cost | share', ...rows].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(planTable());
	console.log();
	console.log(addOnTable());
}
