import type { Plan } from '@contracts/operations';
import { scriptName } from '@contracts/sites';
import {
	isApex,
	readOwnership,
	readRouting,
	recordList
} from '../../../src/server/domain/dns-check';
import {
	DEFAULT_WAIT_MS,
	advance,
	isProven,
	pollDelayMs,
	readAttachState,
	startState,
	visiblyChanged,
	type AttachEvent,
	type AttachState
} from '../../../src/server/domain/domain-attach';
import { attachFailureReason, checkHostname } from '../../../src/shared/domain-copy';
import { SiteAnswered, SiteUnreachable } from '../adapters/site';
import {
	buildPlan,
	observe,
	setCursor,
	setVerification,
	skipPending,
	stepOf,
	transition,
	transitionStep
} from '../operations/state';
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
			{ id: 'ownership', name: 'Check the ownership record' },
			{ id: 'request', name: 'Ask the certificate service for its records' },
			{ id: 'certificate', name: 'Wait for the certificate' },
			{ id: 'routing', name: `Wait for the address record, then route ${input.hostname}` },
			{ id: 'verification', name: 'Load the site through the domain' }
		],
		rollbackPoint: 'before the domain is routed to the site'
	});
}

interface Claimed {
	epoch: number;
	// the ledger already holds this owner's proof for the epoch, so the check is skipped
	proven: boolean;
}

// the code the adapter throws when the provider is off; the operation parks instead of failing
const OFF = 'custom_domains_off';

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
		// an unproven claim yields to a challenger whose own value is published for the epoch after the
		// takeover, since that is the epoch the value on the page was derived from
		const claim = await deps.domains.claim(
			checked.hostname,
			{
				organizationId: input.orgId,
				siteId: input.siteId,
				operationId: ctx.operationId
			},
			deps.now(),
			async (epoch) => {
				const challenge = await deps.challenge({
					siteId: input.siteId,
					hostname: input.hostname,
					epoch
				});
				const seen = await readOwnership(deps.dns, input.hostname, challenge.accepted);
				return seen.status === 'ok';
			}
		);
		if (!claim.ok) {
			throw new PermanentError(
				claim.unproven === true ? 'hostname_unproven' : 'hostname_taken',
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
		const challenge = await deps.challenge({
			siteId: input.siteId,
			hostname: input.hostname,
			epoch: claim.epoch
		});
		const records = recordList({
			hostname: input.hostname,
			apex: await isApex(deps.dns, input.hostname),
			target: deps.target,
			challenge: challenge.value
		});
		await record(ctx, deps, input, { type: 'requested', records });
		const proven = isProven(await deps.domains.current(input.hostname));
		if (proven) await record(ctx, deps, input, { type: 'proven' });
		return { epoch: claim.epoch, proven };
	});
}

// a resolver that fails reads as not seen yet, so only the wait running out ends the stage
async function awaitOwnership(
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
			`ownership.poll.${attempt}`,
			'ownership',
			async () => {
				await assertClaim(deps, input, claimed);
				const challenge = await deps.challenge({
					siteId: input.siteId,
					hostname: input.hostname,
					epoch: claimed.epoch
				});
				const seen = await readOwnership(deps.dns, input.hostname, challenge.accepted);
				if (seen.status === 'ok') {
					if (
						!(await deps.domains.proveOwnership(
							input.hostname,
							claimed.epoch,
							input.siteId
						))
					) {
						throw new PermanentError(
							'hostname_displaced',
							`${input.hostname} changed hands`
						);
					}
					return record(ctx, deps, input, { type: 'proven' });
				}
				const next = await record(ctx, deps, input, { type: 'checked' });
				if (deps.now() - next.startedAt >= waitMs) {
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
		if (state.stages.ownership === 'done') {
			await mark(ctx, deps, 'mark.ownership.done', 'ownership', 'succeeded');
			return;
		}
		await step.sleep(`ownership.wait.${attempt}`, pollDelayMs(attempt));
	}
}

// the provider is the one outside call; when the account lacks the feature the attach parks, with
// ownership proven and the claim kept, and the owner tries again later
async function registerHostname(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	claimed: Claimed
): Promise<string | null> {
	const providerId = await runStep(
		ctx,
		'request',
		'request',
		async () => {
			await fenced(ctx);
			try {
				if (deps.target === null) throw new PermanentError(OFF, 'no target is configured');
				const { providerId, observation } = await deps.hostnames.ensure(input.hostname);
				if (!(await deps.domains.setProvider(input.hostname, claimed.epoch, providerId))) {
					throw new PermanentError(
						'hostname_displaced',
						`${input.hostname} changed hands`
					);
				}
				await record(ctx, deps, input, {
					type: 'registered',
					records: observation.records
				});
				return providerId;
			} catch (error) {
				if (!(error instanceof PermanentError) || error.code !== OFF) throw error;
				await record(ctx, deps, input, { type: 'parked', code: OFF });
				return null;
			}
		},
		{ begin: false, finish: false }
	);
	if (providerId === null) return null;
	await mark(ctx, deps, 'mark.request.running', 'request', 'running');
	await mark(ctx, deps, 'mark.request.done', 'request', 'succeeded');
	await mark(ctx, deps, 'mark.certificate.running', 'certificate', 'running');
	return providerId;
}

// the claim that this operation holds, or the refusal that says it is gone
async function assertClaim(
	deps: DomainDeps,
	input: DomainAttachInput,
	claimed: Claimed
): Promise<void> {
	const row = await deps.domains.current(input.hostname);
	// the owner gave the name up from the page, which is different from losing it to another site
	if (
		row !== null &&
		row.epoch === claimed.epoch &&
		row.siteId === input.siteId &&
		row.state === 'released'
	) {
		throw new PermanentError('attach_cancelled', `${input.hostname} was released by its owner`);
	}
	if (
		row === null ||
		row.epoch !== claimed.epoch ||
		row.siteId !== input.siteId ||
		row.state === 'released'
	) {
		throw new PermanentError(
			'hostname_displaced',
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
	for (let attempt = 0; ; attempt++) {
		const state = await runStep(
			ctx,
			`certificate.poll.${attempt}`,
			'certificate',
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
						? { type: 'failed', code: 'custom_domains_refused' }
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
		if (state.stages.certificate === 'done') {
			await mark(ctx, deps, 'mark.certificate.done', 'certificate', 'succeeded');
			return;
		}
		await step.sleep(`certificate.wait.${attempt}`, pollDelayMs(attempt));
	}
}

// waits for the routing record to resolve to the target and for the provider to call the hostname
// active; a resolver that fails is not a missing record
async function awaitRouting(
	ctx: Ctx,
	deps: DomainDeps,
	input: DomainAttachInput,
	step: DomainRunner,
	claimed: Claimed,
	providerId: string
): Promise<void> {
	const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;
	await mark(ctx, deps, 'mark.routing.running', 'routing', 'running');
	for (let attempt = 0; ; attempt++) {
		const ready = await runStep(
			ctx,
			`routing.poll.${attempt}`,
			'routing',
			async () => {
				await assertClaim(deps, input, claimed);
				const found = await deps.hostnames.read(providerId);
				const next = await record(
					ctx,
					deps,
					input,
					found === null
						? { type: 'failed', code: 'custom_domains_refused' }
						: { type: 'observed', observation: found.observation }
				);
				if (next.reason !== null) throw stateError(next);
				const seen =
					deps.target === null
						? null
						: await readRouting(deps.dns, input.hostname, deps.target);
				if (found?.observation.hostnameStatus === 'active' && seen?.status === 'ok') {
					return true;
				}
				if (deps.now() - next.startedAt >= waitMs) {
					await record(ctx, deps, input, { type: 'failed', code: 'wait_timed_out' });
					throw new PermanentError(
						'wait_timed_out',
						attachFailureReason('wait_timed_out') ?? ''
					);
				}
				return false;
			},
			{ begin: false, finish: false }
		);
		if (ready) return;
		await step.sleep(`routing.wait.${attempt}`, pollDelayMs(attempt));
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
			throw new PermanentError('hostname_displaced', `${input.hostname} changed hands`);
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

// the owner's domain is verified and nothing else can happen yet, so the operation ends here with its
// claim and proof kept; the remaining steps are skipped, and a new attach picks up from the proof
async function park(ctx: Ctx, deps: DomainDeps, input: DomainAttachInput): Promise<Outcome> {
	await plainStep(ctx, 'park', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'succeeded') return operation;
			const noted = observe(
				operation,
				`${input.hostname} is verified; custom domains are off, so nothing is attached`,
				deps.now()
			);
			return transition(
				setVerification(skipPending(noted, deps.now()), 'not-required', deps.now()),
				'succeeded',
				deps.now()
			);
		});
	});
	await releaseLease(ctx);
	return { status: 'waiting', reason: OFF };
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
		await mark(ctx, deps, 'mark.ownership.running', 'ownership', 'running');
		if (claimed.proven) {
			await mark(ctx, deps, 'mark.ownership.done', 'ownership', 'succeeded');
		} else {
			await dropLease(ctx, deps, 'ownership');
			await awaitOwnership(ctx, deps, input, step, claimed);
			await holdLease(ctx, deps, 'registration');
		}
		const providerId = await registerHostname(ctx, deps, input, claimed);
		if (providerId === null) return await park(ctx, deps, input);
		await dropLease(ctx, deps, 'certificate');
		await awaitCertificate(ctx, deps, input, step, claimed, providerId);
		await awaitRouting(ctx, deps, input, step, claimed, providerId);
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

// #region release

export interface ReleasedDomains {
	released: string[];
	// hostnames whose provider removal was refused; the claim stays so a later run retries
	failed: string[];
}

// frees every custom hostname a site holds: the route, the provider's hostname, then the claim; a
// hostname the site no longer owns is left alone, and a step that runs twice does the same
export async function releaseSiteDomains(
	deps: Pick<DomainDeps, 'authority' | 'hostnames' | 'domains'>,
	siteId: string
): Promise<ReleasedDomains> {
	const result: ReleasedDomains = { released: [], failed: [] };
	for (const row of await deps.domains.heldBy(siteId)) {
		try {
			await deps.authority.deleteHostIfOwned(row.hostname, siteId);
			if (row.providerId !== null) await deps.hostnames.remove(row.providerId);
		} catch (error) {
			// an unreachable provider is retried by the step; a refusal is reported
			if (!(error instanceof PermanentError)) throw error;
			result.failed.push(row.hostname);
			continue;
		}
		await deps.domains.release(row.hostname, row.epoch, siteId);
		result.released.push(row.hostname);
	}
	return result;
}

// #endregion
