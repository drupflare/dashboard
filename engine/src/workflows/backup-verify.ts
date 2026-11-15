import type { Plan } from '@contracts/operations';
import { buildPlan } from '../operations/state';
import type { CopyDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	fenced,
	finishSuccess,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';
import {
	buildCopy,
	copyPlanSteps,
	discardCopy,
	rollBackCopy,
	type CopyInput
} from './restored-copy';

export function planBackupVerify(input: CopyInput): Plan {
	return buildPlan({
		type: 'backup.verify',
		targetIds: [input.create.site.id],
		preconditions: [`${input.backupId} is a restorable backup of this organisation`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			...copyPlanSteps(input.create),
			{ id: 'cleanup', name: 'Delete the scratch site' },
			{ id: 'record', name: 'Record that the backup restored' }
		]
	});
}

// the backup is restored into a scratch site of its own and probed. It reads verified only when the
// probes pass; a failure leaves it unverified, says why on the operation, and removes the scratch
// site all the same. A failed run is started again, since nothing here is kept
export async function runBackupVerify(
	step: StepRunner,
	deps: CopyDeps,
	input: CopyInput
): Promise<Outcome> {
	const { create } = input;
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: create.site.id,
		accountId: create.site.accountId,
		purpose: 'backup.verify',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		await buildCopy(ctx, deps, input);
		await runStep(ctx, 'cleanup', 'cleanup', async () => {
			await fenced(ctx);
			await discardCopy(deps, create);
		});
		await runStep(ctx, 'record', 'record', async () => {
			await fenced(ctx);
			await deps.verifications.markVerified(input.orgId, input.backupId, deps.now());
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollBackCopy(ctx, deps, create, error, 'failed');
	}
	await finishSuccess(
		ctx,
		`${input.backupId} restored into a scratch site and passed its probes`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
