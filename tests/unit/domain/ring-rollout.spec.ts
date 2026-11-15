import { describe, expect, it } from 'vitest';
import {
	COHORT_THRESHOLDS,
	RINGS,
	assignCohorts,
	ringOf,
	type CohortSite,
	type Ring
} from '../../../src/server/domain/cohorts';
import {
	RING_METRICS,
	RING_THRESHOLDS,
	RolloutStateError,
	currentRing,
	observeRing,
	startRollout,
	type RingObservation,
	type RolloutState
} from '../../../src/server/domain/rings';

const site = (id: string, over: Partial<CohortSite> = {}): CohortSite => ({
	id,
	traffic: 5_000,
	workload: 'application',
	criticality: 'standard',
	...over
});

// about twenty sites across every ring; s-busy is the busiest and most critical of all
const estate: CohortSite[] = [
	site('syn-ok', { synthetic: true, traffic: 0 }),
	site('syn-broken', { synthetic: true, traffic: 0 }),
	site('own-1', { own: true }),
	site('own-2', { own: true }),
	site('canary-1', { canary: true }),
	site('canary-2', { canary: true }),
	site('low-1', { traffic: 100, workload: 'static', criticality: 'low' }),
	site('low-2', { traffic: 900, workload: 'content', criticality: 'low' }),
	site('low-3', { traffic: 10, workload: 'static', criticality: 'low' }),
	site('mid-1', { traffic: 20_000 }),
	site('mid-2', { traffic: 8_000, workload: 'content' }),
	site('mid-3', { traffic: 50_000, criticality: 'high', workload: 'content' }),
	site('mid-4', { traffic: 3_000 }),
	site('mid-5', { traffic: 40_000 }),
	site('big-1', { traffic: 150_000 }),
	site('big-2', { traffic: 300_000, workload: 'commerce' }),
	site('shop-1', { traffic: 2_000, workload: 'commerce' }),
	site('crit-1', { traffic: 4_000, criticality: 'high' }),
	site('crit-2', { traffic: 7_000, criticality: 'high', workload: 'commerce' }),
	site('s-busy', { traffic: 900_000, criticality: 'high', workload: 'commerce' })
];

const healthy = (ring: Ring, over: Partial<RingObservation> = {}): RingObservation => ({
	ring,
	metrics: {
		failureRate: 0,
		resets: 0,
		memoryTrend: 0,
		coldBoots: 0,
		repairFindings: 0,
		writeFailures: 0
	},
	syntheticHealthy: true,
	observedSites: 2,
	expectedSites: 2,
	...over
});

// an in-memory observer: the rings that have received the release answer from a script
function rollOut(script: (ring: Ring) => Partial<RingObservation>) {
	const cohorts = assignCohorts(estate);
	let state: RolloutState = startRollout(cohorts, 'rel-2');
	const verdicts: string[] = [];
	while (state.status === 'rolling') {
		const ring = currentRing(state) as Ring;
		const result = observeRing(state, healthy(ring, script(ring)));
		verdicts.push(`${ring}:${result.verdict.action}`);
		state = result.state;
	}
	return { state, verdicts };
}

describe('cohort placement', () => {
	it('puts each site in the ring its flags and numbers name', () => {
		const cohorts = assignCohorts(estate);
		const ids = (ring: Ring) => cohorts[ring].map((s) => s.id);
		expect(ids('R0')).toEqual(['syn-broken', 'syn-ok']);
		expect(ids('R1')).toEqual(['own-1', 'own-2']);
		expect(ids('R2')).toEqual(['canary-1', 'canary-2']);
		expect(ids('R3')).toEqual(['low-3', 'low-1', 'low-2']);
		expect(ids('R4')).toEqual(['mid-4', 'mid-2', 'mid-1', 'mid-5']);
		expect(ids('R5')).toContain('s-busy');
		expect(RINGS.flatMap(ids)).toHaveLength(estate.length);
	});

	it('is deterministic whatever order the sites arrive in', () => {
		const forward = assignCohorts(estate);
		const reversed = assignCohorts([...estate].reverse());
		const shuffled = assignCohorts([...estate].sort((a, b) => (a.id < b.id ? 1 : -1)));
		expect(reversed).toEqual(forward);
		expect(shuffled).toEqual(forward);
	});

	it('puts the busiest, most critical site last of all', () => {
		const cohorts = assignCohorts(estate);
		const last = cohorts.R5[cohorts.R5.length - 1];
		expect(last?.id).toBe('s-busy');
		const order = RINGS.flatMap((ring) => cohorts[ring].map((s) => s.id));
		expect(order[order.length - 1]).toBe('s-busy');
	});

	it('lets an owner move a site later but never earlier', () => {
		const base = site('x', { traffic: 50_000 });
		expect(ringOf(base)).toBe('R4');
		expect(ringOf({ ...base, override: { ring: 'R5', byPlatformAdmin: false } })).toBe('R5');
		expect(ringOf({ ...base, override: { ring: 'R1', byPlatformAdmin: false } })).toBe('R4');
		expect(ringOf({ ...base, override: { ring: 'R4', byPlatformAdmin: false } })).toBe('R4');
	});

	it('lets a platform admin place a site in any ring', () => {
		const base = site('x', { traffic: 50_000 });
		expect(ringOf({ ...base, override: { ring: 'R2', byPlatformAdmin: true } })).toBe('R2');
	});

	it('keeps a busy or critical site out of the early rings and treats the traffic cutoffs as inclusive', () => {
		expect(ringOf(site('a', { traffic: COHORT_THRESHOLDS.highTraffic }))).toBe('R5');
		expect(
			ringOf(
				site('b', {
					traffic: COHORT_THRESHOLDS.lowTraffic,
					workload: 'static',
					criticality: 'low'
				})
			)
		).toBe('R3');
		expect(
			ringOf(
				site('c', {
					traffic: COHORT_THRESHOLDS.lowTraffic + 1,
					workload: 'static',
					criticality: 'low'
				})
			)
		).toBe('R4');
	});
});

describe('ring rollout', () => {
	it('reaches the last ring when every observation is healthy', () => {
		const { state, verdicts } = rollOut(() => ({}));
		expect(state.status).toBe('complete');
		expect(state.received).toEqual(RINGS);
		expect(verdicts).toEqual(RINGS.map((ring) => `${ring}:promote`));
	});

	it('sends the release to the first ring alone at the start', () => {
		const state = startRollout(assignCohorts(estate), 'rel-2');
		expect(state.received).toEqual(['R0']);
		expect(currentRing(state)).toBe('R0');
	});

	it('skips a ring with no sites', () => {
		const cohorts = assignCohorts(estate.filter((s) => !s.canary));
		expect(startRollout(cohorts, 'rel-2').order).toEqual(['R0', 'R1', 'R3', 'R4', 'R5']);
	});

	it('refuses to start with no sites at all', () => {
		expect(() => startRollout(assignCohorts([]), 'rel-2')).toThrow(RolloutStateError);
	});

	it.each(RINGS.slice(0, 5).map((ring, index) => [ring, RINGS[index + 1]] as const))(
		'halts on a failure in %s before %s ever receives the release',
		(failing, next) => {
			const { state, verdicts } = rollOut((ring) =>
				ring === failing ? { metrics: { ...healthy(ring).metrics, failureRate: 0.05 } } : {}
			);
			expect(state.status).toBe('halted');
			expect(state.received).not.toContain(next);
			expect(state.received[state.received.length - 1]).toBe(failing);
			expect(verdicts[verdicts.length - 1]).toBe(`${failing}:halt`);
			expect(state.reasons.join(' ')).toContain('failureRate is 0.05');
		}
	);

	it('halts when the synthetic site is broken in a ring, whatever else reads healthy', () => {
		for (const ring of RINGS.slice(0, 5)) {
			const { state } = rollOut((r) => (r === ring ? { syntheticHealthy: false } : {}));
			expect(state.status).toBe('halted');
			expect(state.reasons).toContain('the synthetic site is broken');
			expect(state.received[state.received.length - 1]).toBe(ring);
		}
	});

	it.each(RING_METRICS)('halts when the reading for %s is missing and names it', (metric) => {
		const { state } = rollOut((ring) => {
			if (ring !== 'R1') return {};
			const metrics = { ...healthy(ring).metrics };
			delete metrics[metric];
			return { metrics };
		});
		expect(state.status).toBe('halted');
		expect(state.reasons).toEqual([`no reading for ${metric}`]);
		expect(state.received).toEqual(['R0', 'R1']);
	});

	it('halts when a reading is not a usable number', () => {
		const { state } = rollOut((ring) =>
			ring === 'R0' ? { metrics: { ...healthy(ring).metrics, resets: Number.NaN } } : {}
		);
		expect(state.status).toBe('halted');
		expect(state.reasons).toEqual(['no reading for resets']);
	});

	it('halts when the synthetic probe did not report', () => {
		const { state } = rollOut((ring) => (ring === 'R2' ? { syntheticHealthy: undefined } : {}));
		expect(state.status).toBe('halted');
		expect(state.reasons).toEqual(['no reading for syntheticHealthy']);
	});

	it('halts when the observation is for another ring', () => {
		const state = startRollout(assignCohorts(estate), 'rel-2');
		const { verdict } = observeRing(state, healthy('R3'));
		expect(verdict.action).toBe('halt');
		expect(verdict.reasons[0]).toContain('the observation is for R3 but the rollout is in R0');
	});

	it('reverts the ring on a severe failure and never promotes it', () => {
		const { state, verdicts } = rollOut((ring) =>
			ring === 'R2' ? { metrics: { ...healthy(ring).metrics, writeFailures: 50 } } : {}
		);
		expect(state.status).toBe('reverted');
		expect(verdicts[verdicts.length - 1]).toBe('R2:revert');
		expect(state.received).toEqual(['R0', 'R1', 'R2']);
	});

	it('reverts rather than halts when a severe and a plain breach arrive together', () => {
		const { verdict } = observeRing(
			startRollout(assignCohorts(estate), 'rel-2'),
			healthy('R0', {
				metrics: { ...healthy('R0').metrics, failureRate: 0.5, coldBoots: 6 }
			})
		);
		expect(verdict.action).toBe('revert');
		expect(verdict.reasons).toEqual(['failureRate is 0.5', 'coldBoots is 6']);
	});

	it('holds while sites are still reporting and does not move on', () => {
		const state = startRollout(assignCohorts(estate), 'rel-2');
		const result = observeRing(state, healthy('R0', { observedSites: 1 }));
		expect(result.verdict).toEqual({ action: 'hold', reasons: ['1 of 2 sites reported'] });
		expect(result.state).toBe(state);
	});

	it('still halts on a failure while sites are still reporting', () => {
		const state = startRollout(assignCohorts(estate), 'rel-2');
		const result = observeRing(
			state,
			healthy('R0', { observedSites: 1, syntheticHealthy: false })
		);
		expect(result.verdict.action).toBe('halt');
	});

	it('takes a threshold the caller passes in', () => {
		const state = startRollout(assignCohorts(estate), 'rel-2');
		const result = observeRing(
			state,
			healthy('R0', { metrics: { ...healthy('R0').metrics, coldBoots: 1 } }),
			{ ...RING_THRESHOLDS, halt: { ...RING_THRESHOLDS.halt, coldBoots: 0 } }
		);
		expect(result.verdict.action).toBe('halt');
	});

	it('refuses to observe a rollout that has already stopped', () => {
		const { state } = rollOut((ring) => (ring === 'R0' ? { syntheticHealthy: false } : {}));
		expect(() => observeRing(state, healthy('R0'))).toThrow(RolloutStateError);
		expect(currentRing(state)).toBeNull();
	});

	it('keeps every halt limit below its severe limit', () => {
		for (const metric of RING_METRICS) {
			expect(RING_THRESHOLDS.halt[metric]).toBeLessThan(RING_THRESHOLDS.severe[metric]);
		}
	});
});
