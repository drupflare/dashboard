import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	ADD_ONS,
	INTERVALS,
	PLANS,
	intervalPrice,
	packLookupKey,
	priceLookupKey,
	type AddOn,
	type Plan
} from '../src/shared/plans';

export interface PlannedPrice {
	lookupKey: string;
	// null for a one-time pack
	interval: (typeof INTERVALS)[number] | null;
	unitAmountCents: number;
	unreviewed: boolean;
	// the size of a one-time pack
	units?: number;
}

export interface PlannedProduct {
	kind: 'plan' | 'add-on';
	id: string;
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
	skipped: { id: string; reason: string }[];
	meters: PlannedMeter[];
}

export const OVERAGE_METER: PlannedMeter = {
	eventName: 'drupflare_view_overage',
	displayName: 'Views over the plan allowance',
	note: 'one event per usage interval, identified by the interval id; $1 per 1,000 views is an assumption in the roadmap and stays unbilled while billing.overage.enabled is off'
};

// the catalogue holds dollars and stripe takes whole cents
const cents = (dollars: number) => Math.round(dollars * 100);

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
			unitAmountCents: cents(value),
			unreviewed: plan.unreviewed
		});
	}
	if (prices.length === 0) {
		return plan.monthly.value === 0 ? 'free; needs no price' : 'no price in the roadmap';
	}
	return { kind: 'plan', id: plan.id, name: plan.name, prices };
}

function addOnProduct(addOn: AddOn): PlannedProduct | string {
	if (!addOn.available) return addOn.availableNote ?? 'not available';
	const prices: PlannedPrice[] = [];
	for (const interval of INTERVALS) {
		const value = intervalPrice(addOn, interval);
		if (value === null || value <= 0) continue;
		prices.push({
			lookupKey: priceLookupKey(addOn, interval),
			interval,
			unitAmountCents: cents(value),
			unreviewed: addOn.unreviewed
		});
	}
	for (const pack of addOn.packs) {
		const value = pack.price.value;
		if (value === null || value <= 0) continue;
		prices.push({
			lookupKey: packLookupKey(addOn, pack.units),
			interval: null,
			unitAmountCents: cents(value),
			unreviewed: addOn.unreviewed,
			units: pack.units
		});
	}
	if (prices.length === 0) return 'no price in the roadmap';
	return { kind: 'add-on', id: addOn.id, name: addOn.name, prices };
}

export function buildSyncPlan(
	plans: readonly Plan[] = PLANS,
	addOns: readonly AddOn[] = ADD_ONS
): SyncPlan {
	const out: SyncPlan = { products: [], skipped: [], meters: [OVERAGE_METER] };
	const sort = (id: string, product: PlannedProduct | string) => {
		if (typeof product === 'string') out.skipped.push({ id, reason: product });
		else out.products.push(product);
	};
	for (const plan of plans) sort(plan.id, productFor(plan));
	for (const addOn of addOns) sort(addOn.id, addOnProduct(addOn));
	return out;
}

function renderPrice(price: PlannedPrice): string {
	const dollars = (price.unitAmountCents / 100).toFixed(2);
	const flag = price.unreviewed ? ' (unreviewed)' : '';
	const cadence =
		price.interval === null ? `one time for a pack of ${price.units}` : `per ${price.interval}`;
	return `  price ${price.lookupKey}: $${dollars} ${cadence}${flag}`;
}

export function renderSyncPlan(plan: SyncPlan): string {
	const lines = ['stripe:sync dry run. Nothing was created and no key was read.', ''];
	for (const product of plan.products) {
		lines.push(`product ${product.id}: ${product.name}`);
		for (const price of product.prices) lines.push(renderPrice(price));
	}
	for (const meter of plan.meters) lines.push(`meter ${meter.eventName}: ${meter.note}`);
	for (const row of plan.skipped) lines.push(`skipped ${row.id}: ${row.reason}`);
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
