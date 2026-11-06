import { describe, expect, it, vi } from 'vitest';
import { OVERAGE_METER, buildSyncPlan, renderSyncPlan, run } from '../../../scripts/stripe-sync';
import { PLANS } from '../../../src/shared/plans';

describe('stripe-sync dry run', () => {
	const plan = buildSyncPlan();

	it('plans a product with a monthly and an annual price for each priced managed plan', () => {
		const site = plan.products.find((p) => p.planId === 'managed-site');
		expect(site?.prices).toEqual([
			{
				lookupKey: 'drupflare_managed_site_monthly',
				interval: 'month',
				unitAmountCents: 1800,
				unreviewed: true
			},
			{
				lookupKey: 'drupflare_managed_site_annual',
				interval: 'year',
				unitAmountCents: 18000,
				unreviewed: true
			}
		]);
		const agency = plan.products.find((p) => p.planId === 'managed-agency');
		expect(agency?.prices.map((p) => p.unitAmountCents)).toEqual([44900, 450000]);
	});

	it('carries the review flag on every price', () => {
		for (const product of plan.products) {
			for (const price of product.prices)
				expect(price.unreviewed, price.lookupKey).toBe(true);
		}
	});

	it('skips what has no price to create and says why', () => {
		const reasons = Object.fromEntries(plan.skipped.map((row) => [row.planId, row.reason]));
		expect(reasons['gmux-compute']).toBe('disabled');
		expect(reasons.enterprise).toMatch(/contract/);
		expect(reasons['self-managed-dashboard']).toBe('no price in the roadmap');
		expect(reasons['managed-free']).toBe('free; needs no price');
		expect(reasons['self-hosted']).toBe('free; needs no price');
		expect(plan.products.length + plan.skipped.length).toBe(PLANS.length);
	});

	it('plans one overage meter', () => {
		expect(plan.meters).toEqual([OVERAGE_METER]);
	});

	it('prints what it would create and says nothing was created', () => {
		const text = renderSyncPlan(plan);
		expect(text).toContain('dry run');
		expect(text).toContain(
			'price drupflare_managed_site_monthly: $18.00 per month (unreviewed)'
		);
		expect(text).toContain('skipped gmux-compute: disabled');
		expect(text).toMatch(/would create \d+ products, \d+ prices and 1 meter/);
	});

	it('refuses --apply and makes no network call on a plain run', () => {
		const spy = vi.spyOn(globalThis, 'fetch');
		expect(run(['--apply'])).toEqual({
			code: 2,
			output: '--apply is refused here: creating Stripe objects waits for the owner.\n'
		});
		const plain = run([]);
		expect(plain.code).toBe(0);
		expect(plain.output).toBe(renderSyncPlan(plan));
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
