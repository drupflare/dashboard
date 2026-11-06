import {
	bindEpoch,
	checkBudget,
	failStep,
	observe,
	OPEN_STATUSES,
	OperationError,
	skipPending,
	stepOf,
	transition,
	transitionStep
} from '../operations/state';
import type { EngineDeps } from '../ports';
import { messageOf, PermanentError, StepFailed, type StepRunner } from '../step';

export interface Ctx {
	deps: EngineDeps;
	step: StepRunner;
	operationId: string;
	siteId: string;
	accountId: string;
	purpose: string;
	epoch: number | null;
}

export type Outcome =
	| { status: 'succeeded' }
	| { status: 'rolled-back'; reason: string }
	| { status: 'failed'; reason: string; leaked: string[] }
	| { status: 'cancelled'; reason: string };

export class LeaseLostError extends PermanentError {
	constructor(siteId: string, why: string) {
		super('lease_lost', `the writer lease on ${siteId} is gone (${why})`);
	}
}

export class SiteBusyError extends PermanentError {
	constructor(siteId: string, heldBy: string | undefined) {
		super('site_busy', `${siteId} is being changed by ${heldBy ?? 'another operation'}`);
	}
}

// every mutating step re-checks the lease first, so a holder that expired writes nothing more
export async function fenced(ctx: Ctx): Promise<void> {
	if (ctx.epoch === null) throw new LeaseLostError(ctx.siteId, 'never acquired');
	const verdict = await ctx.deps.leases.check(ctx.siteId, {
		holder: ctx.operationId,
		epoch: ctx.epoch
	});
	if (!verdict.ok) throw new LeaseLostError(ctx.siteId, verdict.code);
}

export interface RunOptions {
	begin?: boolean;
	finish?: boolean;
}

// the work runs as one workflow step and moves the operation's own step through its states; a step
// already recorded as succeeded (its result was lost) runs again without touching the record
export function runStep<T>(
	ctx: Ctx,
	name: string,
	planStepId: string,
	work: (attempt: number) => Promise<T>,
	options: RunOptions = {}
): Promise<T> {
	const { store, now } = ctx.deps;
	return ctx.step.do(name, async () => {
		let attempt = 1;
		if (options.begin ?? true) {
			const next = await store.mutate(ctx.operationId, (operation) =>
				stepOf(operation, planStepId).state === 'succeeded'
					? operation
					: transitionStep(operation, planStepId, 'running', now())
			);
			attempt = stepOf(next, planStepId).attempt;
		}
		let result: T;
		try {
			result = await work(attempt);
		} catch (error) {
			await store
				.mutate(ctx.operationId, (operation) =>
					stepOf(operation, planStepId).state === 'succeeded'
						? operation
						: transitionStep(operation, planStepId, 'failed', now(), messageOf(error))
				)
				.catch(() => undefined);
			throw error;
		}
		if (options.finish ?? true) {
			await store.mutate(ctx.operationId, (operation) =>
				stepOf(operation, planStepId).state === 'succeeded'
					? operation
					: transitionStep(operation, planStepId, 'succeeded', now())
			);
		}
		return result;
	});
}

// internal work that is not one of the plan's steps
export function plainStep<T>(ctx: Ctx, name: string, work: () => Promise<T>): Promise<T> {
	return ctx.step.do(name, work);
}

export async function startOperation(ctx: Ctx): Promise<void> {
	const { store, now } = ctx.deps;
	await plainStep(ctx, 'start', async () => {
		const operation = await store.get(ctx.operationId);
		if (operation === null)
			throw new OperationError('not_found', `no operation ${ctx.operationId}`);
		if (OPEN_STATUSES.includes(operation.status)) return;
		if (operation.status === 'planned') {
			const running = await store.runningProductionDeploys(ctx.accountId, ctx.operationId);
			checkBudget(operation.blastRadius, operation.budget, running);
		}
		await store.mutate(ctx.operationId, (current) => transition(current, 'running', now()));
	});
}

export async function acquireLease(ctx: Ctx, planStepId: string): Promise<void> {
	const { leases, store, now, config } = ctx.deps;
	ctx.epoch = await runStep(ctx, planStepId, planStepId, async () => {
		const granted = await leases.acquire(ctx.siteId, {
			holder: ctx.operationId,
			purpose: ctx.purpose,
			ttlMs: config.leaseTtlMs
		});
		if (!granted.ok) throw new SiteBusyError(ctx.siteId, granted.heldBy);
		await store.mutate(ctx.operationId, (operation) =>
			bindEpoch(operation, granted.epoch, now())
		);
		return granted.epoch;
	});
}

export async function releaseLease(ctx: Ctx): Promise<void> {
	if (ctx.epoch === null) return;
	const epoch = ctx.epoch;
	await plainStep(ctx, 'release-lease', async () => {
		// refused means another holder owns it now, which is not ours to undo
		await ctx.deps.leases.release(ctx.siteId, { holder: ctx.operationId, epoch });
	});
}

export async function finishSuccess(ctx: Ctx, summary: string): Promise<void> {
	const { store, now } = ctx.deps;
	await plainStep(ctx, 'finalize', async () => {
		await store.mutate(ctx.operationId, (operation) =>
			operation.status === 'succeeded'
				? operation
				: transition(observe(operation, summary, now()), 'succeeded', now())
		);
	});
}

// a refused admission never started, so it is cancelled; anything later failed
export async function closeFailed(ctx: Ctx, failure: StepFailed): Promise<'failed' | 'cancelled'> {
	const { store, now } = ctx.deps;
	const summary = `${failure.step}: ${messageOf(failure.reason)}`;
	return plainStep(ctx, 'fail', async () => {
		const operation = await store.get(ctx.operationId);
		if (operation === null)
			throw new OperationError('not_found', `no operation ${ctx.operationId}`);
		const to = operation.status === 'planned' ? 'cancelled' : 'failed';
		await store.mutate(ctx.operationId, (current) => {
			if (current.status === to || current.status === 'rolled-back') return current;
			const marked = OPEN_STATUSES.includes(current.status)
				? failStep(current, failure.step, summary, now())
				: current;
			return skipPending(observe(transition(marked, to, now()), summary, now()), now());
		});
		return to;
	});
}

export function describeFailure(failure: StepFailed): string {
	return `${failure.step}: ${messageOf(failure.reason)}`;
}
