import { RINGS, type Cohorts, type Ring } from './cohorts';

export const RING_METRICS = [
	'failureRate',
	'resets',
	'memoryTrend',
	'coldBoots',
	'repairFindings',
	'writeFailures'
] as const;
export type RingMetric = (typeof RING_METRICS)[number];

export type RingLimits = Record<RingMetric, number>;

export interface RingThresholds {
	// above any of these the rollout stops where it is
	halt: RingLimits;
	// above any of these the ring goes back to the previous release
	severe: RingLimits;
}

// unreviewed: every number below is a placeholder until a real rollout has been measured
export const RING_THRESHOLDS: RingThresholds = {
	halt: {
		// share of requests that failed
		failureRate: 0.02,
		resets: 0,
		// growth in memory over the window, as a share of where it started
		memoryTrend: 0.15,
		coldBoots: 5,
		repairFindings: 0,
		writeFailures: 0
	},
	severe: {
		failureRate: 0.1,
		resets: 3,
		memoryTrend: 0.5,
		coldBoots: 50,
		repairFindings: 5,
		writeFailures: 5
	}
};

// a metric left out is a missing observation, and so is a synthetic probe that did not report
export interface RingObservation {
	ring: Ring;
	metrics: Partial<Record<RingMetric, number>>;
	// the synthetic site that runs in every ring; undefined when it did not report
	syntheticHealthy?: boolean;
	observedSites: number;
	expectedSites: number;
}

export type RolloutStatus = 'rolling' | 'complete' | 'halted' | 'reverted';
export type RolloutAction = 'promote' | 'hold' | 'halt' | 'revert';

export interface RolloutState {
	releaseId: string;
	// the rings that hold sites, in rollout order
	order: Ring[];
	current: number;
	// every ring the release has been sent to, in order
	received: Ring[];
	status: RolloutStatus;
	reasons: string[];
}

export interface RingVerdict {
	action: RolloutAction;
	reasons: string[];
}

export class RolloutStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RolloutStateError';
	}
}

export function startRollout(cohorts: Cohorts, releaseId: string): RolloutState {
	const order = RINGS.filter((ring) => cohorts[ring].length > 0);
	if (order.length === 0) throw new RolloutStateError('there are no sites to roll out to');
	return {
		releaseId,
		order,
		current: 0,
		received: [order[0] as Ring],
		status: 'rolling',
		reasons: []
	};
}

const usable = (value: number | undefined): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

function judge(
	state: RolloutState,
	observation: RingObservation,
	thresholds: RingThresholds
): RingVerdict {
	const ring = state.order[state.current] as Ring;
	const missing: string[] = [];
	if (observation.ring !== ring) {
		missing.push(`the observation is for ${observation.ring} but the rollout is in ${ring}`);
	}
	for (const metric of RING_METRICS) {
		if (!usable(observation.metrics[metric])) missing.push(`no reading for ${metric}`);
	}
	if (observation.syntheticHealthy === undefined) missing.push('no reading for syntheticHealthy');

	const severe: string[] = [];
	const halt: string[] = [];
	for (const metric of RING_METRICS) {
		const value = observation.metrics[metric];
		if (!usable(value)) continue;
		if (value > thresholds.severe[metric]) severe.push(`${metric} is ${value}`);
		else if (value > thresholds.halt[metric]) halt.push(`${metric} is ${value}`);
	}
	if (observation.syntheticHealthy === false) halt.push('the synthetic site is broken');

	if (severe.length > 0) return { action: 'revert', reasons: [...severe, ...halt, ...missing] };
	if (halt.length > 0 || missing.length > 0) {
		return { action: 'halt', reasons: [...halt, ...missing] };
	}
	if (observation.observedSites < observation.expectedSites) {
		return {
			action: 'hold',
			reasons: [`${observation.observedSites} of ${observation.expectedSites} sites reported`]
		};
	}
	return { action: 'promote', reasons: [] };
}

// promotion reads the observation alone; elapsed time never appears here
export function observeRing(
	state: RolloutState,
	observation: RingObservation,
	thresholds: RingThresholds = RING_THRESHOLDS
): { state: RolloutState; verdict: RingVerdict } {
	if (state.status !== 'rolling') {
		throw new RolloutStateError(`the rollout is already ${state.status}`);
	}
	const verdict = judge(state, observation, thresholds);
	if (verdict.action === 'hold') return { state, verdict };
	if (verdict.action === 'halt') {
		return { state: { ...state, status: 'halted', reasons: verdict.reasons }, verdict };
	}
	if (verdict.action === 'revert') {
		return { state: { ...state, status: 'reverted', reasons: verdict.reasons }, verdict };
	}
	const next = state.current + 1;
	if (next >= state.order.length) {
		return { state: { ...state, status: 'complete' }, verdict };
	}
	return {
		state: {
			...state,
			current: next,
			received: [...state.received, state.order[next] as Ring]
		},
		verdict
	};
}

export const currentRing = (state: RolloutState): Ring | null =>
	state.status === 'rolling' ? (state.order[state.current] as Ring) : null;
