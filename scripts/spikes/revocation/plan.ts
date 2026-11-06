export const ARMS = ['per-request', 'lease', 'hybrid'] as const;
export type Arm = (typeof ARMS)[number];

export type Params = {
	trialsPerArm: number;
	probeHz: number;
	warmS: number;
	postS: number;
	isolates: number;
	leaseS: number;
	strictFraction: number;
	doMemoryGb: number;
};

export const DEFAULTS: Params = {
	trialsPerArm: 10,
	probeHz: 5,
	warmS: 60,
	postS: 60,
	isolates: 3,
	leaseS: 30,
	strictFraction: 0.1,
	doMemoryGb: 0.125
};

// list prices from the pages named in `source`, read through a page-to-text extract; reopen before quoting
export type Prices = {
	doRequestsIncluded: number;
	doRequestPerMillion: number;
	doGbSecondsIncluded: number;
	doGbSecondPerMillion: number;
	workerRequestsIncluded: number;
	workerRequestPerMillion: number;
	source: string;
};

export const PRICES: Prices = {
	doRequestsIncluded: 1_000_000,
	doRequestPerMillion: 0.15,
	doGbSecondsIncluded: 400_000,
	doGbSecondPerMillion: 12.5,
	workerRequestsIncluded: 10_000_000,
	workerRequestPerMillion: 0.3,
	source: 'developers.cloudflare.com/durable-objects/platform/pricing and /workers/platform/pricing, fetched 2026-11-05'
};

export type ArmRow = {
	arm: Arm;
	sites: number;
	strictSites: number;
	requests: number;
	doRequests: number;
	doRequestsPerSite: number;
};

export type Estimate = {
	arms: ArmRow[];
	totalRequests: number;
	totalDoRequests: number;
	doGbSeconds: number;
	grossDoRequestUsd: number;
	grossDoDurationUsd: number;
	grossWorkerRequestUsd: number;
	grossUsd: number;
	marginalUsd: number;
};

const renewEveryS = (leaseS: number) => (leaseS * 2) / 3;

// every request before the revoke asks the object once, the first one after it learns the site is
// revoked and the dispatch Worker remembers that; the setup and revoke writes add two
export function strictDoRequests(warmRequests: number): number {
	return warmRequests + 1 + 2;
}

// each isolate fetches a lease, renews when a third of its life remains, then asks once more after
// the revoke commit and learns the site is revoked; the setup and revoke writes add two
export function leaseDoRequests(p: Pick<Params, 'isolates' | 'warmS' | 'leaseS'>): number {
	return p.isolates * (Math.ceil(p.warmS / renewEveryS(p.leaseS)) + 1) + 2;
}

export function armRow(arm: Arm, p: Params): ArmRow {
	const sites = p.trialsPerArm;
	const requests = sites * p.probeHz * (p.warmS + p.postS);
	const warmRequests = p.probeHz * p.warmS;
	const strictSites =
		arm === 'per-request'
			? sites
			: arm === 'lease'
				? 0
				: Math.min(sites, Math.max(0, Math.round(sites * p.strictFraction)));
	const leaseSites = sites - strictSites;
	const doRequests =
		strictSites * strictDoRequests(warmRequests) + leaseSites * leaseDoRequests(p);
	return { arm, sites, strictSites, requests, doRequests, doRequestsPerSite: doRequests / sites };
}

const overIncluded = (used: number, included: number) => Math.max(0, used - included);

export function estimate(p: Params, prices: Prices = PRICES): Estimate {
	const arms = ARMS.map((arm) => armRow(arm, p));
	const sum = (pick: (row: ArmRow) => number) => arms.reduce((n, row) => n + pick(row), 0);
	const totalRequests = sum((row) => row.requests);
	const totalDoRequests = sum((row) => row.doRequests);
	// upper bound: each site's object is billed for the whole trial at its memory size
	const doGbSeconds = sum((row) => row.sites) * (p.warmS + p.postS) * p.doMemoryGb;
	const grossDoRequestUsd = (totalDoRequests / 1e6) * prices.doRequestPerMillion;
	const grossDoDurationUsd = (doGbSeconds / 1e6) * prices.doGbSecondPerMillion;
	const grossWorkerRequestUsd = (totalRequests / 1e6) * prices.workerRequestPerMillion;
	const marginalUsd =
		(overIncluded(totalDoRequests, prices.doRequestsIncluded) / 1e6) *
			prices.doRequestPerMillion +
		(overIncluded(doGbSeconds, prices.doGbSecondsIncluded) / 1e6) *
			prices.doGbSecondPerMillion +
		(overIncluded(totalRequests, prices.workerRequestsIncluded) / 1e6) *
			prices.workerRequestPerMillion;
	return {
		arms,
		totalRequests,
		totalDoRequests,
		doGbSeconds,
		grossDoRequestUsd,
		grossDoDurationUsd,
		grossWorkerRequestUsd,
		grossUsd: grossDoRequestUsd + grossDoDurationUsd + grossWorkerRequestUsd,
		marginalUsd
	};
}

// ids and hosts are fixed by arm and trial so the route entries can be written before the run
export function siteIdFor(arm: Arm, n: number): string {
	return `site_spike${arm.replace('-', '')}${String(n).padStart(4, '0')}`;
}

export function hostFor(template: string, arm: Arm, n: number): string {
	return template.replace('{arm}', arm).replace('{n}', String(n));
}

export function isStrictTrial(
	arm: Arm,
	n: number,
	trials: number,
	strictFraction: number
): boolean {
	if (arm === 'per-request') return true;
	if (arm === 'lease') return false;
	return n < Math.round(trials * strictFraction);
}

export function resourceList(p: Params, scriptName = 'spike-tenant') {
	const sites = p.trialsPerArm * ARMS.length;
	return [
		'dispatch Worker drupflare-dispatch-stage (wrangler env stage) with its two Durable Object classes',
		'dispatch namespace drupflare-stage (existing) holding one tenant script ' + scriptName,
		`${sites} HOSTS_KV route entries, one per trial site, plus one for the control site`,
		'a proxied wildcard route on a zone the test account owns, pointing at the dispatch Worker',
		'secrets on the dispatch Worker: SITE_AUTH_SEED, LEASE_PUBLIC_KEY, CONTROL_PUBLIC_KEY, and CONTROL_HOST as a var',
		`${sites + 1} SITE_AUTH object states, written by signed requests from this script`
	];
}

export function quantile(values: number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null
	);
}

export function summarize(values: number[]) {
	return {
		n: values.length,
		min: values.length ? Math.min(...values) : null,
		p50: quantile(values, 0.5),
		p95: quantile(values, 0.95),
		max: values.length ? Math.max(...values) : null,
		spread: values.length ? Math.max(...values) - Math.min(...values) : null
	};
}

// the cf-ray header ends in the three-letter colo code
export function coloOf(cfRay: string | null): string | null {
	const match = /-([A-Za-z]{3})$/.exec(cfRay ?? '');
	return match ? (match[1] as string).toUpperCase() : null;
}

export type Probe = { start: number; end: number; status: number; colo: string | null };

// time from the revoke commit to the last 2xx that finished after it; zero when none did
export function staleWindowMs(probes: Probe[], commitAck: number): number {
	let last = commitAck;
	for (const probe of probes) {
		if (probe.status >= 200 && probe.status < 300 && probe.end > last) last = probe.end;
	}
	return last - commitAck;
}

export type ApplyCheck = { ok: true } | { ok: false; reason: string };

export function checkApply(
	argv: readonly string[],
	env: Record<string, string | undefined>
): ApplyCheck {
	if (!argv.includes('--apply')) return { ok: true };
	if (env.SPIKE_CONFIRM !== '1') {
		return { ok: false, reason: '--apply needs SPIKE_CONFIRM=1 after the price sheet is read' };
	}
	for (const flag of ['--host-template', '--control-url', '--control-host']) {
		if (!argv.includes(flag)) return { ok: false, reason: `--apply needs ${flag}` };
	}
	if (!env.SPIKE_CONTROL_SEED) return { ok: false, reason: '--apply needs SPIKE_CONTROL_SEED' };
	return { ok: true };
}
