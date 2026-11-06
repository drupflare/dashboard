import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERVALS, PLANS, intervalPrice, priceLookupKey, type Plan } from '../src/shared/plans';

export interface PlannedPrice {
	lookupKey: string;
	interval: (typeof INTERVALS)[number];
	unitAmountCents: number;
	unreviewed: boolean;
}

export interface PlannedProduct {
	planId: string;
	name: string;
	prices: PlannedPrice[];
}

export interface PlannedMeter {
	eventName: string;
	displayName: string;
	note: string;
}

export interface SyncPlan {
	products: PlannedProduct[];
	skipped: { planId: string; reason: string }[];
	meters: PlannedMeter[];
}

export const OVERAGE_METER: PlannedMeter = {
	eventName: 'drupflare_view_overage',
	displayName: 'Views over the plan allowance',
	note: 'one event per usage interval, identified by the interval id; $1 per 1,000 views is an assumption in the roadmap and stays unbilled while billing.overage.enabled is off'
};

function productFor(plan: Plan): PlannedProduct | string {
	if (plan.disabled) return 'disabled';
	if (plan.kind === 'enterprise') return 'contract; invoiced by hand';
	const prices: PlannedPrice[] = [];
	for (const interval of INTERVALS) {
		const value = intervalPrice(plan, interval);
		if (value === null || value <= 0) continue;
		prices.push({
			lookupKey: priceLookupKey(plan, interval),
			interval,
			unitAmountCents: Math.round(value * 100),
			unreviewed: plan.unreviewed
		});
	}
	if (prices.length === 0) {
		return plan.monthly.value === 0 ? 'free; needs no price' : 'no price in the roadmap';
	}
	return { planId: plan.id, name: plan.name, prices };
}

export function buildSyncPlan(plans: readonly Plan[] = PLANS): SyncPlan {
	const out: SyncPlan = { products: [], skipped: [], meters: [OVERAGE_METER] };
	for (const plan of plans) {
		const product = productFor(plan);
		if (typeof product === 'string') out.skipped.push({ planId: plan.id, reason: product });
		else out.products.push(product);
	}
	return out;
}

export function renderSyncPlan(plan: SyncPlan): string {
	const lines = ['stripe:sync dry run. Nothing was created and no key was read.', ''];
	for (const product of plan.products) {
		lines.push(`product ${product.planId}: ${product.name}`);
		for (const price of product.prices) {
			const dollars = (price.unitAmountCents / 100).toFixed(2);
			const flag = price.unreviewed ? ' (unreviewed)' : '';
			lines.push(`  price ${price.lookupKey}: $${dollars} per ${price.interval}${flag}`);
		}
	}
	for (const meter of plan.meters) lines.push(`meter ${meter.eventName}: ${meter.note}`);
	for (const row of plan.skipped) lines.push(`skipped ${row.planId}: ${row.reason}`);
	const prices = plan.products.reduce((sum, product) => sum + product.prices.length, 0);
	lines.push(
		'',
		`would create ${plan.products.length} products, ${prices} prices and ${plan.meters.length} meter`
	);
	return `${lines.join('\n')}\n`;
}

export function run(argv: readonly string[]): { code: number; output: string } {
	if (argv.includes('--apply')) {
		return {
			code: 2,
			output: '--apply is refused here: creating Stripe objects waits for the owner.\n'
		};
	}
	return { code: 0, output: renderSyncPlan(buildSyncPlan()) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { code, output } = run(process.argv.slice(2));
	process.stdout.write(output);
	process.exitCode = code;
}
