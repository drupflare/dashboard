import { canonicalJson } from '@contracts/common';
import type { Plan } from '@contracts/operations';
import { withAccess } from '@contracts/site-auth';
import { accessGates } from '../../../src/shared/access-presets';
import { buildPlan, setVerification, transition } from '../operations/state';
import type { AccessDeps, EngineDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';

export interface AccessSyncInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
}

export interface AccessDigests {
	accessRuleHash: string;
	gates: Record<string, string>;
}

// the site and every environment copy that serves from its own authority
interface Digests {
	access: AccessDigests;
	copies: string[];
}

export function planAccessSync(input: Pick<AccessSyncInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'access.sync',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is active and has an authority record`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'digests', name: 'Work out the digest of every environment' },
			{ id: 'write', name: 'Write the digests to the site authority' },
			{ id: 'verify', name: 'Read the authority back' }
		]
	});
}

export async function digestsOf(
	deps: Pick<AccessDeps, 'access'>,
	orgId: string,
	siteId: string
): Promise<Digests> {
	const { rules, environments } = await deps.access.load(orgId, siteId);
	return {
		access: await accessGates(
			environments.map((environment) => environment.id),
			rules
		),
		copies: environments.flatMap((environment) =>
			environment.siteId === null ? [] : [environment.siteId]
		)
	};
}

// the same digests give back the current state, so a repeat writes nothing; an environment copy
// that has no authority yet (a failed create) is skipped, the site itself must have one
export async function writeDigests(
	deps: Pick<EngineDeps, 'authority'>,
	siteId: string,
	access: AccessDigests,
	required: boolean
): Promise<void> {
	const current = await deps.authority.read(siteId);
	if (current === null) {
		if (required) throw new PermanentError('no_authority', `${siteId} has no authority record`);
		return;
	}
	const next = withAccess(current, access);
	if (next === current) return;
	await deps.authority.apply(next);
}

export async function checkDigests(
	deps: Pick<EngineDeps, 'authority'>,
	siteId: string,
	access: AccessDigests,
	required: boolean
): Promise<void> {
	const held = await deps.authority.read(siteId);
	if (held === null) {
		if (required) throw new PermanentError('no_authority', `${siteId} has no authority record`);
		return;
	}
	if (
		held.accessRuleHash !== access.accessRuleHash ||
		canonicalJson(held.gates ?? {}) !== canonicalJson(access.gates)
	) {
		throw new PermanentError(
			'authority_unchanged',
			`${siteId} still holds the old access digests after the write`
		);
	}
}

async function assertOwn(deps: AccessDeps, input: AccessSyncInput): Promise<void> {
	const operation = await deps.store.get(input.operationId);
	if (
		operation === null ||
		operation.orgId !== input.orgId ||
		!operation.targetIds.includes(input.siteId)
	) {
		throw new PermanentError(
			'operation_mismatch',
			`${input.operationId} is not an access change of ${input.siteId}`
		);
	}
}

export async function runAccessSync(
	step: StepRunner,
	deps: AccessDeps,
	input: AccessSyncInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'access.sync',
		epoch: null
	};
	let digests: Digests;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		digests = await runStep(ctx, 'digests', 'digests', async () => {
			await fenced(ctx);
			await assertOwn(deps, input);
			return digestsOf(deps, input.orgId, input.siteId);
		});
		await runStep(ctx, 'write', 'write', async () => {
			await fenced(ctx);
			await writeDigests(deps, input.siteId, digests.access, true);
			for (const copy of digests.copies)
				await writeDigests(deps, copy, digests.access, false);
		});
		await runStep(ctx, 'verify', 'verify', async () => {
			await fenced(ctx);
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.status === 'running'
					? transition(operation, 'verifying', deps.now())
					: operation
			);
			await checkDigests(deps, input.siteId, digests.access, true);
			for (const copy of digests.copies)
				await checkDigests(deps, copy, digests.access, false);
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.verification === 'passed'
					? operation
					: setVerification(operation, 'passed', deps.now())
			);
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		await releaseLease(ctx);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	const gated = Object.keys(digests.access.gates).length;
	await finishSuccess(
		ctx,
		`${input.siteId} holds the access digests of ${gated} gated environments and was read back`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
