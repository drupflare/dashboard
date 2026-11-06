export const UPSTREAM_SITE_THRESHOLD = 300;

export const HOUR_MS = 3_600_000;

export type Sweep = { siteId: string; code: string; atMs: number; bad: boolean };

export type Incident = {
	siteId: string;
	code: string;
	count: number;
	firstAtMs: number;
	lastAtMs: number;
};

// consecutive bad sweeps of one code on one site are one incident; a clean sweep closes it
export function collapseSweeps(sweeps: readonly Sweep[]): Incident[] {
	const incidents: Incident[] = [];
	const open = new Map<string, Incident>();
	for (const s of sweeps) {
		const key = JSON.stringify([s.siteId, s.code]);
		if (!s.bad) {
			open.delete(key);
			continue;
		}
		const cur = open.get(key);
		if (cur) {
			cur.count++;
			cur.lastAtMs = s.atMs;
			continue;
		}
		const next: Incident = {
			siteId: s.siteId,
			code: s.code,
			count: 1,
			firstAtMs: s.atMs,
			lastAtMs: s.atMs
		};
		open.set(key, next);
		incidents.push(next);
	}
	return incidents;
}

export type ProviderIncident =
	| { kind: 'upstream'; provider: string; sites: number }
	| { kind: 'per-site'; provider: string; siteIds: string[] };

// a provider outage above the threshold is one upstream incident, not one per site
export function providerIncidents(
	provider: string,
	failingSiteIds: readonly string[]
): ProviderIncident {
	if (failingSiteIds.length > UPSTREAM_SITE_THRESHOLD) {
		return { kind: 'upstream', provider, sites: failingSiteIds.length };
	}
	return { kind: 'per-site', provider, siteIds: [...failingSiteIds] };
}

export type RepairRecord = { orgId: string; atMs: number };

export type RepairBudget = { perOrgPerHour: number; fleetPerHour: number };

// the budget is a parameter on purpose: the plan sets no numbers
export function admitRepair(
	recent: readonly RepairRecord[],
	request: { orgId: string; nowMs: number },
	budget: RepairBudget
): { admit: boolean; reason: string } {
	const inWindow = recent.filter((r) => request.nowMs - r.atMs < HOUR_MS);
	if (inWindow.length >= budget.fleetPerHour) {
		return { admit: false, reason: 'fleet repair budget spent for the hour' };
	}
	const org = inWindow.filter((r) => r.orgId === request.orgId).length;
	if (org >= budget.perOrgPerHour) {
		return { admit: false, reason: 'organisation repair budget spent for the hour' };
	}
	return { admit: true, reason: '' };
}

// off at any level turns automatic repair off; an unset global switch is off
export function autoRepairOn(s: {
	global: boolean | undefined;
	org?: boolean;
	site?: boolean;
}): boolean {
	return s.global === true && s.org !== false && s.site !== false;
}
