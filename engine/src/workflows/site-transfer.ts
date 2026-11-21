import type { Plan } from '@contracts/operations';
import { scriptName } from '@contracts/sites';
import { bumpEpoch } from '../adapters/authority';
import type { MoveRequest, SiteMoves } from '../adapters/site-moves';
import { buildPlan, setVerification, transition } from '../operations/state';
import type { EngineDeps } from '../ports';
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

export interface SiteTransferInput {
	operationId: string;
	transferId: string;
	siteId: string;
	// the organisation that holds the site now, and the one that receives it
	fromOrgId: string;
	toOrgId: string;
	accountId: string;
}

export type TransferDeps = EngineDeps & { moves: SiteMoves };

export function planSiteTransfer(input: Pick<SiteTransferInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'site.transfer',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is held by the sending organisation and the receiving one accepted it`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'copy', name: 'Copy the site records to the receiving organisation' },
			{
				id: 'flip',
				name: 'Hand over ownership, billing and access, and raise the routing epoch'
			},
			{
				id: 'retire',
				name: 'Check the copy and remove the records from the sending organisation'
			},
			{ id: 'verify', name: 'Read the handover back' }
		]
	});
}

const requestOf = (input: SiteTransferInput): MoveRequest => ({
	transferId: input.transferId,
	siteId: input.siteId,
	fromOrgId: input.fromOrgId,
	toOrgId: input.toOrgId
});

async function assertOwn(deps: TransferDeps, input: SiteTransferInput): Promise<void> {
	const operation = await deps.store.get(input.operationId);
	if (
		operation === null ||
		operation.type !== 'site.transfer' ||
		operation.orgId !== input.fromOrgId ||
		!operation.targetIds.includes(input.siteId)
	) {
		throw new PermanentError(
			'operation_mismatch',
			`${input.operationId} is not a transfer of ${input.siteId}`
		);
	}
	if (!(await deps.moves.accepted(requestOf(input)))) {
		throw new PermanentError(
			'transfer_not_accepted',
			`${input.transferId} is not an accepted transfer of ${input.siteId}`
		);
	}
}

// the marker holds the epoch the site had before the move; a replay of the copy leaves it alone
async function copy(ctx: Ctx, deps: TransferDeps, input: SiteTransferInput): Promise<number> {
	return runStep(ctx, 'copy', 'copy', async () => {
		await fenced(ctx);
		await assertOwn(deps, input);
		const request = requestOf(input);
		const authority = await deps.authority.read(input.siteId);
		if (authority === null) {
			throw new PermanentError('no_authority', `${input.siteId} has no authority record`);
		}
		await deps.moves.begin(request, deps.now(), authority.epoch);
		// two organisations on one database already share the rows, so only the marker is written
		if (await deps.moves.sameShard(request)) return 0;
		const collisions = await deps.moves.collisions(request);
		if (collisions.length > 0) {
			throw new PermanentError(
				'hostname_collision',
				`${collisions.join(', ')} already belongs to another site of the receiving organisation`
			);
		}
		// a copy that was cut short is completed by the insert-or-ignore of every row
		return (await deps.moves.copy(request)).rows;
	});
}

// ownership, billing and designated access change in one batch on the receiving shard; the epoch
// rises once, found by comparing it with the epoch the marker recorded, and every route the site
// answers on is written again with the new epoch, because a route with the old one is refused
async function flip(ctx: Ctx, deps: TransferDeps, input: SiteTransferInput): Promise<void> {
	await runStep(ctx, 'flip', 'flip', async () => {
		await fenced(ctx);
		const request = requestOf(input);
		const held = await deps.moves.incoming(request);
		if (held === null) {
			throw new PermanentError('not_copied', `${input.siteId} was not copied first`);
		}
		await deps.moves.flip(request, deps.now());
		const current = await deps.authority.read(input.siteId);
		if (current === null) {
			throw new PermanentError('no_authority', `${input.siteId} has no authority record`);
		}
		if (held.epochBefore === null || current.epoch <= held.epochBefore) {
			await bumpEpoch(deps.authority, input.siteId);
		}
		const raised = await deps.authority.read(input.siteId);
		if (raised === null) {
			throw new PermanentError('no_authority', `${input.siteId} has no authority record`);
		}
		for (const host of await deps.moves.hostnames(request)) {
			await deps.authority.putHost(host, {
				siteId: input.siteId,
				script: scriptName(input.siteId),
				epoch: raised.epoch
			});
		}
	});
}

// the read back runs before the source rows go; a mismatch keeps them and fails the operation
async function retire(ctx: Ctx, deps: TransferDeps, input: SiteTransferInput): Promise<void> {
	await runStep(ctx, 'retire', 'retire', async () => {
		await fenced(ctx);
		const request = requestOf(input);
		if (!(await deps.moves.flipped(request))) {
			throw new PermanentError('not_flipped', `${input.siteId} was not handed over first`);
		}
		if (await deps.moves.sameShard(request)) {
			await deps.moves.tombstone(request, deps.now());
		} else if (!(await deps.moves.tombstoned(request))) {
			const mismatches = await deps.moves.compare(request);
			if (mismatches.length > 0) {
				const first = mismatches[0]!;
				throw new PermanentError(
					'read_back_mismatch',
					`${mismatches.length} records differ after the copy (${first.table} ${first.key} is ${first.reason})`
				);
			}
			await deps.moves.retire(request, deps.now());
		}
		await deps.moves.complete(request, deps.now());
	});
}

async function verify(ctx: Ctx, deps: TransferDeps, input: SiteTransferInput): Promise<void> {
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		const request = requestOf(input);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const held = await deps.moves.incoming(request);
		const current = await deps.authority.read(input.siteId);
		if (held === null || !(await deps.moves.flipped(request))) {
			throw new PermanentError('not_flipped', `${input.siteId} is not held by the receiver`);
		}
		if (current === null || held.epochBefore === null || current.epoch <= held.epochBefore) {
			throw new PermanentError(
				'epoch_not_raised',
				`${input.siteId} still serves under the old routing epoch`
			);
		}
		if (!(await deps.moves.tombstoned(request))) {
			throw new PermanentError('not_flipped', `${input.siteId} left no tombstone`);
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

export async function runSiteTransfer(
	step: StepRunner,
	deps: TransferDeps,
	input: SiteTransferInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'site.transfer',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		await copy(ctx, deps, input);
		await flip(ctx, deps, input);
		await retire(ctx, deps, input);
		await verify(ctx, deps, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		await releaseLease(ctx);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	await finishSuccess(
		ctx,
		`${input.siteId} now belongs to ${input.toOrgId} and serves under a raised routing epoch`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
