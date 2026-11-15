import { describe, expect, it } from 'vitest';
import {
	ADD_ONS,
	FIGURE_LABELS,
	INTERVALS,
	METER_IDS,
	PLANS,
	PLAN_REVIEW,
	SUPPORT_LEVELS,
	addOnOffered,
	describeAddOn,
	describePlan,
	figureSchema,
	findAddOn,
	findPlan,
	intervalPrice,
	offerFromPriceKey,
	packLookupKey,
	planFromPriceKey,
	planPricesVisible,
	priceLookupKey,
	priceVisible,
	reviewSchema,
	type AddOn,
	type Plan
} from '../../../src/shared/plans';

type Figure = { value: number | null; label?: string; source: string };

const REVIEWED = { reviewed: true, reviewNote: 'test fixture' };

const plan = (id: string): Plan => {
	const found = findPlan(id);
	if (!found) throw new Error(`no plan ${id}`);
	return found;
};

const addOn = (id: string): AddOn => {
	const found = findAddOn(id);
	if (!found) throw new Error(`no add-on ${id}`);
	return found;
};

function figuresOf(row: Record<string, unknown>): Array<[string, Figure]> {
	return Object.entries(row).filter(
		(entry): entry is [string, Figure] =>
			typeof entry[1] === 'object' &&
			entry[1] !== null &&
			'source' in entry[1] &&
			'value' in entry[1]
	);
}

function addOnFigures(row: AddOn): Array<[string, Figure]> {
	const out: Array<[string, Figure]> = [['unitCost', row.unitCost as Figure]];
	if (row.recurring !== null) {
		out.push(
			['monthly', row.recurring.monthly as Figure],
			['annual', row.recurring.annual as Figure]
		);
	}
	for (const pack of row.packs) out.push([`pack ${pack.units}`, pack.price as Figure]);
	return out;
}

describe('figureSchema', () => {
	it('requires a label on every number', () => {
		expect(
			figureSchema.safeParse({ value: 18, label: 'derived', source: 'roadmap:260' }).success
		).toBe(true);
		expect(figureSchema.safeParse({ value: 18, source: 'roadmap:260' }).success).toBe(false);
		expect(figureSchema.safeParse({ value: 18, label: 'guess', source: 'x' }).success).toBe(
			false
		);
	});

	it('allows null only with a source saying why the figure is unknown', () => {
		expect(
			figureSchema.safeParse({ value: null, source: 'roadmap:266 contract' }).success
		).toBe(true);
		expect(figureSchema.safeParse({ value: null }).success).toBe(false);
	});

	it('allows an unlimited figure only as null with a source', () => {
		expect(figureSchema.safeParse({ value: null, unlimited: true, source: 'x' }).success).toBe(
			true
		);
		expect(figureSchema.safeParse({ value: null, unlimited: true }).success).toBe(false);
	});

	it('uses the four labels from the plan', () => {
		expect([...FIGURE_LABELS]).toEqual(['published', 'measured', 'derived', 'assumption']);
	});
});

describe('shipped plan catalogue', () => {
	it('lists the plans in ladder order', () => {
		expect(PLANS.map((row) => row.id)).toEqual([
			'self-hosted',
			'self-managed',
			'self-managed-plus',
			'managed-free',
			'managed-pro',
			'managed-agency',
			'institution-starter',
			'institution-standard',
			'enterprise'
		]);
	});

	it('puts each plan on its plane', () => {
		expect(PLANS.map((row) => [row.id, row.plane])).toEqual([
			['self-hosted', 'self-hosted'],
			['self-managed', 'self-managed'],
			['self-managed-plus', 'self-managed'],
			['managed-free', 'managed'],
			['managed-pro', 'managed'],
			['managed-agency', 'managed'],
			['institution-starter', 'managed'],
			['institution-standard', 'managed'],
			['enterprise', 'managed']
		]);
	});

	it('labels every number and nulls every unknown with a source', () => {
		for (const row of PLANS) {
			for (const [key, figure] of figuresOf(row)) {
				expect(figureSchema.safeParse(figure).success, `${row.id}.${key}`).toBe(true);
				if (figure.value !== null) expect(FIGURE_LABELS).toContain(figure.label);
			}
		}
	});

	it('keeps every price a finite, non-negative number', () => {
		for (const row of PLANS) {
			for (const price of [row.monthly.value, row.annual.value]) {
				if (price === null) continue;
				expect(Number.isFinite(price), row.id).toBe(true);
				expect(price, row.id).toBeGreaterThanOrEqual(0);
				expect(price, row.id).toBeLessThan(1_000_000);
			}
		}
	});

	it('leaves the enterprise annual price null because it is a contract', () => {
		expect(plan('enterprise').annual.value).toBe(null);
	});

	it('leaves the self planes unlimited and the enterprise site count unstated', () => {
		for (const id of ['self-hosted', 'self-managed', 'self-managed-plus']) {
			expect(plan(id).sites, id).toMatchObject({ value: null, unlimited: true });
		}
		expect(plan('enterprise').sites).not.toHaveProperty('unlimited');
	});

	it('gives Self-Managed Plus a mail credit', () => {
		expect(plan('self-managed-plus').mailSends.value).toBeGreaterThan(0);
	});

	it('includes support hours only on a plan that has a price', () => {
		for (const row of PLANS) {
			if ((row.supportHoursPerYear.value ?? 0) > 0) {
				expect(row.monthly.value ?? 0, row.id).toBeGreaterThan(0);
			}
		}
	});

	it('allows a custom Worker on the shared namespace only on a paid managed row', () => {
		for (const row of PLANS) {
			if (row.plane === 'managed' && row.customCode === true) {
				expect(row.monthly.value ?? 0, row.id).toBeGreaterThan(0);
			}
		}
		expect(plan('managed-free').customCode).toBe(false);
	});

	it('ships unreviewed with no price visible', () => {
		expect(PLAN_REVIEW).toEqual({ reviewed: false, reviewNote: null });
		expect(priceVisible()).toBe(false);
		for (const row of PLANS) expect(row.unreviewed, row.id).toBe(true);
		for (const row of ADD_ONS) expect(row.unreviewed, row.id).toBe(true);
	});

	it('shows a price only once the review flag is set with a note', () => {
		expect(priceVisible(REVIEWED)).toBe(true);
	});

	it('uses only known support levels', () => {
		for (const row of PLANS) expect(SUPPORT_LEVELS).toContain(row.supportLevel);
	});
});

describe('add-on catalogue', () => {
	it('lists the add-ons in catalogue order', () => {
		expect(ADD_ONS.map((row) => row.id)).toEqual([
			'support-hours',
			'support-core',
			'support-business',
			'support-critical',
			'domain',
			'container-hours',
			'backup-storage',
			'mail-sends',
			'extra-site',
			'site-block-agency',
			'site-block-standard',
			'views',
			'writes',
			'storage',
			'hostnames',
			'invitees',
			'assurance'
		]);
	});

	it('labels every number and nulls every unknown with a source', () => {
		for (const row of ADD_ONS) {
			for (const [key, figure] of addOnFigures(row)) {
				expect(figureSchema.safeParse(figure).success, `${row.id}.${key}`).toBe(true);
				if (figure.value !== null) expect(FIGURE_LABELS).toContain(figure.label);
			}
		}
	});

	it('gives every add-on a distinct lookup key and a known meter', () => {
		const keys = ADD_ONS.map((row) => row.lookupKey);
		expect(new Set(keys).size).toBe(keys.length);
		for (const row of ADD_ONS) {
			expect(METER_IDS).toContain(row.meter);
			expect(row.lookupKey).toMatch(/^drupflare_addon_[a-z_]+$/);
		}
	});

	it('sells every add-on as a subscription, a pack or both', () => {
		for (const row of ADD_ONS) {
			expect(row.recurring !== null || row.packs.length > 0, row.id).toBe(true);
		}
	});

	it('never prices a year above twelve months', () => {
		for (const row of ADD_ONS) {
			const recurring = row.recurring;
			if (recurring === null) continue;
			const { monthly, annual } = recurring;
			if (monthly.value === null || annual.value === null) continue;
			expect(annual.value, row.id).toBeLessThanOrEqual(monthly.value * 12);
		}
	});

	it('keeps every add-on price a finite, non-negative number', () => {
		for (const row of ADD_ONS) {
			const prices = [
				row.recurring?.monthly.value,
				row.recurring?.annual.value,
				...row.packs.map((pack) => pack.price.value)
			];
			for (const price of prices) {
				if (price === null || price === undefined) continue;
				expect(Number.isFinite(price), row.id).toBe(true);
				expect(price, row.id).toBeGreaterThanOrEqual(0);
				expect(price, row.id).toBeLessThan(1_000_000);
			}
		}
	});

	it('adds what one unit grants in the meter unit', () => {
		expect(addOn('support-hours').grants).toBe(12);
		expect(addOn('container-hours').grants).toBe(10);
		expect(addOn('mail-sends').grants).toBe(10000);
		expect(addOn('extra-site').grants).toBe(1);
		expect(addOn('site-block-agency').grants).toBe(50);
		expect(addOn('domain').grants).toBe(0);
	});

	it('holds back an add-on that cannot be sold yet, with the reason', () => {
		const held = ADD_ONS.filter((row) => !row.available).map((row) => row.id);
		expect(held).toEqual(['support-critical', 'domain']);
		for (const row of ADD_ONS) {
			expect(row.availableNote === null, row.id).toBe(row.available);
		}
	});

	it('records a support level only on the support-level meter', () => {
		for (const row of ADD_ONS) {
			expect(row.supportLevel !== null, row.id).toBe(row.meter === 'support-level');
		}
	});

	it('finds an add-on by id', () => {
		expect(findAddOn('extra-site')?.name).toBe('Extra Site');
		expect(findAddOn('nope')).toBeUndefined();
	});
});

describe('which add-ons a plan is offered', () => {
	it('offers the extra site only to Managed Pro', () => {
		const extra = addOn('extra-site');
		const offered = PLANS.filter((row) => addOnOffered(extra, row)).map((row) => row.id);
		expect(offered).toEqual(['managed-pro']);
	});

	it('offers a site block to the one plan it extends', () => {
		const agency = PLANS.filter((row) => addOnOffered(addOn('site-block-agency'), row));
		const standard = PLANS.filter((row) => addOnOffered(addOn('site-block-standard'), row));
		expect(agency.map((row) => row.id)).toEqual(['managed-agency']);
		expect(standard.map((row) => row.id)).toEqual(['institution-standard']);
	});

	it('offers assurance only to Institution Standard', () => {
		const offered = PLANS.filter((row) => addOnOffered(addOn('assurance'), row));
		expect(offered.map((row) => row.id)).toEqual(['institution-standard']);
	});

	it('offers support hours on every plan', () => {
		for (const row of PLANS)
			expect(addOnOffered(addOn('support-hours'), row), row.id).toBe(true);
	});

	it('keeps managed-only meters off the self planes', () => {
		for (const id of ['views', 'writes', 'storage', 'hostnames', 'invitees']) {
			for (const row of PLANS.filter((candidate) => candidate.plane !== 'managed')) {
				expect(addOnOffered(addOn(id), row), `${id} on ${row.id}`).toBe(false);
			}
			expect(addOnOffered(addOn(id), plan('managed-pro')), id).toBe(true);
		}
	});

	it('keeps the domain off a self-hosted box and allows container hours on a hosted plane', () => {
		expect(addOnOffered(addOn('domain'), plan('self-hosted'))).toBe(false);
		expect(addOnOffered(addOn('domain'), plan('self-managed'))).toBe(true);
		expect(addOnOffered(addOn('container-hours'), plan('self-hosted'))).toBe(false);
		expect(addOnOffered(addOn('container-hours'), plan('self-managed-plus'))).toBe(true);
	});

	it('sells a support level only to plans below it', () => {
		expect(addOnOffered(addOn('support-core'), plan('managed-free'))).toBe(true);
		expect(addOnOffered(addOn('support-core'), plan('managed-pro'))).toBe(false);
		expect(addOnOffered(addOn('support-business'), plan('managed-pro'))).toBe(true);
		expect(addOnOffered(addOn('support-business'), plan('institution-starter'))).toBe(false);
	});
});

describe('price visibility', () => {
	const pro = plan('managed-pro');

	it('never shows a price to a non-admin while any review flag is open', () => {
		for (const row of PLANS) {
			expect(planPricesVisible(row, { admin: false }), row.id).toBe(false);
			// a reviewed catalogue still hides a row whose own flag is open
			expect(planPricesVisible(row, { admin: false }, REVIEWED), row.id).toBe(false);
			const shown = describePlan(row, { admin: false }, REVIEWED);
			expect(JSON.stringify(shown), row.id).not.toMatch(/"(monthly|annual)"/);
		}
		for (const row of ADD_ONS) {
			expect(planPricesVisible(row, { admin: false }, REVIEWED), row.id).toBe(false);
			expect(
				JSON.stringify(describeAddOn(row, { admin: false }, REVIEWED)),
				row.id
			).not.toMatch(/"(monthly|annual|packs)"/);
		}
	});

	it('shows a price once the catalogue and the row are both reviewed', () => {
		const reviewed = { ...pro, unreviewed: false };
		expect(planPricesVisible(reviewed, { admin: false })).toBe(false);
		expect(planPricesVisible(reviewed, { admin: false }, REVIEWED)).toBe(true);
		expect(describePlan(reviewed, { admin: false }, REVIEWED)).toMatchObject({
			monthly: pro.monthly.value
		});
	});

	it('shows an admin every price with the review flag', () => {
		expect(describePlan(pro, { admin: true })).toMatchObject({
			monthly: pro.monthly.value,
			annual: pro.annual.value,
			unreviewed: true
		});
		const hours = addOn('support-hours');
		expect(describeAddOn(hours, { admin: true })).toMatchObject({
			monthly: hours.recurring?.monthly.value,
			annual: hours.recurring?.annual.value,
			unreviewed: true
		});
	});

	it('hides the price of an unavailable add-on from a non-admin even when reviewed', () => {
		const held = { ...addOn('support-critical'), unreviewed: false };
		expect(planPricesVisible(held, { admin: false }, REVIEWED)).toBe(false);
		const open = { ...addOn('support-hours'), unreviewed: false };
		expect(planPricesVisible(open, { admin: false }, REVIEWED)).toBe(true);
	});

	it('hides the price of a disabled plan from a non-admin even when reviewed', () => {
		const disabled = { ...pro, unreviewed: false, disabled: true };
		expect(planPricesVisible(disabled, { admin: false }, REVIEWED)).toBe(false);
	});
});

describe('describing a plan and an add-on', () => {
	it('reports unlimited sites as a flag with no number', () => {
		const shown = describePlan(plan('self-managed'), { admin: false });
		expect(shown).toMatchObject({ sites: null, sitesUnlimited: true, plane: 'self-managed' });
		const free = plan('managed-free');
		expect(describePlan(free, { admin: false })).toMatchObject({
			sites: free.sites.value,
			sitesUnlimited: false
		});
	});

	it('lists what a plan includes without a price', () => {
		const pro = plan('managed-pro');
		expect(describePlan(pro, { admin: false })).toMatchObject({
			views: pro.views.value,
			supportHoursPerYear: pro.supportHoursPerYear.value,
			included: {
				storageGb: pro.storageGb.value,
				writes: pro.writes.value,
				backupGb: pro.backupGb.value,
				mailSends: pro.mailSends.value,
				containerHours: pro.containerHours.value,
				invitees: pro.invitees.value,
				customDomains: pro.customDomains.value,
				backupDays: pro.backupDays.value
			}
		});
	});

	it('describes an add-on as a subscription, a pack or both', () => {
		const hours = describeAddOn(addOn('support-hours'), { admin: false });
		expect(hours).toMatchObject({ subscription: true, packSizes: [1, 5, 10, 20], grants: 12 });
		expect(describeAddOn(addOn('domain'), { admin: false })).toMatchObject({
			subscription: false,
			packSizes: [1],
			available: false
		});
		expect(describeAddOn(addOn('extra-site'), { admin: false })).toMatchObject({
			subscription: true,
			packSizes: [],
			requires: ['managed-pro']
		});
	});

	it('gives an admin the pack prices, with null for an unknown one', () => {
		const hours = addOn('support-hours');
		expect(describeAddOn(hours, { admin: true })).toMatchObject({
			packs: hours.packs.map((pack) => ({ units: pack.units, price: pack.price.value }))
		});
		expect(describeAddOn(addOn('domain'), { admin: true })).toMatchObject({
			monthly: null,
			annual: null,
			packs: [{ units: 1, price: null }]
		});
	});
});

describe('stripe lookup keys', () => {
	it('gives every plan and interval a distinct price key that maps back', () => {
		const keys = new Set<string>();
		for (const row of PLANS) {
			for (const interval of INTERVALS) {
				const key = priceLookupKey(row, interval);
				keys.add(key);
				expect(planFromPriceKey(key)).toEqual({ plan: row, interval });
				expect(offerFromPriceKey(key)).toEqual({ kind: 'plan', plan: row, interval });
			}
		}
		expect(keys.size).toBe(PLANS.length * 2);
		expect(planFromPriceKey('nothing')).toBeUndefined();
	});

	it('spells the key with the interval word and the pack size', () => {
		expect(priceLookupKey(plan('managed-pro'), 'month')).toBe('drupflare_managed_pro_monthly');
		expect(priceLookupKey(plan('managed-pro'), 'year')).toBe('drupflare_managed_pro_annual');
		expect(priceLookupKey(addOn('extra-site'), 'year')).toBe(
			'drupflare_addon_extra_site_annual'
		);
		expect(packLookupKey(addOn('support-hours'), 5)).toBe(
			'drupflare_addon_support_hours_pack_5'
		);
	});

	it('maps every add-on price and pack back to its offer', () => {
		const seen = new Set<string>();
		for (const row of ADD_ONS) {
			if (row.recurring !== null) {
				for (const interval of INTERVALS) {
					const key = priceLookupKey(row, interval);
					seen.add(key);
					expect(offerFromPriceKey(key), key).toEqual({
						kind: 'add-on',
						addOn: row,
						interval
					});
				}
			}
			for (const pack of row.packs) {
				const key = packLookupKey(row, pack.units);
				seen.add(key);
				expect(offerFromPriceKey(key), key).toEqual({
					kind: 'pack',
					addOn: row,
					units: pack.units
				});
			}
		}
		const priced = ADD_ONS.reduce(
			(sum, row) => sum + (row.recurring === null ? 0 : 2) + row.packs.length,
			0
		);
		expect(seen.size).toBe(priced);
	});

	it('never maps a key that no price carries', () => {
		expect(offerFromPriceKey('nothing')).toBeUndefined();
		expect(offerFromPriceKey('drupflare_addon_domain_monthly')).toBeUndefined();
		expect(offerFromPriceKey('drupflare_addon_support_hours_pack_7')).toBeUndefined();
	});

	it('finds a plan by id and reads an interval price', () => {
		expect(findPlan('managed-pro')?.name).toBe('Managed Pro');
		expect(findPlan('nope')).toBeUndefined();
		const pro = plan('managed-pro');
		expect([intervalPrice(pro, 'month'), intervalPrice(pro, 'year')]).toEqual([
			pro.monthly.value,
			pro.annual.value
		]);
		const hostnames = addOn('hostnames');
		expect([intervalPrice(hostnames, 'month'), intervalPrice(hostnames, 'year')]).toEqual([
			hostnames.recurring?.monthly.value,
			hostnames.recurring?.annual.value
		]);
		expect(intervalPrice(addOn('domain'), 'month')).toBeNull();
		expect(intervalPrice(plan('enterprise'), 'year')).toBeNull();
	});
});

describe('reviewSchema', () => {
	it('refuses reviewed without a review note', () => {
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: null }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: '' }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: false, reviewNote: null }).success).toBe(true);
	});
});
