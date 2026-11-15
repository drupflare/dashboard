import type { Plan } from '@contracts/operations';
import type { SitePlane } from '@contracts/sites';
import { buildPlan } from '../operations/state';
import type { CopyDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
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
import { ACTIONS } from './site-cleanup';

export interface EnvDeleteInput {
	operationId: string;
	orgId: string;
	environment: { id: string };
	// the environment's own site, never the site it was copied from
	siteId: string;
	accountId: string;
	plane: SitePlane;
	hostname: string;
	subdomain: string;
}

export function planEnvDelete(input: Pick<EnvDeleteInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'env.delete',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is a copy made for an environment`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'stop', name: 'Stop the copy serving' },
			{ id: 'script', name: 'Delete the script and routes' },
			{ id: 'resources', name: 'Delete the copy storage' },
			{ id: 'name', name: 'Release the name' },
			{ id: 'forget', name: 'Mark the copy deleted' },
			{ id: 'record', name: 'Mark the environment deleted' }
		]
	});
}

// the same actions a cleanup runs: each one touches only what this site's own ledger and route
// name, newest first, so nothing the run did not record is deleted. A half-done delete is finished
// by running it again
export async function runEnvDelete(
	step: StepRunner,
	deps: CopyDeps,
	input: EnvDeleteInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'env.delete',
		epoch: null
	};
	const notes: string[] = [];
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		for (const [id, action] of ACTIONS) {
			const note = await runStep(ctx, id, id, async () => {
				await fenced(ctx);
				return (await action(deps, input)) ?? null;
			});
			if (note !== null) notes.push(note);
		}
		await runStep(ctx, 'record', 'record', async () => {
			await fenced(ctx);
			await deps.environments.setStatus(
				input.orgId,
				input.environment.id,
				'deleted',
				deps.now()
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
	const left = notes.length === 0 ? '' : `; ${notes.join('; ')}`;
	await finishSuccess(ctx, `${input.siteId} was deleted${left}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
