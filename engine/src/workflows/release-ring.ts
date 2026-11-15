import type { Plan } from '@contracts/operations';
import { DEFAULT_CONCURRENCY, mapFleet } from '@drupflare/workforce';
import {
	RINGS,
	type CohortSite,
	type Cohorts,
	type Ring
} from '../../../src/server/domain/cohorts';
import {
	currentRing,
	observeRing,
	startRollout,
	type RolloutState
} from '../../../src/server/domain/rings';
import { buildPlan, observe, setCursor, setVerification, transition } from '../operations/state';
import type { RingProgress, RolloutDeps, StoredRollout } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import {
	closeFailed,
	describeFailure,
	finishSuccess,
	plainStep,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface RingSite {
	id: string;
	plan: string;
	synthetic?: boolean;
}

export interface ReleaseRingInput {
	operationId: string;
	orgId: string;
	rolloutId: string;
	releaseId: string;
	// the rings that hold sites, in rollout order
	rings: { ring: Ring; sites: RingSite[] }[];
	concurrency?: number;
	// how long to wait between looks at a site's own update, and how many looks to take
	pollMs?: number;
	maxPolls?: number;
	// how long to wait for sites to report, and how many times to ask
	holdMs?: number;
	maxHolds?: number;
}

export interface RingRunner extends StepRunner {
	sleep(name: string, ms: number): Promise<void>;
}

export function planReleaseRing(input: Pick<ReleaseRingInput, 'rolloutId' | 'releaseId'>): Plan {
	return buildPlan({
		type: 'fleet.upgrade',
		targetIds: [input.rolloutId],
		preconditions: [`release ${input.releaseId} is registered`],
		steps: [
			{ id: 'rings', name: 'Send the release ring by ring' },
			{ id: 'close', name: 'Record how the rollout ended' }
		],
		rollbackPoint: null
	});
}

const DEFAULTS = { pollMs: 15_000, maxPolls: 120, holdMs: 60_000, maxHolds: 30 };

// only the order and the size of each ring matter to the rollout state
function cohortsOf(input: ReleaseRingInput): Cohorts {
	const cohorts = Object.fromEntries(RINGS.map((ring) => [ring, [] as CohortSite[]])) as Cohorts;
	for (const { ring, sites } of input.rings) {
		cohorts[ring] = sites.map((site) => ({
			id: site.id,
			traffic: 0,
			workload: 'static',
			criticality: 'low'
		}));
	}
	return cohorts;
}

const emptyProgress = (): RingProgress => ({ upgraded: [], failed: [], reverted: [], stuck: [] });

type Move = 'upgrade' | 'rollback';

async function move(
	ctx: Ctx,
	runner: RingRunner,
	input: ReleaseRingInput,
	kind: Move,
	site: RingSite,
	releaseId: string
): Promise<boolean> {
	const { mover } = ctx.deps as RolloutDeps;
	const name = `${kind}.${site.id}`;
	const key = `${input.rolloutId}:${kind}:${site.id}`;
	const operationId = await plainStep(ctx, name, () =>
		kind === 'upgrade'
			? mover.upgrade(site, releaseId, key)
			: mover.rollback(site, releaseId, key)
	);
	const polls = input.maxPolls ?? DEFAULTS.maxPolls;
	for (let poll = 0; poll < polls; poll++) {
		const status = await plainStep(ctx, `${name}.wait.${poll}`, () =>
			mover.status(operationId)
		);
		if (status !== 'running') return status === 'succeeded';
		await runner.sleep(`${name}.nap.${poll}`, input.pollMs ?? DEFAULTS.pollMs);
	}
	return false;
}

// one site's failure is recorded and the rest go on, so a failure at site 7 never restarts 1 to 6;
// anything that is not a failed step is an interruption and stops the run
async function moveRing(
	ctx: Ctx,
	runner: RingRunner,
	input: ReleaseRingInput,
	kind: Move,
	sites: RingSite[],
	releaseFor: (site: RingSite) => string
): Promise<{ done: string[]; failed: string[] }> {
	const result = await mapFleet(
		sites,
		(site) => move(ctx, runner, input, kind, site, releaseFor(site)),
		{ concurrency: input.concurrency ?? DEFAULT_CONCURRENCY }
	);
	const done: string[] = [];
	const failed: string[] = [];
	for (const outcome of result.outcomes) {
		if (!outcome.attempted) continue;
		if (outcome.error !== undefined && !(outcome.error instanceof StepFailed))
			throw outcome.error;
		if (outcome.error === undefined && outcome.result === true) done.push(outcome.item.id);
		else failed.push(outcome.item.id);
	}
	return { done, failed };
}

const merge = (list: string[], more: string[]) => [...new Set([...list, ...more])];

export async function runReleaseRing(
	runner: RingRunner,
	deps: RolloutDeps,
	input: ReleaseRingInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step: runner,
		operationId: input.operationId,
		siteId: input.rolloutId,
		accountId: '',
		purpose: 'fleet.upgrade',
		epoch: null
	};
	const sitesOf = (ring: Ring) => input.rings.find((entry) => entry.ring === ring)?.sites ?? [];
	let saves = 0;
	let rollout: StoredRollout;

	// the clock reads inside the step, so a replay keeps the time the first run took
	const save = async (reached: boolean) => {
		const times = await plainStep(ctx, `save.${saves++}`, async () => {
			const at = deps.now();
			const next = {
				...rollout,
				firstRingAt: rollout.firstRingAt ?? (reached ? at : null),
				lastRingAt: reached ? at : rollout.lastRingAt
			};
			await deps.rollouts.save(next);
			if (reached) {
				await deps.store.mutate(ctx.operationId, (operation) =>
					setCursor(operation, currentRing(next.state) ?? next.state.status, at)
				);
			}
			return { firstRingAt: next.firstRingAt, lastRingAt: next.lastRingAt };
		});
		rollout = { ...rollout, ...times };
	};

	const ending = (state: RolloutState, status: RolloutState['status'], reasons: string[]) => ({
		...state,
		status,
		reasons
	});

	try {
		await startOperation(ctx);
		await runStep(ctx, 'rings-begin', 'rings', async () => undefined, { finish: false });
		const loaded = await plainStep(ctx, 'load', () => deps.rollouts.load(input.rolloutId));
		if (loaded !== null) rollout = loaded;
		else {
			rollout = {
				id: input.rolloutId,
				releaseId: input.releaseId,
				state: startRollout(cohortsOf(input), input.releaseId),
				progress: {},
				previous: {},
				firstRingAt: null,
				lastRingAt: null
			};
			await save(false);
		}

		while (rollout.state.status === 'rolling') {
			const ring = currentRing(rollout.state) as Ring;
			const sites = sitesOf(ring);

			if (
				await plainStep(ctx, `${ring}.stop`, () =>
					deps.rollouts.stopRequested(input.rolloutId)
				)
			) {
				rollout = {
					...rollout,
					state: ending(rollout.state, 'halted', ['an admin stopped the rollout'])
				};
				await save(false);
				break;
			}

			if (rollout.progress[ring] === undefined) {
				rollout = {
					...rollout,
					progress: { ...rollout.progress, [ring]: emptyProgress() }
				};
				await save(true);
			}

			const before = await plainStep(ctx, `${ring}.before`, async () =>
				Object.fromEntries(
					await Promise.all(
						sites.map(async (site) => [site.id, await deps.mover.current(site.id)])
					)
				)
			);
			rollout = { ...rollout, previous: { ...before, ...rollout.previous } };
			await save(false);

			const progress = rollout.progress[ring] ?? emptyProgress();
			const todo = sites.filter((site) => !progress.upgraded.includes(site.id));
			const sent = await moveRing(ctx, runner, input, 'upgrade', todo, () => input.releaseId);
			const upgraded = {
				...progress,
				upgraded: merge(progress.upgraded, sent.done),
				failed: sent.failed
			};
			rollout = { ...rollout, progress: { ...rollout.progress, [ring]: upgraded } };
			if (sent.failed.length > 0) {
				rollout = {
					...rollout,
					state: ending(rollout.state, 'halted', [
						`${sent.failed.length} of ${sites.length} sites in ${ring} did not take the release`
					])
				};
				await save(false);
				break;
			}
			await save(false);

			const probe = {
				ring,
				releaseId: input.releaseId,
				siteIds: sites.map((site) => site.id),
				syntheticIds: sites.filter((site) => site.synthetic === true).map((site) => site.id)
			};
			const holds = input.maxHolds ?? DEFAULTS.maxHolds;
			let judged: ReturnType<typeof observeRing> | null = null;
			for (let hold = 0; hold < holds; hold++) {
				const observation = await plainStep(ctx, `${ring}.observe.${hold}`, () =>
					deps.observe(probe)
				);
				const next = observeRing(rollout.state, observation);
				if (next.verdict.action !== 'hold') {
					judged = next;
					break;
				}
				await runner.sleep(`${ring}.hold.${hold}`, input.holdMs ?? DEFAULTS.holdMs);
			}
			if (judged === null) {
				rollout = {
					...rollout,
					state: ending(rollout.state, 'halted', [
						`the sites in ${ring} did not report in time`
					])
				};
				await save(false);
				break;
			}

			rollout = { ...rollout, state: judged.state };
			if (judged.verdict.action === 'revert') {
				const back = upgraded.upgraded.filter(
					(id) => (rollout.previous[id] ?? null) !== null
				);
				const stuck = upgraded.upgraded.filter(
					(id) => (rollout.previous[id] ?? null) === null
				);
				const reverted = await moveRing(
					ctx,
					runner,
					input,
					'rollback',
					sites.filter((site) => back.includes(site.id)),
					(site) => rollout.previous[site.id] as string
				);
				rollout = {
					...rollout,
					progress: {
						...rollout.progress,
						[ring]: {
							...upgraded,
							reverted: reverted.done,
							stuck: [...stuck, ...reverted.failed]
						}
					}
				};
			}
			await save(false);
		}

		await runStep(ctx, 'rings-end', 'rings', async () => undefined, { begin: false });
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const reason = describeFailure(error);
		const closed = await closeFailed(ctx, error);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}

	const { state } = rollout;
	const reason = state.reasons.join('; ');
	if (state.status === 'complete') {
		await plainStep(ctx, 'verified', async () => {
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.verification === 'passed'
					? operation
					: setVerification(
							operation.status === 'running'
								? transition(operation, 'verifying', deps.now())
								: operation,
							'passed',
							deps.now()
						)
			);
		});
		await finishSuccess(
			ctx,
			`${input.releaseId} reached ${state.order[state.order.length - 1]}`
		);
		return { status: 'succeeded' };
	}
	await plainStep(ctx, 'close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'rolled-back' || operation.status === 'failed')
				return operation;
			return transition(
				observe(operation, `rollout ${state.status}: ${reason}`, deps.now()),
				'failed',
				deps.now()
			);
		});
		if (state.status === 'reverted') {
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.status === 'rolled-back'
					? operation
					: transition(operation, 'rolled-back', deps.now())
			);
		}
	});
	return state.status === 'reverted'
		? { status: 'rolled-back', reason }
		: { status: 'failed', reason, leaked: [] };
}
