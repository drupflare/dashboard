import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADD_ONS, PLANS, type AddOn, type Plan } from '../../src/shared/plans';
import { formatCount, formatDollars } from '../../src/shared/utils/format';
import {
	PRICE_FLOOR_PER_SITE,
	RATES,
	SUPPORT_HOURS_PER_SITE_YEAR,
	addOnMargin,
	belowFloor,
	costPlusPrice,
	leftAfterInfra,
	planMargin,
	pricePerSite,
	typicalCost
} from './plans';

export const START = '<!-- prices:start -->';
export const END = '<!-- prices:end -->';

type Figure = { value: number | null; label?: string } & Record<string, unknown>;

const dollars = (value: number | null | undefined) =>
	value === null || value === undefined ? '-' : formatDollars(value);

function figure(source: Figure, unit: (value: number) => string = formatCount): string {
	if (source.value !== null) return unit(source.value);
	return 'unlimited' in source ? 'Unlimited' : 'Not stated';
}

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);

function table(head: string[], rows: string[][]): string {
	const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
	return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

const gb = (value: number) => `${value} GB`;
const hours = (value: number) => `${value} h`;

function planPrices(plans: readonly Plan[]): string {
	return table(
		['Plan', 'Plane', 'Monthly', 'Annual', 'Label'],
		plans.map((plan) => [
			plan.name,
			plan.plane,
			dollars(plan.monthly.value),
			dollars(plan.annual.value),
			'label' in plan.monthly ? plan.monthly.label : '-'
		])
	);
}

function planAllowances(plans: readonly Plan[]): string {
	return table(
		[
			'Plan',
			'Sites',
			'Views a month',
			'Storage',
			'Writes a month',
			'Backup',
			'Emails a month',
			'Container time',
			'Invitees',
			'Support',
			'Hours a year',
			'Domains',
			'Backup days'
		],
		plans.map((plan) => [
			plan.name,
			figure(plan.sites),
			figure(plan.views),
			figure(plan.storageGb, gb),
			figure(plan.writes),
			figure(plan.backupGb, gb),
			figure(plan.mailSends),
			figure(plan.containerHours, hours),
			figure(plan.invitees),
			plan.support,
			figure(plan.supportHoursPerYear, hours),
			figure(plan.customDomains),
			figure(plan.backupDays)
		])
	);
}

function packs(addOn: AddOn): string {
	const sold = addOn.packs.filter((pack) => pack.price.value !== null);
	return sold.length === 0
		? '-'
		: sold.map((pack) => `${pack.units} for ${dollars(pack.price.value)}`).join(', ');
}

function addOnRows(addOns: readonly AddOn[]): string {
	return table(
		[
			'Add-on',
			'One unit is',
			'Monthly',
			'Annual',
			'One-time packs',
			'Cost to us',
			'Cost share',
			'Needs plan',
			'Status'
		],
		addOns.map((addOn) => {
			const margin = addOnMargin(addOn);
			return [
				addOn.name,
				addOn.unit,
				dollars(addOn.recurring?.monthly.value),
				dollars(addOn.recurring?.annual.value),
				packs(addOn),
				dollars(addOn.unitCost.value),
				percent(margin?.share ?? null),
				addOn.requires?.join(', ') ?? 'any',
				addOn.available ? 'on sale' : `not sold: ${addOn.availableNote ?? ''}`
			];
		})
	);
}

function margins(plans: readonly Plan[]): string {
	return table(
		[
			'Plan',
			'Price a month',
			'Per site a month',
			'Typical cost',
			'Cost at full use',
			'Infrastructure only',
			'Left after infrastructure',
			'Share',
			'Verdict'
		],
		plans.map((plan) => {
			const margin = planMargin(plan);
			const typical = typicalCost(plan);
			const left = leftAfterInfra(plan);
			const each = pricePerSite(plan);
			return [
				plan.name,
				dollars(margin.price),
				each === null ? '-' : `${cents(each)}${belowFloor(plan) ? ' (below floor)' : ''}`,
				typical === null ? '-' : cents(typical),
				cents(margin.cost.total),
				cents(margin.cost.infra),
				left === null ? '-' : cents(left),
				percent(margin.share),
				margin.verdict
			];
		})
	);
}

const MARKUPS = [2, 3, 4];

function costPlus(plans: readonly Plan[]): string {
	const sited = plans.filter(
		(plan) =>
			plan.plane === 'managed' && plan.sites.value !== null && (plan.monthly.value ?? 0) > 0
	);
	const rows = sited.map((plan) => {
		const sites = plan.sites.value ?? 0;
		return [
			plan.name,
			String(sites),
			dollars(plan.monthly.value),
			...MARKUPS.map((markup) =>
				cents(costPlusPrice(sites, markup, (plan.supportHoursPerYear.value ?? 0) > 0))
			)
		];
	});
	rows.push([
		'One extra site',
		'1',
		dollars(ADD_ONS.find((addOn) => addOn.id === 'extra-site')?.recurring?.monthly.value),
		...MARKUPS.map((markup) => cents(costPlusPrice(1, markup)))
	]);
	const note = `A kept-warm site costs us ${cents(RATES.siteMonth.perUnit)} a month raw, the documented delta of one more site past the account allowances, plus its views and storage. The fleet average of 35 cents is not used, because it includes the $5 subscription and the allowances. A plan that bundles support hours adds ${SUPPORT_HOURS_PER_SITE_YEAR} hours a site a year at ${cents(RATES.supportHour.perUnit)} an hour, an assumption set before any customer exists; a plan that bundles none carries no support time in its price. No site is sold for less than ${cents(PRICE_FLOOR_PER_SITE)} a month.`;
	return [
		table(['Plan', 'Sites', 'List price', ...MARKUPS.map((m) => `Cost plus at ${m}x`)], rows),
		note
	].join('\n\n');
}

const RATE_UNITS: Record<keyof typeof RATES, string> = {
	siteMonth: 'a kept-warm site, a month',
	viewMillion: '1 million views',
	writeMillion: '1 million rows written',
	storageGbMonth: '1 GB of site storage, a month',
	backupGbMonth: '1 GB of backup, a month',
	mailThousand: '1,000 emails',
	containerHour: '1 hour of container time',
	supportHour: '1 hour of support'
};

const cents = (value: number) =>
	`$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function rates(): string {
	return table(
		['One unit is', 'Cost to us', 'Label', 'Source'],
		(Object.keys(RATES) as (keyof typeof RATES)[]).map((name) => [
			RATE_UNITS[name],
			RATES[name].perUnit < 0.1
				? `$${RATES[name].perUnit.toFixed(3)}`
				: cents(RATES[name].perUnit),
			RATES[name].label,
			RATES[name].source
		])
	);
}

export function renderSheet(): string {
	return [
		START,
		'### Plan prices',
		planPrices(PLANS),
		'### What each plan includes',
		planAllowances(PLANS),
		'### Add-ons',
		addOnRows(ADD_ONS),
		'### Cost to us, typical and at full use',
		margins(PLANS),
		'### What cost plus would charge',
		costPlus(PLANS),
		'### Cost bases',
		rates(),
		END
	].join('\n\n');
}

// replaces the generated region of a file in place, or appends it when the markers are absent
export function updateFile(path: string, sheet = renderSheet()): void {
	const text = readFileSync(path, 'utf8');
	const from = text.indexOf(START);
	const to = text.indexOf(END);
	const next =
		from === -1 || to === -1
			? `${text.trimEnd()}\n\n${sheet}\n`
			: text.slice(0, from) + sheet + text.slice(to + END.length);
	writeFileSync(path, next);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const target = process.argv[2];
	if (target) updateFile(resolve(target));
	else console.log(renderSheet());
}
