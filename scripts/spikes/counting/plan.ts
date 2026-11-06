import {
	DEFAULT_OPTIONS,
	MECHANISMS,
	sizeOf,
	type CountedHour,
	type MechanismName
} from '../../../dispatch/src/counting';
import { quantile } from '../revocation/plan';

export const ARMS = MECHANISMS;
export type Arm = MechanismName;

export type Params = {
	trialsPerArm: number;
	rate: number;
	requestsPerTrial: number;
	batchSize: number;
	flushMs: number;
	hybridLimitFraction: number;
	settleS: number;
	doMemoryGb: number;
};

export const DEFAULTS: Params = {
	trialsPerArm: 10,
	rate: 50,
	requestsPerTrial: 3000,
	batchSize: DEFAULT_OPTIONS.batchSize,
	flushMs: DEFAULT_OPTIONS.flushMs,
	hybridLimitFraction: 0.9,
	settleS: 20,
	doMemoryGb: 0.125
};

export function checkParams(p: Params): string | null {
	for (const [key, value] of Object.entries(p)) {
		if (!Number.isFinite(value) || value <= 0) return `${key} must be a positive number`;
	}
	for (const key of ['trialsPerArm', 'requestsPerTrial', 'batchSize'] as const) {
		if (!Number.isInteger(p[key])) return `${key} must be a whole number`;
	}
	if (p.hybridLimitFraction >= 1) return 'hybridLimitFraction must be below 1';
	if (hybridLimit(p) < 3) return 'the hybrid limit must be at least 3 views';
	return null;
}

export const trialSeconds = (p: Params) => p.requestsPerTrial / p.rate + p.settleS;

export const hybridLimit = (p: Params) => Math.round(p.requestsPerTrial * p.hybridLimitFraction);

// #region arithmetic

// views one flush carries: the batch size, or what arrives in one flush interval, whichever is smaller
export function viewsPerFlush(p: Pick<Params, 'batchSize' | 'flushMs' | 'rate'>): number {
	return Math.min(p.batchSize, Math.ceil((p.flushMs * p.rate) / 1000) + 1);
}

// one isolate per site, views arriving at a steady rate, the counter always answering, the trial
// inside one hour; the last partial batch goes out when the trial settles
export function batchedCalls(p: Params): number {
	return Math.ceil(p.requestsPerTrial / viewsPerFlush(p));
}

export const writeThroughCalls = (p: Params): number => p.requestsPerTrial;

// the first view learns the site's total, the views below the limit batch, and the view that
// reaches the limit and every one after it write through
export function hybridCalls(p: Params): number {
	const limit = hybridLimit(p);
	return 1 + Math.floor((limit - 2) / viewsPerFlush(p)) + (p.requestsPerTrial - limit + 1);
}

export function callsPerTrial(arm: Arm, p: Params): number {
	if (arm === 'write-through') return writeThroughCalls(p);
	if (arm === 'batched') return batchedCalls(p);
	return hybridCalls(p);
}

// each applying call reads the hour row and the month total, and writes both
export const ROWS_PER_CALL = 2;

export type ArmRow = {
	arm: Arm;
	sites: number;
	requests: number;
	counterCalls: number;
	counterCallsPerSite: number;
	tenantCountCalls: number;
	rowsWritten: number;
	rowsRead: number;
};

export function armRow(arm: Arm, p: Params): ArmRow {
	const sites = p.trialsPerArm;
	const perSite = callsPerTrial(arm, p);
	return {
		arm,
		sites,
		requests: sites * p.requestsPerTrial,
		counterCalls: sites * perSite,
		counterCallsPerSite: perSite,
		tenantCountCalls: sites * p.requestsPerTrial,
		rowsWritten: sites * perSite * ROWS_PER_CALL,
		rowsRead: sites * perSite * ROWS_PER_CALL
	};
}

// #endregion

// #region prices

export const PRICE_NAMES = [
	'doRequests',
	'doGbSeconds',
	'rowsRead',
	'rowsWritten',
	'workerRequests'
] as const;
export type PriceName = (typeof PRICE_NAMES)[number];

export type PriceEntry = {
	usdPerMillion: number;
	includedPerMonth: number;
	page: string;
	fetched: string;
	read: string;
};

export type PriceSheet = Record<PriceName, PriceEntry>;

export type SheetCheck = { ok: true; sheet: PriceSheet } | { ok: false; reason: string };

export function parsePriceSheet(json: unknown): SheetCheck {
	if (typeof json !== 'object' || json === null) return { ok: false, reason: 'not an object' };
	const out: Partial<PriceSheet> = {};
	for (const name of PRICE_NAMES) {
		const entry = (json as Record<string, unknown>)[name] as
			Record<string, unknown> | undefined;
		if (!entry || typeof entry !== 'object') return { ok: false, reason: `${name} is missing` };
		const { usdPerMillion, includedPerMonth, page, fetched, read } = entry;
		if (typeof usdPerMillion !== 'number' || !(usdPerMillion >= 0)) {
			return { ok: false, reason: `${name}.usdPerMillion must be a number` };
		}
		if (typeof includedPerMonth !== 'number' || !(includedPerMonth >= 0)) {
			return { ok: false, reason: `${name}.includedPerMonth must be a number` };
		}
		for (const [field, value] of [
			['page', page],
			['fetched', fetched],
			['read', read]
		] as const) {
			if (typeof value !== 'string' || value === '') {
				return {
					ok: false,
					reason: `${name}.${field} must say where and when the price was read`
				};
			}
		}
		out[name] = { usdPerMillion, includedPerMonth, page, fetched, read } as PriceEntry;
	}
	return { ok: true, sheet: out as PriceSheet };
}

export type Estimate = {
	arms: ArmRow[];
	controlRequests: number;
	totalRequests: number;
	totalCounterCalls: number;
	totalTenantCountCalls: number;
	totalObjectRequests: number;
	rowsWritten: number;
	rowsRead: number;
	doGbSeconds: number;
	cost: null | { grossUsd: number; marginalUsd: number; lines: Record<PriceName, number> };
};

const over = (used: number, included: number) => Math.max(0, used - included);

export function estimate(p: Params, sheet: PriceSheet | null): Estimate {
	const arms = ARMS.map((arm) => armRow(arm, p));
	const sum = (pick: (row: ArmRow) => number) => arms.reduce((n, row) => n + pick(row), 0);
	const sites = sum((row) => row.sites);
	const controlRequests = sites * p.requestsPerTrial;
	const totalRequests = sum((row) => row.requests) + controlRequests;
	const totalCounterCalls = sum((row) => row.counterCalls);
	// the tenant counts every request it serves, the control's included
	const totalTenantCountCalls = totalRequests;
	// upper bound: a counter object and a tenant count object per site, billed for the whole trial
	const doGbSeconds = sites * 2 * trialSeconds(p) * p.doMemoryGb;
	const quantity: Record<PriceName, number> = {
		doRequests: totalCounterCalls + totalTenantCountCalls,
		doGbSeconds,
		rowsRead: sum((row) => row.rowsRead),
		rowsWritten: sum((row) => row.rowsWritten),
		workerRequests: totalRequests
	};
	let cost: Estimate['cost'] = null;
	if (sheet) {
		const lines = {} as Record<PriceName, number>;
		let marginalUsd = 0;
		for (const name of PRICE_NAMES) {
			const price = sheet[name];
			lines[name] = (quantity[name] / 1e6) * price.usdPerMillion;
			marginalUsd +=
				(over(quantity[name], price.includedPerMonth) / 1e6) * price.usdPerMillion;
		}
		const grossUsd = PRICE_NAMES.reduce((n, name) => n + lines[name], 0);
		cost = { grossUsd, marginalUsd, lines };
	}
	return {
		arms,
		controlRequests,
		totalRequests,
		totalCounterCalls,
		totalTenantCountCalls,
		totalObjectRequests: totalCounterCalls + totalTenantCountCalls,
		rowsWritten: quantity.rowsWritten,
		rowsRead: quantity.rowsRead,
		doGbSeconds,
		cost
	};
}

// #endregion

// #region trials

const ARM_CODE: Record<Arm, string> = { 'write-through': 'wt', batched: 'ba', hybrid: 'hy' };

export function siteIdFor(runId: string, arm: Arm, n: number): string {
	return `site_count${runId}${ARM_CODE[arm]}${String(n).padStart(4, '0')}`;
}

export const controlSiteId = (runId: string) => `site_count${runId}control`;

export function hostFor(template: string, arm: Arm, n: number): string {
	return template.replace('{arm}', arm).replace('{n}', String(n));
}

// odd trials force an isolate to end partway through; even trials are the clean baseline
export const isTerminationTrial = (n: number) => n % 2 === 1;

export const TERMINATE_AT = 0.5;

export const TERMINATION_NOTE = [
	'Forced isolate termination: no call that ends a Worker isolate on demand is documented.',
	'The method here is the memory limit: a stage-only route in the dispatch Worker allocates past 128 MB.',
	'Basis: workers/platform/limits (Memory) and workers/reference/how-workers-works (isolates are',
	'evicted on limits, after their events resolve), read through the docs search on 2026-11-06.',
	'The limits page says in-flight requests are let finish and a new isolate serves later requests, so',
	'the old isolate may flush its batch before it ends. Whether a batch is lost is what the run',
	'measures; a second origin in the hour row is the evidence that a new isolate took over.'
];

export function resourceList(p: Params, tenant = 'spike-count-tenant') {
	const sites = p.trialsPerArm * ARMS.length;
	return [
		'dispatch Worker drupflare-dispatch-stage (wrangler env stage) with the USAGE_COUNTER class bound and migrated',
		'the stage switch SPIKE_MODE=1 (set by the stage config) and a mech:<siteId> entry in HOSTS_KV per trial site, naming its mechanism; the control site has none',
		'the signed routes POST /__spike/evict and /__spike/counts on the control host, which the evict and read URLs point at',
		`dispatch namespace drupflare-stage (existing) holding one tenant script ${tenant}: it answers text/html 200, counts each request in its own Durable Object, and answers /__count as application/json`,
		`${sites + 1} HOSTS_KV route entries, one per trial site plus one control site with counting off`,
		'a proxied wildcard route on a zone the test account owns, pointing at the dispatch Worker',
		`${sites + 1} SITE_AUTH states written by signed requests from this script`,
		`${sites} UsageCounter objects and ${sites + 1} tenant count objects, created on first request`
	];
}

// #endregion

// #region readings

export function added(trial: number[], control: number[]) {
	const diff = (q: number) => {
		const a = quantile(trial, q);
		const b = quantile(control, q);
		return a === null || b === null ? null : a - b;
	};
	return { p50: diff(0.5), p95: diff(0.95) };
}

export type Readout = {
	counts: {
		since: number;
		calls: number;
		refused: number;
		puts: number;
		appliedViews: number;
		duplicateViews: number;
	};
	hours: (CountedHour | null)[];
};

export type ReadoutCheck = { ok: true; readout: Readout } | { ok: false; reason: string };

export function parseReadout(json: unknown): ReadoutCheck {
	const body = json as Partial<Readout> | null;
	if (!body || typeof body !== 'object') return { ok: false, reason: 'not an object' };
	const counts = body.counts;
	if (!counts || typeof counts !== 'object') return { ok: false, reason: 'counts is missing' };
	for (const key of ['since', 'calls', 'refused', 'puts', 'appliedViews', 'duplicateViews']) {
		if (typeof (counts as Record<string, unknown>)[key] !== 'number') {
			return { ok: false, reason: `counts.${key} must be a number` };
		}
	}
	if (!Array.isArray(body.hours)) return { ok: false, reason: 'hours must be a list' };
	for (const hour of body.hours) {
		if (hour !== null && (typeof hour !== 'object' || !Array.isArray(hour.batches))) {
			return { ok: false, reason: 'an hour is neither null nor a counted hour' };
		}
	}
	return { ok: true, readout: body as Readout };
}

export function counted(hours: (CountedHour | null)[]) {
	let acked = 0;
	let issued = 0;
	let origins = 0;
	let available = true;
	for (const hour of hours) {
		if (!hour) continue;
		acked += sizeOf(hour.batches);
		issued += hour.issued;
		origins = Math.max(origins, hour.origins);
		available &&= hour.accountingAvailable;
	}
	return { acked, issued, origins, available };
}

// positive means the counter holds more than the tenant served, negative means fewer
export function discrepancy(c: { acked: number; issued: number }, tenantViews: number) {
	return { acked: c.acked - tenantViews, issued: c.issued - tenantViews };
}

// #endregion

export type ApplyCheck = { ok: true } | { ok: false; reason: string };

export function checkApply(
	argv: readonly string[],
	env: Record<string, string | undefined>
): ApplyCheck {
	if (!argv.includes('--apply')) return { ok: true };
	if (env.SPIKE_CONFIRM !== '1') {
		return { ok: false, reason: '--apply needs SPIKE_CONFIRM=1 after the price sheet is read' };
	}
	for (const flag of [
		'--host-template',
		'--control-url',
		'--off-host',
		'--read-url',
		'--evict-url',
		'--prices'
	]) {
		if (!argv.includes(flag)) return { ok: false, reason: `--apply needs ${flag}` };
	}
	if (!env.SPIKE_CONTROL_SEED) return { ok: false, reason: '--apply needs SPIKE_CONTROL_SEED' };
	return { ok: true };
}
