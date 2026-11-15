import { describe, expect, it, vi } from 'vitest';
import { OVERAGE_METER, buildSyncPlan, renderSyncPlan, run } from '../../../scripts/stripe-sync';
import {
	ADD_ONS,
	PLANS,
	findAddOn,
	findPlan,
	offerFromPriceKey,
	type AddOn,
	type Plan
} from '../../../src/shared/plans';

const synthetic = (over: Partial<AddOn>): AddOn => ({
	...(findAddOn('hostnames') as AddOn),
	...over
});

describe('stripe-sync dry run', () => {
	const plan = buildSyncPlan();
	const product = (id: string) => plan.products.find((p) => p.id === id);

	it('plans a product with a monthly and an annual price for each priced managed plan', () => {
		expect(product('managed-pro')).toMatchObject({ kind: 'plan' });
		const pro = findPlan('managed-pro') as Plan;
		expect(product('managed-pro')?.prices).toEqual([
			{
				lookupKey: 'drupflare_managed_pro_monthly',
				interval: 'month',
				unitAmountCents: Math.round((pro.monthly.value ?? 0) * 100),
				unreviewed: true
			},
			{
				lookupKey: 'drupflare_managed_pro_annual',
				interval: 'year',
				unitAmountCents: Math.round((pro.annual.value ?? 0) * 100),
				unreviewed: true
			}
		]);
		const agency = findPlan('managed-agency') as Plan;
		expect(product('managed-agency')?.prices.map((p) => p.unitAmountCents)).toEqual([
			Math.round((agency.monthly.value ?? 0) * 100),
			Math.round((agency.annual.value ?? 0) * 100)
		]);
	});

	it('carries the review flag on every price', () => {
		for (const one of plan.products) {
			for (const price of one.prices) expect(price.unreviewed, price.lookupKey).toBe(true);
		}
	});

	it('skips what has no price to create and says why', () => {
		const reasons = Object.fromEntries(plan.skipped.map((row) => [row.id, row.reason]));
		expect(reasons.enterprise).toMatch(/contract/);
		expect(reasons['managed-free']).toBe('free; needs no price');
		expect(reasons['self-hosted']).toBe('free; needs no price');
		expect(buildSyncPlan([{ ...PLANS[3]!, disabled: true }], []).skipped).toEqual([
			{ id: 'managed-free', reason: 'disabled' }
		]);
		expect(plan.products.length + plan.skipped.length).toBe(PLANS.length + ADD_ONS.length);
	});

	it('plans a recurring price per interval and a one-time price per pack for an add-on', () => {
		expect(product('support-hours')).toMatchObject({ kind: 'add-on', name: 'Support Hours' });
		expect(
			product('support-hours')?.prices.map((p) => [
				p.lookupKey,
				p.interval,
				p.units,
				p.unitAmountCents
			])
		).toEqual([
			['drupflare_addon_support_hours_monthly', 'month', undefined, 13000],
			['drupflare_addon_support_hours_annual', 'year', undefined, 130000],
			['drupflare_addon_support_hours_pack_1', null, 1, 15000],
			['drupflare_addon_support_hours_pack_5', null, 5, 70000],
			['drupflare_addon_support_hours_pack_10', null, 10, 130000],
			['drupflare_addon_support_hours_pack_20', null, 20, 240000]
		]);
	});

	it('gives every price an add-on plans a lookup key the catalogue can read back', () => {
		for (const one of plan.products.filter((p) => p.kind === 'add-on')) {
			for (const price of one.prices) {
				const offer = offerFromPriceKey(price.lookupKey);
				expect(offer?.kind, price.lookupKey).toBe(
					price.interval === null ? 'pack' : 'add-on'
				);
			}
		}
	});

	it('skips an add-on that is not available and gives the reason it states', () => {
		const reasons = Object.fromEntries(plan.skipped.map((row) => [row.id, row.reason]));
		expect(reasons['support-critical']).toMatch(/second person/);
		expect(reasons.domain).toBe(findAddOn('domain')?.availableNote);
		expect(product('support-critical')).toBeUndefined();
		expect(product('domain')).toBeUndefined();
	});

	it('converts dollars to whole cents with rounding, so a half dollar and 0.29 are exact', () => {
		const half = buildSyncPlan([], [synthetic({})]).products[0];
		expect(half?.prices.map((p) => p.unitAmountCents)).toEqual([50, 500]);
		const odd = buildSyncPlan(
			[],
			[
				synthetic({
					recurring: {
						monthly: { value: 0.29, label: 'assumption', source: 'test' },
						annual: { value: null, source: 'test' }
					}
				})
			]
		).products[0];
		expect(odd?.prices).toEqual([
			{
				lookupKey: 'drupflare_addon_hostnames_monthly',
				interval: 'month',
				unitAmountCents: 29,
				unreviewed: true
			}
		]);
	});

	it('skips a price whose value is null and an add-on with no price at all', () => {
		const nullPack = synthetic({
			recurring: null,
			packs: [
				{ units: 1, price: { value: null, source: 'test' } },
				{ units: 2, price: { value: 3, label: 'assumption', source: 'test' } }
			]
		});
		const only = buildSyncPlan([], [nullPack]).products[0];
		expect(only?.prices.map((p) => p.lookupKey)).toEqual(['drupflare_addon_hostnames_pack_2']);
		const none = buildSyncPlan([], [synthetic({ recurring: null, packs: [] })]);
		expect(none.products).toEqual([]);
		expect(none.skipped).toEqual([{ id: 'hostnames', reason: 'no price in the roadmap' }]);
	});

	it('plans one overage meter', () => {
		expect(plan.meters).toEqual([OVERAGE_METER]);
	});

	it('prints what it would create and says nothing was created', () => {
		const text = renderSyncPlan(plan);
		expect(text).toContain('dry run');
		const pro = (findPlan('managed-pro') as Plan).monthly.value ?? 0;
		expect(text).toContain(
			`price drupflare_managed_pro_monthly: $${pro.toFixed(2)} per month (unreviewed)`
		);
		const pack = findAddOn('support-hours')?.packs.find((one) => one.units === 5);
		expect(text).toContain(
			`price drupflare_addon_support_hours_pack_5: $${(pack?.price.value ?? 0).toFixed(2)} one time for a pack of 5 (unreviewed)`
		);
		expect(text).toContain(`skipped domain: ${findAddOn('domain')?.availableNote}`);
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
