import type { Plan } from '@contracts/operations';
import {
	initialState,
	isTerminal,
	next,
	type CutoverAction,
	type CutoverEvent,
	type CutoverState,
	type PostWriteChoice,
	type SourceWritePolicy
} from '../../../src/server/domain/cutover';
import { failureReason } from '../../../src/shared/operation-copy';
import {
	buildPlan,
	observe,
	setCursor,
	setVerification,
	stepOf,
	transition,
	transitionStep
} from '../operations/state';
import type { ChangeDialect, CutoverDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	closeFailed,
	fenced,
	finishSuccess,
	plainStep,
	runStep,
	SiteBusyError,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export const APPROVAL_EVENT = 'cutover-approval';
export const DECISION_EVENT = 'cutover-decision';
// nothing sends this; a wait on it is a sleep that survives a restart
export const SETTLE_EVENT = 'cutover-settle';

export interface MigrationCutoverInput {
	operationId: string;
	orgId: string;
	// the managed site an import built; it takes the traffic
	site: { id: string; accountId: string };
	// opaque to the engine; the source adapter resolves it
	source: { ref: string };
	// the address that moves from the source to the managed site
	hostname: string;
	policy: SourceWritePolicy;
	ttlSeconds: number;
	expectedWindowSeconds: number | null;
	approvalTimeoutMs: number;
	choiceTimeoutMs: number;
}

export type DecisionPayload = { kind: 'rollback' } | { kind: 'choice'; value: PostWriteChoice };

// a wait ends with the event's payload, or null when its time ran out
export interface CutoverRunner extends StepRunner {
	wait(name: string, type: string, timeoutMs: number): Promise<{ payload: unknown } | null>;
}

export const OBSERVE_STEP_IDS = ['observe-5m', 'observe-30m', 'observe-6h', 'observe-24h'] as const;

export const CUTOVER_STEP_IDS = [
	'lease',
	'lower-ttl',
	'snapshot',
	'capture-delta',
	'validate',
	'owner-approval',
	'apply-write-policy',
	'final-delta',
	'promote',
	'route',
	...OBSERVE_STEP_IDS
] as const;

export function planMigrationCutover(input: MigrationCutoverInput): Plan {
	return buildPlan({
		type: 'migration.cutover',
		targetIds: [input.site.id],
		preconditions: [
			`${input.site.id} is a live managed site built from the source`,
			`${input.hostname} is the address that moves`,
			'the source is not changed or deleted by this operation'
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'lower-ttl', name: 'Lower the DNS TTL' },
			{ id: 'snapshot', name: 'Take a consistent snapshot of the source' },
			{ id: 'capture-delta', name: 'Capture changes made since the snapshot' },
			{ id: 'validate', name: 'Check the new site against the snapshot and the changes' },
			{ id: 'owner-approval', name: 'Wait for the owner to approve' },
			{ id: 'apply-write-policy', name: 'Apply the write policy to the source' },
			{ id: 'final-delta', name: 'Copy the last changes' },
			{ id: 'promote', name: 'Promote the new site' },
			{ id: 'route', name: `Route ${input.hostname}` },
			{ id: 'observe-5m', name: 'Check the new site after 5 minutes' },
			{ id: 'observe-30m', name: 'Check the new site after 30 minutes' },
			{ id: 'observe-6h', name: 'Check the new site after 6 hours' },
			{ id: 'observe-24h', name: 'Check the new site after 24 hours' }
		],
		rollbackPoint: 'before the new site accepts its first write'
	});
}

const iso = (ms: number) => new Date(ms).toISOString();

// the plan step a wait or an observation belongs to
const observeStepId = (index: number) => OBSERVE_STEP_IDS[index] ?? 'observe-24h';

function decisionOf(payload: unknown): DecisionPayload | null {
	const value = payload as { kind?: unknown; value?: unknown } | null;
	if (value?.kind === 'rollback') return { kind: 'rollback' };
	if (
		value?.kind === 'choice' &&
		(value.value === 'keep-new' ||
			value.value === 'abandon-new-data' ||
			value.value === 'export-changes')
	) {
		return { kind: 'choice', value: value.value };
	}
	return null;
}

class Run {
	state: CutoverState;
	private n = 0;
	private routedAt = 0;
	private leaked: string[] = [];
	// set when the promote step is reached, so the count is ended at any exit that follows
	private counting = false;
	private countLeft = false;

	constructor(
		readonly ctx: Ctx,
		readonly runner: CutoverRunner,
		readonly deps: CutoverDeps,
		readonly input: MigrationCutoverInput
	) {
		this.state = initialState(input.policy, input.expectedWindowSeconds);
	}

	get source() {
		return this.deps.cutover.source(this.input.source.ref, this.input.orgId);
	}

	get destination() {
		return this.deps.cutover.destination(this.input.site.id);
	}

	// one id per call, the same on every replay because the calls happen in the same order
	id(label: string): string {
		return `${label}.${++this.n}`;
	}

	key(label: string): string {
		return `${this.input.operationId}:${label}`;
	}

	// records the new state on the operation and answers the next action
	async advance(event: CutoverEvent, at: string): Promise<CutoverAction> {
		const transitionTo = next(this.state, event, at);
		this.state = transitionTo.state;
		const saved = JSON.stringify(this.state);
		await plainStep(this.ctx, this.id('state'), async () => {
			await this.deps.store.mutate(this.ctx.operationId, (operation) =>
				setCursor(operation, saved, this.deps.now())
			);
		});
		return transitionTo.action;
	}

	// a mutating plan step: fenced, keyed, and its event stamped inside the same workflow step
	async effect<T>(
		label: string,
		stepId: string,
		work: (key: string) => Promise<T>,
		options: { finish?: boolean } = {}
	): Promise<{ value: T; at: string }> {
		const key = this.key(label);
		return runStep(
			this.ctx,
			this.id(label),
			stepId,
			async () => {
				await fenced(this.ctx);
				const value = await work(key);
				return { value, at: iso(this.deps.now()) };
			},
			options
		);
	}

	// a check that found a conflict ran fine and still failed its plan step, with the plain problem
	async settle(stepId: string, problem: string | null): Promise<void> {
		const { deps, ctx } = this;
		await plainStep(ctx, this.id(`settle-${stepId}`), async () => {
			await deps.store.mutate(ctx.operationId, (operation) => {
				const current = stepOf(operation, stepId);
				if (current.state === 'succeeded' || current.state === 'failed') return operation;
				return problem === null
					? transitionStep(operation, stepId, 'succeeded', deps.now())
					: transitionStep(operation, stepId, 'failed', deps.now(), problem);
			});
		});
	}

	async release(): Promise<void> {
		const { ctx, deps } = this;
		if (ctx.epoch === null) return;
		const epoch = ctx.epoch;
		await plainStep(ctx, this.id('release-lease'), async () => {
			await deps.leases.release(ctx.siteId, { holder: ctx.operationId, epoch });
		});
	}

	async clock(): Promise<number> {
		return plainStep(this.ctx, this.id('clock'), async () => this.deps.now());
	}

	// the lease covers each stretch of work, not the waits between them
	async hold(label: string): Promise<void> {
		const { ctx, deps } = this;
		ctx.epoch = await plainStep(ctx, this.id(`lease-${label}`), async () => {
			const granted = await deps.leases.acquire(ctx.siteId, {
				holder: ctx.operationId,
				purpose: ctx.purpose,
				ttlMs: deps.config.leaseTtlMs
			});
			if (!granted.ok) throw new SiteBusyError(ctx.siteId, granted.heldBy);
			return granted.epoch;
		});
	}

	// #region the steps

	async perform(action: CutoverAction): Promise<CutoverAction> {
		const { input } = this;
		switch (action.do) {
			case 'lower-ttl': {
				const { value, at } = await this.effect('lower-ttl', 'lower-ttl', (key) =>
					this.source.lowerTtl(key, input.hostname, input.ttlSeconds)
				);
				return this.advance(
					{ type: 'ttl-lowered', previousTtlSeconds: value.previousTtlSeconds },
					at
				);
			}
			case 'snapshot': {
				const { value, at } = await this.effect('snapshot', 'snapshot', (key) =>
					this.source.snapshot(key)
				);
				return this.advance({ type: 'snapshot-taken', marker: value.marker }, at);
			}
			case 'capture-delta': {
				const { value, at } = await this.effect('capture-delta', 'capture-delta', (key) =>
					this.source.delta(key, action.since)
				);
				return this.advance({ type: 'delta-captured', marker: value.marker }, at);
			}
			case 'validate': {
				const { value, at } = await this.effect(
					'validate',
					'validate',
					(key) => this.destination.validate(key, action.snapshot, action.delta),
					{ finish: false }
				);
				await this.settle('validate', value);
				return this.advance({ type: 'validated', problem: value }, at);
			}
			case 'await-approval':
				return this.approval();
			case 'apply-policy': {
				await this.hold('apply');
				const { at } = await this.effect(
					'apply-write-policy',
					'apply-write-policy',
					(key) => this.source.applyWritePolicy(key, action.policy)
				);
				return this.advance({ type: 'policy-applied' }, at);
			}
			case 'final-delta': {
				const { value, at } = await this.effect(
					'final-delta',
					'final-delta',
					async (key) => {
						const { marker } = await this.source.delta(key, action.since);
						const problem = await this.destination.validate(
							key,
							action.snapshot,
							marker
						);
						return { marker, problem };
					},
					{ finish: false }
				);
				await this.settle('final-delta', value.problem);
				return this.advance({ type: 'final-delta', ...value }, at);
			}
			case 'promote': {
				// the count starts in the same step, before the route step can switch the address
				this.counting = true;
				const { at } = await this.effect('promote', 'promote', async (key) => {
					const { counting } = await this.destination.promote(
						key,
						action.snapshot,
						action.delta
					);
					if (!counting) await this.destination.startCounting(key);
				});
				return this.advance({ type: 'promoted' }, at);
			}
			case 'route': {
				const { at } = await this.effect('route', 'route', (key) =>
					this.destination.route(key, 'destination', input.hostname)
				);
				this.routedAt = Date.parse(at);
				await this.release();
				return this.advance({ type: 'routed' }, at);
			}
			case 'wait-observation':
				return this.observation(action.index, action.offsetMs);
			case 'await-choice':
				return this.choice();
			case 'export-changes':
				return this.exportChanges();
			case 'final-changes':
				return this.finalChanges(action.since);
			case 'reverse':
				return this.reverse();
			case 'unwind':
				return this.unwind();
			case 'finish':
				return this.finish();
			default:
				throw new PermanentError('cutover_state', `no step for ${action.do}`);
		}
	}

	// the lease is released while the owner decides, which can take a day
	async approval(): Promise<CutoverAction> {
		const { ctx, input } = this;
		await this.release();
		await runStep(ctx, this.id('approval-begin'), 'owner-approval', async () => undefined, {
			finish: false
		});
		const heard = await this.runner.wait(
			this.id('approval'),
			APPROVAL_EVENT,
			input.approvalTimeoutMs
		);
		const at = iso(await this.clock());
		if (heard === null) return this.advance({ type: 'approval-timed-out' }, at);
		await runStep(ctx, this.id('approval-end'), 'owner-approval', async () => undefined, {
			begin: false
		});
		return this.advance({ type: 'approved' }, at);
	}

	// each wait ends at the observation time or when the owner sends a decision; a decision never
	// restarts the clock, so the point stays where the plan put it
	async observation(index: number, offsetMs: number): Promise<CutoverAction> {
		const stepId = observeStepId(index);
		for (;;) {
			const now = await this.clock();
			const remaining = this.routedAt + offsetMs - now;
			if (remaining <= 0) break;
			const heard = await this.runner.wait(this.id('wait'), DECISION_EVENT, remaining);
			if (heard === null) continue;
			const action = await this.decide(heard.payload);
			if (action !== null) return action;
		}
		let event: CutoverEvent;
		try {
			const { value } = await this.effectless(`observe-${index}`, stepId, () =>
				this.destination.observe(this.key('write-mark'))
			);
			event = { type: 'observed', healthy: value.healthy, writes: value.writes };
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			event = { type: 'observation-unreadable' };
		}
		return this.advance(event, iso(await this.clock()));
	}

	// a read, so it takes no lease and no fence
	async effectless<T>(
		label: string,
		stepId: string,
		work: () => Promise<T>
	): Promise<{ value: T }> {
		return { value: await runStep(this.ctx, this.id(label), stepId, work) };
	}

	async choice(): Promise<CutoverAction> {
		for (;;) {
			const heard = await this.runner.wait(
				this.id('choice'),
				DECISION_EVENT,
				this.input.choiceTimeoutMs
			);
			if (heard === null) {
				return this.advance({ type: 'choice-timed-out' }, iso(await this.clock()));
			}
			const action = await this.decide(heard.payload);
			if (action !== null) return action;
		}
	}

	// the count is read first, so the boundary is judged on what the new site holds now. A refusal
	// is recorded and the wait goes on, so it answers null
	async decide(payload: unknown): Promise<CutoverAction | null> {
		const decision = decisionOf(payload);
		if (decision === null) return null;
		const writes = await plainStep(this.ctx, this.id('count'), () =>
			this.destination.acceptedWrites(this.key('write-mark'))
		);
		const at = iso(await this.clock());
		await this.advance({ type: 'writes-counted', writes }, at);
		const action = await this.advance(
			decision.kind === 'rollback'
				? { type: 'rollback-requested' }
				: { type: 'choice-made', value: decision.value },
			at
		);
		return action.do === 'refuse' ? null : action;
	}

	async exportChanges(): Promise<CutoverAction> {
		await this.hold('export');
		const key = this.key('export-changes');
		const value = await plainStep(this.ctx, this.id('export-changes'), async () => {
			await fenced(this.ctx);
			return this.destination.exportChanges(key, SOURCE_DIALECT);
		});
		return this.advance({ type: 'changes-exported', ...value }, iso(await this.clock()));
	}

	// the address is back at the old site, but a visitor whose resolver still holds the new
	// address can reach the new site for one more cache time, so the second read waits that long
	async finalChanges(since: number): Promise<CutoverAction> {
		// the lease is let go while old caches expire, which can take hours
		await this.release();
		const settled = Date.parse(this.state.updatedAt ?? iso(await this.clock()));
		const until = settled + this.input.ttlSeconds * 1000;
		for (;;) {
			const remaining = until - (await this.clock());
			if (remaining <= 0) break;
			await this.runner.wait(this.id('settle'), SETTLE_EVENT, remaining);
		}
		await this.hold('final-changes');
		let event: CutoverEvent;
		try {
			const key = this.key('export-final');
			const value = await plainStep(this.ctx, this.id('export-final'), async () => {
				await fenced(this.ctx);
				return this.destination.exportFinalChanges(key, SOURCE_DIALECT, since);
			});
			event = { type: 'final-changes-exported', ...value };
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			event = { type: 'final-changes-unreadable' };
		}
		return this.advance(event, iso(await this.clock()));
	}

	// #endregion

	// #region undoing

	// each undo step runs on its own, so one that fails leaves the others done and names itself
	async undo(steps: [string, () => Promise<unknown>][]): Promise<string[]> {
		const leaked: string[] = [];
		for (const [name, work] of steps) {
			try {
				await plainStep(this.ctx, this.id(`undo-${name}`), async () => {
					await fenced(this.ctx);
					await work();
				});
			} catch (error) {
				if (!(error instanceof StepFailed)) throw error;
				leaked.push(name);
			}
		}
		this.leaked.push(...leaked);
		return leaked;
	}

	restoreTtl(): [string, () => Promise<unknown>][] {
		const previous = this.state.previousTtlSeconds;
		if (previous === null) return [];
		return [
			[
				'ttl',
				() => this.source.restoreTtl(this.key('restore-ttl'), this.input.hostname, previous)
			]
		];
	}

	// traffic never moved, so the source takes its writes back if the policy reached it and its
	// record goes back to what it was
	async unwind(): Promise<CutoverAction> {
		await this.hold('unwind');
		const frozen = POLICY_REACHED.includes(this.state.step ?? 'lower-ttl');
		const leaked = await this.undo([
			...(frozen
				? ([['writes', () => this.source.restoreWrites(this.key('restore-writes'))]] as [
						string,
						() => Promise<unknown>
					][])
				: []),
			...this.restoreTtl()
		]);
		const at = iso(await this.clock());
		return leaked.length === 0
			? this.advance({ type: 'unwound' }, at)
			: this.advance({ type: 'stuck', reason: stuckReason(leaked) }, at);
	}

	// traffic goes back to the source before its writes come back, so no visitor reaches two sites
	// that both take writes
	async reverse(): Promise<CutoverAction> {
		await this.hold('reverse');
		const leaked = await this.undo([
			[
				'route',
				() => this.destination.route(this.key('route-back'), 'source', this.input.hostname)
			],
			['writes', () => this.source.restoreWrites(this.key('restore-writes'))],
			...this.restoreTtl()
		]);
		const at = iso(await this.clock());
		return leaked.length === 0
			? this.advance({ type: 'reversed' }, at)
			: this.advance({ type: 'stuck', reason: stuckReason(leaked) }, at);
	}

	// the new site stays; the source keeps its frozen writes only until the record is restored
	async finish(): Promise<CutoverAction> {
		await this.hold('finish');
		const leaked = await this.undo(this.restoreTtl());
		const at = iso(await this.clock());
		return leaked.length === 0
			? this.advance({ type: 'finished' }, at)
			: this.advance({ type: 'stuck', reason: stuckReason(leaked) }, at);
	}

	// #endregion

	// every exit ends the count, since a live count costs the site extra rows on each write. Ending
	// is safe to repeat and safe when no count started. A failure is kept for the closing summary
	// and never changes how the move ends
	async endCounting(): Promise<void> {
		if (!this.counting) return;
		try {
			await plainStep(this.ctx, this.id('end-count'), () =>
				this.destination.stopCounting(this.key('write-mark'))
			);
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			this.countLeft = true;
		}
	}

	get stillCounting(): boolean {
		return this.countLeft;
	}

	get leakedSteps(): string[] {
		return this.leaked;
	}
}

const UNDOING: readonly CutoverAction['do'][] = ['unwind', 'reverse', 'finish', 'export-changes'];

const UNDO_WORDS: Record<string, string> = {
	ttl: 'restore the DNS cache time',
	writes: 'let your old site take writes again',
	route: 'point your address back at your old site'
};

const stuckReason = (leaked: string[]) =>
	`The move could not ${leaked.map((name) => UNDO_WORDS[name] ?? name).join(' or ')}. Check your old site and your DNS.`;

// the snapshot converts a MySQL dump only, so every source that reaches an export is MySQL or MariaDB
const SOURCE_DIALECT: ChangeDialect = 'mysql';

// the steps at which the source may already refuse writes
const POLICY_REACHED: readonly string[] = ['apply-write-policy', 'final-delta', 'promote'];

// the step a failure belongs to, for the operation's record
function stepOfFailure(state: CutoverState): string {
	if (state.step === 'observe') return observeStepId(Math.max(0, state.observed - 1));
	return state.step ?? 'lease';
}

async function close(run: Run, outcomeState: CutoverState): Promise<Outcome> {
	const { ctx, deps } = run;
	const reason = outcomeState.reason ?? 'The cutover stopped.';
	if (outcomeState.state === 'completed') {
		await plainStep(ctx, run.id('verified'), async () => {
			await deps.store.mutate(ctx.operationId, (operation) =>
				setVerification(operation, 'passed', deps.now())
			);
		});
		const writes = outcomeState.destinationWrites;
		await finishSuccess(
			ctx,
			`${run.input.hostname} now runs on ${run.input.site.id}; ${writes} writes were accepted and the source was kept${run.stillCounting ? '; the new site is still counting its writes' : ''}`
		);
		return { status: 'succeeded' };
	}
	const failure = new StepFailed(
		stepOfFailure(outcomeState),
		new PermanentError('cutover_stopped', reason)
	);
	await closeFailed(ctx, failure);
	if (outcomeState.state === 'rolled-back') {
		await plainStep(ctx, run.id('rollback-close'), async () => {
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.status === 'rolled-back'
					? operation
					: transition(
							observe(
								operation,
								`rolled back: ${reason}${run.stillCounting ? '; the new site is still counting its writes' : ''}`,
								deps.now()
							),
							'rolled-back',
							deps.now()
						)
			);
		});
		return { status: 'rolled-back', reason };
	}
	return {
		status: 'failed',
		reason,
		leaked: run.stillCounting ? [...run.leakedSteps, 'count'] : run.leakedSteps
	};
}

export async function runMigrationCutover(
	runner: CutoverRunner,
	deps: CutoverDeps,
	input: MigrationCutoverInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step: runner,
		operationId: input.operationId,
		siteId: input.site.id,
		accountId: input.site.accountId,
		purpose: 'migration.cutover',
		epoch: null
	};
	const run = new Run(ctx, runner, deps, input);
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const started = iso(await run.clock());
		let action = await run.advance({ type: 'start' }, started);
		while (action.do !== 'stop') {
			const doing = action.do;
			action = await run.perform(action).catch(async (error: unknown) => {
				if (!(error instanceof StepFailed)) throw error;
				const reason = plainReason(run.state);
				// a step that was already undoing cannot be sent to undo again
				const event: CutoverEvent = UNDOING.includes(doing)
					? { type: 'stuck', reason }
					: { type: 'step-failed', reason };
				return run.advance(event, iso(await run.clock()));
			});
			if (isTerminal(run.state) && action.do !== 'stop') {
				throw new PermanentError('cutover_state', 'a finished cutover was given more work');
			}
		}
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		await run.release();
		await run.endCounting();
		return close(run, { ...run.state, state: 'failed', reason: plainReason(run.state) });
	}
	await run.release();
	await run.endCounting();
	return close(run, run.state);
}

// the owner reads this, so it names the step in plain words and leaves the engine's error to the step record
function plainReason(state: CutoverState): string {
	return (
		failureReason({
			type: 'migration.cutover',
			status: 'failed',
			failedStep: stepOfFailure(state),
			failedError: null
		}) ?? 'Stopped before it could finish.'
	);
}
