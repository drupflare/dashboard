import { describe, expect, it } from 'vitest';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { MoveStatus, RingProbe, RolloutDeps, StoredRollout } from '../../../engine/src/ports';
import {
	planReleaseRing,
	runReleaseRing,
	type ReleaseRingInput,
	type RingRunner
} from '../../../engine/src/workflows/release-ring';
import { assignCohorts, type CohortSite, type Ring } from '../../../src/server/domain/cohorts';
import type { RingObservation } from '../../../src/server/domain/rings';
import { Killed, makeRunner, makeWorld, type Memo, type RunnerScript } from './fakes';

const OP = `op_${'r'.repeat(26)}`;
const NEW = 'rel-new';
const OLD = 'rel-old';

function estate(size: number): CohortSite[] {
	const sites: CohortSite[] = [];
	const add = (n: number, over: Partial<CohortSite>) => {
		for (let i = 0; i < n; i++) {
			sites.push({
				id: `site_${String(sites.length).padStart(3, '0')}`,
				traffic: 10,
				workload: 'static',
				criticality: 'low',
				...over
			});
		}
	};
	if (size >= 20) {
		add(1, { synthetic: true });
		add(1, { own: true });
		add(2, { canary: true });
		add(4, {});
		add(6, { traffic: 5_000, workload: 'application', criticality: 'standard' });
		add(6, { criticality: 'high' });
	} else {
		add(1, { synthetic: true });
		add(1, { own: true });
		add(1, { canary: true });
		add(1, {});
		add(1, { criticality: 'standard', workload: 'application' });
		add(1, { criticality: 'high' });
	}
	return sites;
}

function inputOf(sites: CohortSite[], over: Partial<ReleaseRingInput> = {}): ReleaseRingInput {
	const cohorts = assignCohorts(sites);
	const rings = (Object.keys(cohorts) as Ring[])
		.filter((ring) => cohorts[ring].length > 0)
		.map((ring) => ({
			ring,
			sites: cohorts[ring].map((site) => ({
				id: site.id,
				plan: 'free',
				...(site.synthetic ? { synthetic: true } : {})
			}))
		}));
	return {
		operationId: OP,
		orgId: `org_${'o'.repeat(26)}`,
		rolloutId: 'rollout-1',
		releaseId: NEW,
		rings,
		concurrency: 4,
		pollMs: 1,
		holdMs: 1,
		...over
	};
}

interface Scenario {
	// per ring, what the observation reports instead of a clean ring
	observe?: Partial<Record<Ring, (base: RingObservation) => RingObservation>>;
	// sites whose own update fails
	failing?: Set<string>;
	// sites whose rollback is refused
	stuck?: Set<string>;
}

async function rollout(
	sites: CohortSite[],
	scenario: Scenario = {},
	over: Partial<ReleaseRingInput> = {}
) {
	const world = await makeWorld();
	const input = inputOf(sites, over);
	const frozen = await freezePlan(planReleaseRing(input));
	await world.store.begin({
		operation: newOperation({
			id: OP,
			orgId: input.orgId,
			idempotencyKey: 'rollout-1',
			frozen,
			now: world.clock.now()
		}),
		accountId: null,
		siteId: null
	});

	const running = new Map<string, MoveStatus>();
	const release = new Map(sites.map((site) => [site.id, OLD]));
	const starts: string[] = [];
	const reverts: string[] = [];
	const received: string[] = [];
	let inFlight = 0;
	let widest = 0;
	const polls = new Map<string, number>();
	const stored = new Map<string, StoredRollout>();
	let stop = false;
	const probes: RingProbe[] = [];

	const deps: RolloutDeps = {
		...world.deps,
		mover: {
			async current(siteId) {
				return release.get(siteId) ?? null;
			},
			async upgrade(site, releaseId, key) {
				const id = `op:${key}`;
				if (!running.has(id)) {
					starts.push(site.id);
					received.push(site.id);
					running.set(id, 'running');
					inFlight += 1;
					widest = Math.max(widest, inFlight);
				}
				return id;
			},
			async rollback(site, releaseId, key) {
				const id = `op:${key}`;
				if (!running.has(id)) {
					reverts.push(site.id);
					if (scenario.stuck?.has(site.id)) running.set(id, 'failed');
					else {
						release.set(site.id, releaseId);
						running.set(id, 'succeeded');
					}
				}
				return id;
			},
			async status(id) {
				const siteId = id.split(':').at(-1) as string;
				const count = (polls.get(id) ?? 0) + 1;
				polls.set(id, count);
				if (id.includes(':rollback:')) return running.get(id) ?? 'failed';
				if (running.get(id) === 'running' && count >= 2) {
					const failed = scenario.failing?.has(siteId) === true;
					if (!failed) release.set(siteId, NEW);
					running.set(id, failed ? 'failed' : 'succeeded');
					inFlight -= 1;
				}
				return running.get(id) as MoveStatus;
			}
		},
		rollouts: {
			async load(id) {
				const row = stored.get(id);
				return row === undefined ? null : structuredClone(row);
			},
			async save(row) {
				stored.set(row.id, structuredClone(row));
			},
			async stopRequested() {
				return stop;
			}
		},
		observe: async (probe) => {
			probes.push(probe);
			const base: RingObservation = {
				ring: probe.ring,
				metrics: {
					failureRate: 0,
					resets: 0,
					memoryTrend: 0,
					coldBoots: 0,
					repairFindings: 0,
					writeFailures: 0
				},
				syntheticHealthy: true,
				observedSites: probe.siteIds.length,
				expectedSites: probe.siteIds.length
			};
			return scenario.observe?.[probe.ring]?.(base) ?? base;
		}
	};

	const sleeps: string[] = [];
	const attempt = (memo: Memo = new Map(), script: RunnerScript = {}) => {
		const { runner, executed } = makeRunner(memo, script);
		const ring: RingRunner = {
			do: runner.do.bind(runner),
			async sleep(name) {
				await runner.do(name, async () => {
					sleeps.push(name);
				});
			}
		};
		return { executed, done: runReleaseRing(ring, deps, input) };
	};
	return {
		world,
		input,
		deps,
		attempt,
		starts,
		reverts,
		received,
		release,
		stored,
		probes,
		sleeps,
		widest: () => widest,
		stop: () => void (stop = true)
	};
}

const state = (r: Awaited<ReturnType<typeof rollout>>) => r.stored.get('rollout-1')!;

describe('a clean rollout', () => {
	it('reaches R5, upgrades every site once, and records when the first and last ring were reached', async () => {
		const r = await rollout(estate(20));
		const run = r.attempt();
		expect(await run.done).toEqual({ status: 'succeeded' });
		expect(state(r).state).toMatchObject({ status: 'complete' });
		expect(state(r).state.received).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
		expect(r.starts).toHaveLength(20);
		expect(new Set(r.starts).size).toBe(20);
		expect([...r.release.values()].every((release) => release === NEW)).toBe(true);
		expect(state(r).firstRingAt).not.toBeNull();
		expect(state(r).lastRingAt).toBeGreaterThanOrEqual(state(r).firstRingAt as number);
		const operation = await r.deps.store.get(OP);
		expect(operation?.status).toBe('succeeded');
	});

	it('never has more sites in flight than the concurrency allows', async () => {
		const r = await rollout(estate(20), {}, { concurrency: 3 });
		await r.attempt().done;
		expect(r.widest()).toBeLessThanOrEqual(3);
		expect(r.widest()).toBeGreaterThan(1);
	});

	it('sends a ring only after the one before it was observed', async () => {
		const r = await rollout(estate(20));
		await r.attempt().done;
		const rings = r.probes.map((probe) => probe.ring);
		expect(rings).toEqual(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
	});
});

describe('a rollout that stops itself', () => {
	it('halts in R0 on a broken synthetic site and R1 never receives the release', async () => {
		const r = await rollout(estate(20), {
			observe: { R0: (base) => ({ ...base, syntheticHealthy: false }) }
		});
		const outcome = await r.attempt().done;
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(state(r).state).toMatchObject({ status: 'halted', current: 0 });
		expect(state(r).state.reasons.join(' ')).toContain('synthetic');
		expect(r.starts).toHaveLength(1);
		expect(r.starts).toEqual(r.input.rings[0]!.sites.map((site) => site.id));
		expect((await r.deps.store.get(OP))?.status).toBe('failed');
	});

	it('halts on a failure injected in ring 3 before ring 4 receives anything', async () => {
		const r = await rollout(estate(20), {
			observe: {
				R3: (base) => ({ ...base, metrics: { ...base.metrics, failureRate: 0.05 } })
			}
		});
		await r.attempt().done;
		expect(state(r).state).toMatchObject({ status: 'halted' });
		expect(state(r).state.received).toEqual(['R0', 'R1', 'R2', 'R3']);
		const later = new Set(
			r.input.rings
				.filter((entry) => entry.ring === 'R4' || entry.ring === 'R5')
				.flatMap((entry) => entry.sites.map((site) => site.id))
		);
		expect(r.starts.some((id) => later.has(id))).toBe(false);
	});

	it('halts on a missing observation, naming the field', async () => {
		const r = await rollout(estate(20), {
			observe: {
				R1: (base) => {
					const { memoryTrend: _drop, ...metrics } = base.metrics;
					return { ...base, metrics };
				}
			}
		});
		await r.attempt().done;
		expect(state(r).state).toMatchObject({ status: 'halted' });
		expect(state(r).state.reasons).toContain('no reading for memoryTrend');
	});

	it('reverts only the ring with the severe failure', async () => {
		const r = await rollout(estate(20), {
			observe: { R2: (base) => ({ ...base, metrics: { ...base.metrics, failureRate: 0.5 } }) }
		});
		const outcome = await r.attempt().done;
		expect(outcome).toMatchObject({ status: 'rolled-back' });
		expect(state(r).state.status).toBe('reverted');
		const ring = (name: Ring) =>
			r.input.rings.find((entry) => entry.ring === name)!.sites.map((site) => site.id);
		expect([...r.reverts].sort()).toEqual([...ring('R2')].sort());
		for (const id of ring('R2')) expect(r.release.get(id)).toBe(OLD);
		for (const id of [...ring('R0'), ...ring('R1')]) expect(r.release.get(id)).toBe(NEW);
		expect(state(r).progress.R2?.reverted).toHaveLength(ring('R2').length);
		expect((await r.deps.store.get(OP))?.status).toBe('rolled-back');
	});

	it('records a site a revert could not put back', async () => {
		const sites = estate(20);
		const r = await rollout(sites, {
			observe: {
				R2: (base) => ({ ...base, metrics: { ...base.metrics, failureRate: 0.5 } })
			},
			stuck: new Set(['site_002'])
		});
		await r.attempt().done;
		expect(state(r).progress.R2?.stuck).toEqual(['site_002']);
	});

	it('halts the ring when a site does not take the release, and sends nothing further', async () => {
		const r = await rollout(estate(20), { failing: new Set(['site_001']) });
		await r.attempt().done;
		expect(state(r).state).toMatchObject({ status: 'halted' });
		expect(state(r).state.reasons[0]).toContain('did not take the release');
		expect(r.probes.map((probe) => probe.ring)).toEqual(['R0']);
	});

	it('halts when an admin asks it to stop, before the next ring starts', async () => {
		const r = await rollout(estate(20));
		r.stop();
		const outcome = await r.attempt().done;
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(state(r).state.reasons).toEqual(['an admin stopped the rollout']);
		expect(r.starts).toEqual([]);
	});

	it('waits for sites that have not reported, then halts if they never do', async () => {
		const r = await rollout(
			estate(20),
			{ observe: { R0: (base) => ({ ...base, observedSites: 0 }) } },
			{ maxHolds: 3 }
		);
		await r.attempt().done;
		expect(state(r).state.reasons).toEqual(['the sites in R0 did not report in time']);
		expect(r.probes).toHaveLength(3);
	});
});

describe('kill and resume', () => {
	async function reference() {
		const r = await rollout(estate(6));
		const run = r.attempt();
		await run.done;
		return run.executed.length;
	}

	it('resumes at the same ring and never starts a finished site again, whichever step it dies at', async () => {
		const total = await reference();
		expect(total).toBeGreaterThan(30);
		for (let k = 0; k < total; k += 1) {
			const r = await rollout(estate(6));
			const memo: Memo = new Map();
			await expect(r.attempt(memo, { killAfter: k }).done).rejects.toBeInstanceOf(Killed);
			const outcome = await r.attempt(memo).done;
			expect(outcome, `killed after ${k}`).toEqual({ status: 'succeeded' });
			expect(r.starts.length, `killed after ${k}`).toBe(6);
			expect(new Set(r.starts).size).toBe(6);
		}
	});

	it('resumes a halted-in-the-middle run from the stored state when the replay memory is gone', async () => {
		const r = await rollout(estate(6));
		const memo: Memo = new Map();
		await expect(r.attempt(memo, { killAfter: 40 }).done).rejects.toBeInstanceOf(Killed);
		const saved = state(r);
		expect(saved.state.status).toBe('rolling');
		expect(saved.state.current).toBeGreaterThan(0);
		const before = r.starts.length;
		const fresh = r.attempt(new Map());
		await fresh.done;
		const reachedAgain = new Set(r.starts.slice(before));
		for (const ring of r.input.rings.slice(0, saved.state.current)) {
			for (const site of ring.sites) expect(reachedAgain.has(site.id)).toBe(false);
		}
		expect(state(r).state.status).toBe('complete');
	});
});
