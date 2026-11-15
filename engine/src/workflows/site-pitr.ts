import type { Plan } from '@contracts/operations';
import { buildPlan, setRollbackPoint } from '../operations/state';
import type { PitrDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite } from './backup-create';
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

export interface SitePitrInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	// the moment to go back to, in epoch milliseconds
	at: number;
}

export function planSitePitr(input: Pick<SitePitrInput, 'siteId' | 'at'>): Plan {
	return buildPlan({
		type: 'site.restore',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`${new Date(input.at).toISOString()} is inside the recovery window`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'check', name: 'Check the site' },
			{ id: 'bookmark', name: 'Find the recovery point for that moment' },
			{ id: 'schedule', name: 'Schedule the restore and keep the undo point' }
		]
	});
}

// the restore applies the next time the site starts, which this operation does not cause, so it ends
// once the restore is scheduled and the undo point is kept on the operation. The undo is returned
// only by the call that schedules, so a step that already saved one never calls again
export async function runSitePitr(
	step: StepRunner,
	deps: PitrDeps,
	input: SitePitrInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'site.restore',
		epoch: null
	};
	let at = '';
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const open = await runStep(ctx, 'check', 'check', async () => {
			await fenced(ctx);
			await assertOperationOrg(
				deps,
				ctx.operationId,
				input.orgId,
				'target_other_organisation'
			);
			return openSite(
				deps,
				{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
				{ notReady: 'target_not_ready', foreign: 'target_other_organisation' }
			);
		});
		const bookmark = await runStep(ctx, 'bookmark', 'bookmark', async () => {
			await fenced(ctx);
			return deps.custody.withOwnerToken(input.siteId, open.ownerTokenId, (bearer) =>
				deps.pitr.bookmarkAt(open.hostname, input.at, { bearer })
			);
		});
		await runStep(ctx, 'schedule', 'schedule', async () => {
			await fenced(ctx);
			const saved = (await deps.store.get(ctx.operationId))?.rollbackPoint ?? null;
			if (saved !== null) return;
			const scheduled = await deps.custody.withOwnerToken(
				input.siteId,
				open.ownerTokenId,
				(bearer) => deps.pitr.schedule(open.hostname, bookmark, { bearer })
			);
			await deps.store.mutate(ctx.operationId, (operation) =>
				operation.rollbackPoint === null
					? setRollbackPoint(operation, scheduled.undo, deps.now())
					: operation
			);
		});
		at = new Date(input.at).toISOString();
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
		`${input.siteId} will go back to ${at} the next time it starts; the undo point is saved`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
