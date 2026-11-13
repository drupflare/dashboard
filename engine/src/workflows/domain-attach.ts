import type { Plan } from '@contracts/operations';
import { scriptName } from '@contracts/sites';
import {
	DEFAULT_WAIT_MS,
	advance,
	currentStage,
	pollDelayMs,
	readAttachState,
	startState,
	visiblyChanged,
	type AttachEvent,
	type AttachState
} from '../../../src/server/domain/domain-attach';
import { attachFailureReason, checkHostname } from '../../../src/shared/domain-copy';
import { SiteAnswered, SiteUnreachable } from '../adapters/site';
import { buildPlan, setCursor, setVerification, stepOf, transitionStep } from '../operations/state';
import type { DomainDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	SiteBusyError,
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface DomainAttachInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	hostname: string;
	// how long the attach waits on the owner's DNS before it gives up
	waitMs?: number;
}

// the runner of a workflow that waits for the owner; a sleep costs no step budget
export interface DomainRunner extends StepRunner {
	sleep(name: string, ms: number): Promise<void>;
}

export function planDomainAttach(input: Pick<DomainAttachInput, 'siteId' | 'hostname'>): Plan {
	return buildPlan({
		type: 'domain.attach',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is a live managed site`,
			`${input.hostname} is a domain the owner controls and no other site holds`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'claim', name: `Claim ${input.hostname} for this site` },
			{ id: 'request', name: 'Ask for the ownership and certificate records' },
			{ id: 'ownership', name: 'Wait for the ownership record' },
			{ id: 'certificate', name: 'Wait for the certificate' },
			{ id: 'routing', name: `Route ${input.hostname} to the site` },
			{ id: 'verification', name: 'Load the site through the domain' }
		],
		rollbackPoint: 'before the domain is routed to the site'
	});
}

interface Claimed {
	epoch: number;
}

const STAGE_STEP = { ownership: 'ownership', certificate: 'certificate' } as const;

// the state lives in the operation's cursor, so a fresh instance and the page read the same thing
async function record(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	event: AttachEvent
): Promise<AttachState> {
	let result: AttachState | null = null;
	await deps.store.mutate(ctx.operationId, (operation) => {
		const current = readAttachState(operation.cursor) ?? startState(input.hostname, deps.now());
		const next = advance(current, event, deps.now());
		result = next;
		if (operation.cursor !== null && !visiblyChanged(current, next)) return operation;
		return setCursor(operation, JSON.stringify(next), deps.now());
	});
	return result as unknown as AttachState;
}

// a step that moves on the operation without doing the stage's work
async function mark(
	ctx: Ctx,
	deps: DomainDeps,
	name: string,
	stepId: string,
	to: 'running' | 'succeeded'
): Promise<void> {
	await plainStep(ctx, name, async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			const current = stepOf(operation, stepId);
			if (
				current.state === 'succeeded' ||
				(to === 'running' && current.state === 'running')
			) {
				return operation;
			}
			const started =
				current.state === 'running'
					? operation
					: transitionStep(operation, stepId, 'running', deps.now());
			return to === 'running'
				? started
				: transitionStep(started, stepId, 'succeeded', deps.now());
		});
	});
}

async function holdLease(ctx: Ctx, deps: DomainDeps, label: string): Promise<void> {
	ctx.epoch = await plainStep(ctx, `lease.${label}`, async () => {
		const granted = await deps.leases.acquire(ctx.siteId, {
			holder: ctx.operationId,
			purpose: ctx.purpose,
			ttlMs: deps.config.leaseTtlMs
		});
		if (!granted.ok) throw new SiteBusyError(ctx.siteId, granted.heldBy);
		return granted.epoch;
	});
}

// the lease covers each stretch of work and not the waits between them
async function dropLease(ctx: Ctx, deps: DomainDeps, label: string): Promise<void> {
	const epoch = ctx.epoch;
	ctx.epoch = null;
	if (epoch === null) return;
	await plainStep(ctx, `release.${label}`, async () => {
		await deps.leases.release(ctx.siteId, { holder: ctx.operationId, epoch });
	});
}

async function assertLiveSite(deps: DomainDeps, input: DomainAttachInput): Promise<void> {
	const site = await deps.domains.site(input.siteId);
	if (
		site === null ||
		site.state !== 'active' ||
		site.plane !== 'managed' ||
		site.organizationId !== input.orgId ||
		site.accountId !== input.accountId
	) {
		throw new PermanentError('site_not_ready', `${input.siteId} is not a live managed site`);
	}
}

async function claimHostname(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput
): Promise<Claimed> {
	return runStep(ctx, 'claim', 'claim', async () => {
		await fenced(ctx);
		const checked = checkHostname(input.hostname);
		if (!checked.ok) throw new PermanentError(checked.code, checked.message);
		await assertLiveSite(deps, input);
		const claim = await deps.domains.claim(
			checked.hostname,
			{
				organizationId: input.orgId,
				siteId: input.siteId,
				operationId: ctx.operationId
			},
			deps.now()
		);
		if (!claim.ok) {
			throw new PermanentError(
				'hostname_taken',
				`${checked.hostname} is held by another site`
			);
		}
		// the old holder is gone, so what it left behind stops serving before this site's attach goes on
		if (claim.previous !== null) {
			await deps.authority.deleteHostIfOwned(checked.hostname, claim.previous.siteId);
			if (claim.previous.providerId !== null) {
				await deps.hostnames.remove(claim.previous.providerId);
			}
		}
		return { epoch: claim.epoch };
	});
}

async function requestRecords(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	claimed: Claimed
): Promise<string> {
	return runStep(ctx, 'request', 'request', async () => {
		await fenced(ctx);
		const { providerId, observation } = await deps.hostnames.ensure(input.hostname);
		if (!(await deps.domains.setProvider(input.hostname, claimed.epoch, providerId))) {
			throw new PermanentError('hostname_taken', `${input.hostname} changed hands`);
		}
		await record(ctx, deps, input, { type: 'requested', records: observation.records });
		return providerId;
	});
}

// the claim that this operation holds, or the refusal that says it is gone
async function assertClaim(
	deps: DomainDeps,
	input: DomainAttachInput,
	claimed: Claimed
): Promise<void> {
	const row = await deps.domains.current(input.hostname);
	if (
		row === null ||
		row.epoch !== claimed.epoch ||
		row.siteId !== input.siteId ||
		row.state === 'released'
	) {
		throw new PermanentError(
			'hostname_taken',
			`${input.hostname} no longer belongs to this site`
		);
	}
}

function stateError(state: AttachState): PermanentError {
	const code = state.reason ?? 'unexpected';
	return new PermanentError(code, attachFailureReason(code) ?? code);
}

// polls the provider until the certificate is issued; every poll is one step and every wait a sleep
async function awaitCertificate(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	step: DomainRunner,
	claimed: Claimed,
	providerId: string
): Promise<void> {
	const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
	let state = await plainStep(
		ctx,
		'state.read',
		async () =>
			readAttachState((await deps.store.get(ctx.operationId))?.cursor ?? null) ??
			startState(input.hostname, deps.now())
	);
	for (let attempt = 0; state.stages.certificate !== 'done'; attempt++) {
		const stage = currentStage(state) === 'certificate' ? 'certificate' : 'ownership';
		const before = state;
		// the stage's own step carries a failure, so its error keeps the code the owner copy reads
		state = await runStep(
			ctx,
			`${STAGE_STEP[stage]}.poll.${attempt}`,
			STAGE_STEP[stage],
			async () => {
				await assertClaim(deps, input, claimed);
				// a read costs nothing at the provider; a forced check is the owner's nudge, so it is rare
				const found =
					attempt > 0 && attempt % 5 === 0
						? await deps.hostnames.refresh(providerId)
						: await deps.hostnames.read(providerId);
				const next = await record(
					ctx,
					deps,
					input,
					found === null
						? { type: 'failed', code: 'ownership_failed' }
						: { type: 'observed', observation: found.observation }
				);
				if (next.reason !== null) throw stateError(next);
				if (next.stages.certificate !== 'done' && deps.now() - next.startedAt >= waitMs) {
					await record(ctx, deps, input, { type: 'failed', code: 'wait_timed_out' });
					throw new PermanentError(
						'wait_timed_out',
						attachFailureReason('wait_timed_out') ?? ''
					);
				}
				return next;
			},
			{ begin: false, finish: false }
		);
		if (before.stages.ownership !== 'done' && state.stages.ownership === 'done') {
			await mark(ctx, deps, 'mark.ownership.done', 'ownership', 'succeeded');
			await mark(ctx, deps, 'mark.certificate.running', 'certificate', 'running');
		}
		if (state.stages.certificate === 'done') {
			await mark(ctx, deps, 'mark.certificate.done', 'certificate', 'succeeded');
			return;
		}
		await step.sleep(`${STAGE_STEP[stage]}.wait.${attempt}`, pollDelayMs(attempt));
	}
}

async function routeHostname(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	claimed: Claimed
): Promise<void> {
	await runStep(ctx, 'routing', 'routing', async () => {
		await fenced(ctx);
		await assertClaim(deps, input, claimed);
		await assertLiveSite(deps, input);
		const authority = await deps.authority.read(input.siteId);
		if (
			authority === null ||
			authority.state === 'revoked' ||
			authority.state === 'suspended'
		) {
			throw new PermanentError('site_not_ready', `${input.siteId} may not serve right now`);
		}
		await deps.authority.putHost(input.hostname, {
			siteId: input.siteId,
			script: scriptName(input.siteId),
			epoch: authority.epoch
		});
		// a claim that moved between the check and the write undoes the route this call just made
		if (!(await deps.domains.markRouted(input.hostname, claimed.epoch, input.siteId))) {
			await deps.authority.deleteHostIfOwned(input.hostname, input.siteId);
			throw new PermanentError('hostname_taken', `${input.hostname} changed hands`);
		}
		await record(ctx, deps, input, { type: 'routed' });
	});
}

async function answers(deps: DomainDeps, hostname: string): Promise<boolean> {
	try {
		await deps.site.probe(hostname, '/', 200);
		return true;
	} catch (error) {
		// a domain whose address record is not in place yet does not answer, which is not a failure
		if (error instanceof SiteUnreachable || error instanceof SiteAnswered) return false;
		throw error;
	}
}

async function awaitVerification(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	step: DomainRunner,
	claimed: Claimed
): Promise<void> {
	const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
	for (let attempt = 0; ; attempt++) {
		const state = await runStep(
			ctx,
			`verification.poll.${attempt}`,
			'verification',
			async () => {
				await assertClaim(deps, input, claimed);
				const answered = await answers(deps, input.hostname);
				const next = await record(ctx, deps, input, { type: 'verified', answered });
				if (next.stages.verification !== 'done' && deps.now() - next.startedAt >= waitMs) {
					await record(ctx, deps, input, { type: 'failed', code: 'site_unreachable' });
					throw new PermanentError(
						'site_unreachable',
						attachFailureReason('site_unreachable') ?? ''
					);
				}
				return next;
			},
			{ begin: false, finish: false }
		);
		if (state.stages.verification === 'done') {
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.verification === 'passed'
					? operation
					: setVerification(operation, 'passed', deps.now())
			);
			await mark(ctx, deps, 'mark.verification.done', 'verification', 'succeeded');
			return;
		}
		await step.sleep(`verification.wait.${attempt}`, pollDelayMs(attempt));
	}
}

function codeOf(failure: StepFailed): string {
	const cause = failure.reason;
	if (cause instanceof PermanentError) return cause.code;
	if (cause instanceof SiteUnreachable || cause instanceof SiteAnswered)
		return 'site_unreachable';
	return 'provider_unreachable';
}

// a failed attach takes back what this operation made and nothing it did not: the claim, the route and
// the provider's hostname
async function unwind(ctx: Ctx, deps: DomainDeps, input: DomainAttachInput): Promise<string[]> {
	try {
		await plainStep(ctx, 'unwind', async () => {
			const row = await deps.domains.current(input.hostname);
			if (row === null || row.operationId !== ctx.operationId || row.state === 'released')
				return;
			if (row.state === 'routed') {
				await deps.authority.deleteHostIfOwned(input.hostname, input.siteId);
			}
			if (row.providerId !== null) await deps.hostnames.remove(row.providerId);
			await deps.domains.release(input.hostname, row.epoch, input.siteId);
		});
		return [];
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return [`domain:${input.hostname}`];
	}
}

async function fail(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	failure: StepFailed
): Promise<Outcome> {
	const reason = describeFailure(failure);
	await plainStep(ctx, 'record.failed', async () => {
		await record(ctx, deps, input, { type: 'failed', code: codeOf(failure) });
	});
	const closed = await closeFailed(ctx, failure);
	const leaked = closed === 'cancelled' ? [] : await unwind(ctx, deps, input);
	await releaseLease(ctx);
	return closed === 'cancelled'
		? { status: 'cancelled', reason }
		: { status: 'failed', reason, leaked };
}

export async function runDomainAttach(
	step: DomainRunner,
	deps: DomainDeps,
	input: DomainAttachInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'domain.attach',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const claimed = await claimHostname(ctx, deps, input);
		const providerId = await requestRecords(ctx, deps, input, claimed);
		await mark(ctx, deps, 'mark.ownership.running', 'ownership', 'running');
		await dropLease(ctx, deps, 'wait');
		await awaitCertificate(ctx, deps, input, step, claimed, providerId);
		await holdLease(ctx, deps, 'routing');
		await routeHostname(ctx, deps, input, claimed);
		await dropLease(ctx, deps, 'routing');
		await mark(ctx, deps, 'mark.verification.running', 'verification', 'running');
		await awaitVerification(ctx, deps, input, step, claimed);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return fail(ctx, deps, input, error);
	}
	await finishSuccess(ctx, `${input.hostname} is attached and the site answers on it`);
	return { status: 'succeeded' };
}
