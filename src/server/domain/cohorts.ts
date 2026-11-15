export const RINGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type Ring = (typeof RINGS)[number];

export const WORKLOAD_CLASSES = ['static', 'content', 'application', 'commerce'] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

export const CRITICALITIES = ['low', 'standard', 'high'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export interface CohortSite {
	id: string;
	// requests per day over a recent window
	traffic: number;
	workload: WorkloadClass;
	criticality: Criticality;
	synthetic?: boolean;
	own?: boolean;
	canary?: boolean;
	// an owner asks for this ring; a platform admin may ask for any ring
	override?: { ring: Ring; byPlatformAdmin: boolean };
}

export interface CohortThresholds {
	// at or below this many requests a day a site counts as low traffic
	lowTraffic: number;
	// at or above this many a site counts as busy and always lands in the last ring
	highTraffic: number;
}

// unreviewed: placeholder numbers until real fleet traffic is measured
export const COHORT_THRESHOLDS: CohortThresholds = { lowTraffic: 1_000, highTraffic: 100_000 };

const WORKLOAD_WEIGHT: Record<WorkloadClass, number> = {
	static: 0,
	content: 1,
	application: 2,
	commerce: 3
};

const CRITICALITY_WEIGHT: Record<Criticality, number> = { low: 0, standard: 1, high: 2 };

const ringIndex = (ring: Ring) => RINGS.indexOf(ring);

export function baseRing(site: CohortSite, thresholds: CohortThresholds = COHORT_THRESHOLDS): Ring {
	if (site.synthetic) return 'R0';
	if (site.own) return 'R1';
	if (site.canary) return 'R2';
	if (
		site.criticality === 'high' ||
		site.traffic >= thresholds.highTraffic ||
		site.workload === 'commerce'
	) {
		return 'R5';
	}
	if (
		site.criticality === 'low' &&
		site.traffic <= thresholds.lowTraffic &&
		WORKLOAD_WEIGHT[site.workload] <= WORKLOAD_WEIGHT.content
	) {
		return 'R3';
	}
	return 'R4';
}

// an owner can only move a site later; a platform admin can place it anywhere
export function ringOf(site: CohortSite, thresholds: CohortThresholds = COHORT_THRESHOLDS): Ring {
	const base = baseRing(site, thresholds);
	const asked = site.override;
	if (asked === undefined) return base;
	if (asked.byPlatformAdmin) return asked.ring;
	return ringIndex(asked.ring) > ringIndex(base) ? asked.ring : base;
}

// busiest and most critical last, then id so equal sites keep one order
function rolloutKey(site: CohortSite): [number, number, number, string] {
	return [
		CRITICALITY_WEIGHT[site.criticality],
		site.traffic,
		WORKLOAD_WEIGHT[site.workload],
		site.id
	];
}

function compare(a: CohortSite, b: CohortSite): number {
	const left = rolloutKey(a);
	const right = rolloutKey(b);
	for (let index = 0; index < 3; index++) {
		const diff = (left[index] as number) - (right[index] as number);
		if (diff !== 0) return diff;
	}
	return left[3] < right[3] ? -1 : left[3] > right[3] ? 1 : 0;
}

export type Cohorts = Record<Ring, CohortSite[]>;

export function assignCohorts(
	sites: CohortSite[],
	thresholds: CohortThresholds = COHORT_THRESHOLDS
): Cohorts {
	const cohorts: Cohorts = { R0: [], R1: [], R2: [], R3: [], R4: [], R5: [] };
	for (const site of sites) cohorts[ringOf(site, thresholds)].push(site);
	for (const ring of RINGS) cohorts[ring].sort(compare);
	return cohorts;
}
