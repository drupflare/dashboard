import { describe, expect, it } from 'vitest';
import {
	FIGURE_LABELS,
	figureSchema,
	PLAN_REVIEW,
	PLANS,
	priceVisible,
	reviewSchema
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

describe('reviewSchema', () => {
	it('refuses reviewed without a review note', () => {
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: null }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: true, reviewNote: '' }).success).toBe(false);
		expect(reviewSchema.safeParse({ reviewed: false, reviewNote: null }).success).toBe(true);
	});
});
