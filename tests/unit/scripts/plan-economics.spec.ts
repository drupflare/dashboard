import { describe, expect, it } from 'vitest';
import {
	FREE_CEILING,
	PRICE_FLOOR_PER_SITE,
	RATES,
	SUPPORT_HOURS_PER_SITE_YEAR,
	TARGET_SHARE,
	TYPICAL_STORAGE_GB,
	TYPICAL_VIEWS,
	addOnMargin,
	belowFloor,
	costPlusPrice,
	hoursAffordable,
	keepsWarm,
	leftAfterInfra,
	maxWrites,
	monthlyCost,
	planMargin,
	pricePerSite,
	typicalCost
} from '../../../scripts/economics/plans';
import { ADD_ONS, PLANS, findAddOn, findPlan, type Plan } from '../../../src/shared/plans';

const figure = (value: number | null) => ({ value, label: 'assumption', source: 'test' });

const base = findPlan('managed-pro') as Plan;

// one site and nothing else metered
const bare = {
	sites: figure(1),
	views: figure(0),
	writes: figure(0),
	storageGb: figure(0),
	backupGb: figure(0)
};

const fixture = (over: Record<string, unknown> = {}): Plan =>
	({
		...base,
		monthly: figure(40),
		sites: figure(2),
		views: figure(2_000_000),
		storageGb: figure(5),
		writes: figure(1_000_000),
		backupGb: figure(10),
		mailSends: figure(0),
		containerHours: figure(0),
		supportHoursPerYear: figure(0),
		...over
	}) as Plan;

describe('monthly cost of a plan', () => {
	it('adds each meter at its rate', () => {
		const { lines, total, infra } = monthlyCost(fixture());
		expect(lines.sites).toBeCloseTo(2 * RATES.siteMonth.perUnit, 9);
		expect(lines.views).toBeCloseTo(2 * RATES.viewMillion.perUnit, 9);
		expect(lines.writes).toBeCloseTo(RATES.writeMillion.perUnit, 9);
		expect(lines.storage).toBeCloseTo(5 * RATES.storageGbMonth.perUnit, 9);
		expect(lines.backup).toBeCloseTo(10 * RATES.backupGbMonth.perUnit, 9);
		expect(infra).toBeCloseTo(total, 9);
	});

	it('prices bundled hours by the month at the loaded rate', () => {
		const { lines, total, infra } = monthlyCost(fixture({ supportHoursPerYear: figure(24) }));
		expect(lines.support).toBeCloseTo(2 * RATES.supportHour.perUnit, 9);
		expect(infra).toBeCloseTo(total - lines.support, 9);
	});

	it('leaves the customer-account meters out of a self-managed plan', () => {
		const { lines } = monthlyCost(fixture({ plane: 'self-managed' }));
		expect(lines.sites).toBe(0);
		expect(lines.views).toBe(0);
		expect(lines.writes).toBe(0);
		expect(lines.storage).toBe(0);
		expect(lines.backup).toBeCloseTo(10 * RATES.backupGbMonth.perUnit, 9);
	});

	it('names the figures a plan leaves unstated, so the total reads as a floor', () => {
		const { unstated } = monthlyCost(fixture({ writes: figure(null), backupGb: figure(null) }));
		expect(unstated).toEqual(['writes', 'backupGb']);
	});

	it('does not call an unlimited figure unstated', () => {
		const unlimited = { value: null, unlimited: true, label: 'assumption', source: 'test' };
		const { unstated } = monthlyCost(fixture({ sites: unlimited }));
		expect(unstated).toEqual([]);
	});
});

describe('warm and sleeping sites', () => {
	it('keeps a paid plan warm and lets a free plan sleep', () => {
		expect(keepsWarm(fixture())).toBe(true);
		expect(keepsWarm(fixture({ monthly: figure(0) }))).toBe(false);
		expect(keepsWarm(fixture({ monthly: figure(null) }))).toBe(false);
	});

	it('costs a sleeping site no warming chain', () => {
		const warm = monthlyCost(fixture()).lines.sites;
		const asleep = monthlyCost(fixture({ monthly: figure(0) })).lines.sites;
		expect(warm).toBeCloseTo(2 * RATES.siteMonth.perUnit, 9);
		expect(asleep).toBe(0);
	});
});

describe('price floor per site', () => {
	it('divides the monthly price by the sites', () => {
		expect(pricePerSite(fixture({ monthly: figure(12), sites: figure(4) }))).toBe(3);
	});

	it('has no figure without a price or a site count', () => {
		expect(pricePerSite(fixture({ monthly: figure(null) }))).toBeNull();
		expect(pricePerSite(fixture({ sites: figure(null) }))).toBeNull();
		expect(pricePerSite(fixture({ sites: figure(0) }))).toBeNull();
	});

	it('flags a paid plan under the floor and nothing else', () => {
		const under = fixture({
			monthly: figure(PRICE_FLOOR_PER_SITE * 2 - 0.5),
			sites: figure(2)
		});
		const at = fixture({ monthly: figure(PRICE_FLOOR_PER_SITE * 2), sites: figure(2) });
		expect(belowFloor(under)).toBe(true);
		expect(belowFloor(at)).toBe(false);
		expect(belowFloor(fixture({ monthly: figure(0) }))).toBe(false);
		expect(belowFloor(fixture({ sites: figure(null) }))).toBe(false);
	});
});

describe('plan margins', () => {
	it('divides cost by price', () => {
		const plan = fixture();
		const margin = planMargin(plan);
		expect(margin.share).toBeCloseTo(monthlyCost(plan).total / 40, 9);
	});

	it('reads the annual price per month', () => {
		const plan = fixture({ annual: figure(240) });
		expect(planMargin(plan, 'year').price).toBe(20);
	});

	it('calls a plan over when its cost passes the target share', () => {
		const cost = monthlyCost(fixture()).total;
		expect(planMargin(fixture({ monthly: figure(cost / TARGET_SHARE + 1) })).verdict).toBe(
			'ok'
		);
		expect(planMargin(fixture({ monthly: figure(cost / TARGET_SHARE - 1) })).verdict).toBe(
			'over'
		);
	});

	it('judges a free plan against the cost ceiling, not a share', () => {
		const cheap = fixture({ monthly: figure(0), ...bare });
		const heavy = fixture({ monthly: figure(0), writes: figure(FREE_CEILING * 2_000_000) });
		expect(planMargin(cheap).share).toBeNull();
		expect(planMargin(cheap).verdict).toBe('ok');
		expect(planMargin(heavy).verdict).toBe('over');
	});

	it('reports no price for a plan without one', () => {
		expect(planMargin(fixture({ monthly: figure(null) })).verdict).toBe('no price');
	});

	it('refuses to call a managed plan with no stated sites free', () => {
		expect(planMargin(fixture({ sites: figure(null) })).verdict).toBe('no figures');
	});
});

describe('bundled support hours', () => {
	it('refuses hours the plan cannot carry inside the target', () => {
		const hours = figure(12 * 100);
		expect(hoursAffordable(fixture({ supportHoursPerYear: hours }))).toBe(false);
	});

	it('allows hours the plan can carry', () => {
		const roomy = fixture({ monthly: figure(1000), supportHoursPerYear: figure(24) });
		expect(hoursAffordable(roomy)).toBe(true);
	});

	it('refuses a figure below the smallest pack, which no customer could spend', () => {
		const roomy = fixture({ monthly: figure(1000), supportHoursPerYear: figure(0.5) });
		expect(hoursAffordable(roomy)).toBe(false);
	});

	it('refuses hours on a plan with no price to carry them', () => {
		expect(
			hoursAffordable(fixture({ monthly: figure(0), supportHoursPerYear: figure(1) }))
		).toBe(false);
	});

	it('has nothing to refuse on a plan with no hours', () => {
		expect(hoursAffordable(fixture({ monthly: figure(0) }))).toBe(true);
	});
});

describe('typical cost of a plan', () => {
	it('is the per-site cost times the sites', () => {
		const perSite =
			RATES.siteMonth.perUnit +
			(TYPICAL_VIEWS / 1_000_000) * RATES.viewMillion.perUnit +
			TYPICAL_STORAGE_GB * RATES.storageGbMonth.perUnit;
		expect(typicalCost(fixture())).toBeCloseTo(2 * perSite, 9);
	});

	it('has no figure off the managed plane or with no site count', () => {
		expect(typicalCost(fixture({ plane: 'self-managed' }))).toBeNull();
		expect(typicalCost(fixture({ sites: figure(null) }))).toBeNull();
	});
});

describe('cost plus price', () => {
	it('scales with sites and markup', () => {
		expect(costPlusPrice(4, 3)).toBeCloseTo(12 * costPlusPrice(1, 1), 9);
	});

	it('is the typical infrastructure alone when the plan bundles no hours', () => {
		expect(costPlusPrice(1, 1)).toBeCloseTo(typicalCost(fixture({ sites: figure(1) })) ?? 0, 9);
	});

	it('adds the support time when the plan bundles hours', () => {
		const support = (SUPPORT_HOURS_PER_SITE_YEAR * RATES.supportHour.perUnit) / 12;
		expect(costPlusPrice(1, 1, true)).toBeCloseTo(costPlusPrice(1, 1) + support, 9);
	});
});

describe('what a plan leaves after infrastructure', () => {
	it('is the price less infrastructure at full use', () => {
		const plan = fixture();
		expect(leftAfterInfra(plan)).toBeCloseTo(40 - monthlyCost(plan).infra, 9);
	});

	it('has no figure for a plan with no price', () => {
		expect(leftAfterInfra(fixture({ monthly: figure(null) }))).toBeNull();
	});
});

describe('write allowance sizing', () => {
	it('returns the largest allowance that stays inside the target', () => {
		const step = 500_000;
		const plan = fixture();
		const writes = maxWrites(plan, step) ?? 0;
		const at = (count: number) => planMargin(fixture({ writes: figure(count) })).verdict;
		expect(at(writes)).toBe('ok');
		expect(at(writes + step)).toBe('over');
	});

	it('sizes a free plan against the cost ceiling', () => {
		const free = { monthly: figure(0), ...bare };
		const writes = maxWrites(fixture(free)) ?? 0;
		expect(writes).toBeGreaterThan(0);
		expect(planMargin(fixture({ ...free, writes: figure(writes) })).verdict).toBe('ok');
		expect(planMargin(fixture({ ...free, writes: figure(writes + 500_000) })).verdict).toBe(
			'over'
		);
	});

	it('has nothing to size off the managed plane or with no writes figure', () => {
		expect(maxWrites(fixture({ plane: 'self-managed' }))).toBeNull();
		expect(maxWrites(fixture({ writes: figure(null) }))).toBeNull();
	});

	it('answers zero when the other meters already use the budget', () => {
		expect(maxWrites(fixture({ sites: figure(500) }))).toBe(0);
	});
});

describe('add-on margins', () => {
	const hours = findAddOn('support-hours') as NonNullable<ReturnType<typeof findAddOn>>;

	it('divides unit cost by the monthly price', () => {
		const monthly = hours.recurring?.monthly.value ?? 0;
		expect(addOnMargin(hours)?.share).toBeCloseTo((hours.unitCost.value ?? 0) / monthly, 9);
	});

	it('falls back to the smallest pack, per unit, when there is no subscription', () => {
		const packOnly = { ...hours, recurring: null };
		const pack = hours.packs[0];
		expect(addOnMargin(packOnly)?.price).toBeCloseTo(
			(pack?.price.value ?? 0) / (pack?.units ?? 1),
			9
		);
	});

	it('skips an add-on with no cost basis or no price', () => {
		const noCost = { ...hours, unitCost: { ...hours.unitCost, value: null } };
		const noPrice = { ...hours, recurring: null, packs: [] };
		expect(addOnMargin(noCost)).toBeNull();
		expect(addOnMargin(noPrice)).toBeNull();
	});
});

describe('shipped catalogue margins', () => {
	it('keeps Self-Managed Plus inside the target share at full use', () => {
		const { share } = planMargin(findPlan('self-managed-plus') as Plan);
		expect(share).not.toBeNull();
		expect(share as number).toBeLessThanOrEqual(TARGET_SHARE);
	});

	it('lists no plan below the one-dollar floor per site', () => {
		for (const row of PLANS) expect(belowFloor(row), row.id).toBe(false);
	});

	it('lists every add-on that adds sites at or above the floor per site', () => {
		for (const row of ADD_ONS) {
			if (row.meter !== 'sites' || row.recurring === null) continue;
			expect(row.recurring.monthly.value ?? 0, row.id).toBeGreaterThanOrEqual(
				PRICE_FLOOR_PER_SITE * row.grants
			);
		}
	});
});
