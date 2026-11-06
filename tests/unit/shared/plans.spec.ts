import { describe, expect, it } from 'vitest';
import {
	describePlan,
	FIGURE_LABELS,
	figureSchema,
	findPlan,
	intervalPrice,
	INTERVALS,
	PLAN_REVIEW,
	planFromPriceKey,
	planPricesVisible,
	PLANS,
	priceLookupKey,
	priceVisible,
	reviewSchema,
	type Plan
} from '../../../src/shared/plans';

type Figure = { value: number | null; label?: string; source: string };

function figuresOf(plan: Record<string, unknown>): Array<[string, Figure]> {
	return Object.entries(plan).filter(
		(entry): entry is [string, Figure] =>
			typeof entry[1] === 'object' && entry[1] !== null && 'source' in entry[1]
	);
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

	it('uses the four labels from the plan', () => {
		expect([...FIGURE_LABELS]).toEqual(['published', 'measured', 'derived', 'assumption']);
	});
});

describe('shipped plan catalogue', () => {
	it('parses every row of the roadmap plan table', () => {
		expect(PLANS.map((plan) => plan.id)).toEqual([
			'self-hosted',
			'self-managed',
			'self-managed-dashboard',
			'managed-free',
			'managed-site',
			'managed-studio',
			'managed-agency',
			'institution-starter',
			'institution-standard',
			'assurance',
			'enterprise',
			'gmux-compute'
		]);
	});

	it('labels every number and nulls every unknown with a source', () => {
		for (const plan of PLANS) {
			for (const [key, figure] of figuresOf(plan)) {
				expect(figureSchema.safeParse(figure).success, `${plan.id}.${key}`).toBe(true);
				if (figure.value !== null) {
					expect(FIGURE_LABELS).toContain(figure.label);
				}
			}
		}
	});

	it('keeps the roadmap prices for the managed tiers', () => {
		const site = PLANS.find((plan) => plan.id === 'managed-site');
		const studio = PLANS.find((plan) => plan.id === 'managed-studio');
		const agency = PLANS.find((plan) => plan.id === 'managed-agency');
		expect([site?.monthly.value, site?.annual.value]).toEqual([18, 180]);
		expect([studio?.monthly.value, studio?.annual.value]).toEqual([59, 588]);
		expect([agency?.monthly.value, agency?.annual.value]).toEqual([449, 4500]);
	});

	it('leaves the enterprise annual price null because it is a contract', () => {
		const enterprise = PLANS.find((plan) => plan.id === 'enterprise');
		expect(enterprise?.annual.value).toBe(null);
		expect(enterprise?.monthly.value).toBe(5499);
	});

	it('ships unreviewed with no price visible', () => {
		expect(PLAN_REVIEW).toEqual({ reviewed: false, reviewNote: null });
		expect(priceVisible()).toBe(false);
	});

	it('shows a price only once the review flag is set with a note', () => {
		expect(priceVisible({ reviewed: true, reviewNote: 'test fixture' })).toBe(true);
	});
});

describe('price visibility', () => {
	const site = PLANS.find((plan) => plan.id === 'managed-site') as Plan;
	const REVIEWED = { reviewed: true, reviewNote: 'test fixture' };

	it('marks every row unreviewed', () => {
		for (const plan of PLANS) expect(plan.unreviewed, plan.id).toBe(true);
	});

	it('never shows a price to a non-admin while any review flag is open', () => {
		for (const plan of PLANS) {
			expect(planPricesVisible(plan, { admin: false }), plan.id).toBe(false);
			// a reviewed catalogue still hides a row whose own flag is open
			expect(planPricesVisible(plan, { admin: false }, REVIEWED), plan.id).toBe(false);
			const shown = describePlan(plan, { admin: false }, REVIEWED);
			expect('monthly' in shown || 'annual' in shown, plan.id).toBe(false);
			expect(JSON.stringify(shown)).not.toMatch(/"(monthly|annual)"/);
		}
	});

	it('shows a price once the catalogue and the row are both reviewed', () => {
		const reviewed = { ...site, unreviewed: false };
		expect(planPricesVisible(reviewed, { admin: false })).toBe(false);
		expect(planPricesVisible(reviewed, { admin: false }, REVIEWED)).toBe(true);
		expect(describePlan(reviewed, { admin: false }, REVIEWED)).toMatchObject({ monthly: 18 });
	});

	it('shows an admin every price with the review flag', () => {
		expect(describePlan(site, { admin: true })).toMatchObject({
			monthly: 18,
			annual: 180,
			unreviewed: true
		});
	});

	it('hides the price of a disabled row from a non-admin even when reviewed', () => {
		const gmux = { ...(PLANS.find((plan) => plan.id === 'gmux-compute') as Plan) };
		expect(gmux.disabled).toBe(true);
		expect(planPricesVisible({ ...gmux, unreviewed: false }, { admin: false }, REVIEWED)).toBe(
			false
		);
	});
});

describe('self-managed with the dashboard', () => {
	it('records no price, because the roadmap records none', () => {
		const row = PLANS.find((plan) => plan.id === 'self-managed-dashboard') as Plan;
		expect(row.monthly.value).toBeNull();
		expect(row.annual.value).toBeNull();
		expect(row.dashboard).toBe(true);
		expect(PLANS.find((plan) => plan.id === 'self-managed')?.dashboard).toBe(false);
	});
});

describe('stripe lookup keys', () => {
	it('gives every plan and interval a distinct price key that maps back', () => {
		const keys = new Set<string>();
		for (const plan of PLANS) {
			for (const interval of INTERVALS) {
				const key = priceLookupKey(plan, interval);
				keys.add(key);
				expect(planFromPriceKey(key)).toEqual({ plan, interval });
			}
		}
		expect(keys.size).toBe(PLANS.length * 2);
		expect(planFromPriceKey('nothing')).toBeUndefined();
	});

	it('finds a plan by id and reads an interval price', () => {
		expect(findPlan('managed-studio')?.name).toBe('Managed Studio');
		expect(findPlan('nope')).toBeUndefined();
		const studio = findPlan('managed-studio') as Plan;
		expect([intervalPrice(studio, 'month'), intervalPrice(studio, 'year')]).toEqual([59, 588]);
	});

	it('allows a custom Worker only on a paid row', () => {
		for (const plan of PLANS) {
			if (plan.customCode === true)
				expect(plan.monthly.value ?? 0, plan.id).toBeGreaterThan(0);
		}
	});
});

describe('reviewSchema', () => {
	it('refuses reviewed without a review note', () => {
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: null }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: '' }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: false, reviewNote: null }).success).toBe(true);
	});
});
