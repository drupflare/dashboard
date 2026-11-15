import type { Plan } from '@contracts/operations';
import { buildPlan } from '../operations/state';
import type { CopyDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { checkDigests, digestsOf, writeDigests } from './access-sync';
import {
	acquireLease,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';
import { buildCopy, copyPlanSteps, rollBackCopy, type CopyInput } from './restored-copy';

// the sealed copy of a site: its own script, storage and owner token, filled from one saved copy.
// Secrets are not carried. The environment record is the dashboard's own row, moved by status
export interface EnvCreateInput extends CopyInput {
	environment: { id: string };
}

export function planEnvCreate(input: EnvCreateInput): Plan {
	return buildPlan({
		type: 'env.create',
		targetIds: [input.create.site.id],
		preconditions: [
			`${input.backupId} is a restorable backup of this organisation`,
			`${input.create.hostname} is free`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			...copyPlanSteps(input.create),
			{ id: 'gate', name: 'Apply the environment access rules' },
			{ id: 'activate', name: 'Mark the copy ready' }
		],
		rollbackPoint: null
	});
}

// the copy answers behind its environment's rules before it is marked ready, so it is never public
async function gateCopy(ctx: Ctx, deps: CopyDeps, input: EnvCreateInput): Promise<void> {
	const siteId = input.create.site.id;
	await runStep(ctx, 'gate', 'gate', async () => {
		await fenced(ctx);
		const parent = await deps.access.parentOf(input.orgId, input.environment.id);
		if (parent === null) {
			throw new PermanentError(
				'environment_gone',
				`${input.environment.id} no longer exists`
			);
		}
		const { access } = await digestsOf(deps, input.orgId, parent);
		await writeDigests(deps, siteId, access, true);
		await checkDigests(deps, siteId, access, true);
	});
}

async function activateCopy(
	ctx: Ctx,
	deps: CopyDeps,
	input: EnvCreateInput,
	adminName: string | null,
	adminMail: string | null
) {
	const { create } = input;
	await runStep(ctx, 'activate', 'activate', async () => {
		await fenced(ctx);
		await deps.store.activateSite(
			{
				id: create.site.id,
				organizationId: create.site.orgId,
				name: create.site.name,
				plane: create.site.plane,
				accountId: create.site.accountId,
				category: create.site.category,
				config: create.site.config,
				releaseId: create.releaseId,
				adminName,
				adminMail
			},
			deps.now()
		);
		await deps.environments.setStatus(input.orgId, input.environment.id, 'ready', deps.now());
	});
}

// a failure before the copy went live removes what this run made and marks the environment failed;
// nothing here writes to the site it was copied from
export async function runEnvCreate(
	step: StepRunner,
	deps: CopyDeps,
	input: EnvCreateInput
): Promise<Outcome> {
	const { create } = input;
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: create.site.id,
		accountId: create.site.accountId,
		purpose: 'env.create',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const { sealed } = await buildCopy(ctx, deps, input);
		await gateCopy(ctx, deps, input);
		await activateCopy(ctx, deps, input, sealed.adminName ?? null, sealed.adminMail ?? null);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const outcome = await rollBackCopy(ctx, deps, create, error, 'rolled-back');
		// a copy that went live before the failure is kept, so it reads ready
		await plainStep(ctx, 'environment.status', async () => {
			const live = await deps.store.siteLive(create.site.id);
			await deps.environments.setStatus(
				input.orgId,
				input.environment.id,
				live ? 'ready' : 'failed',
				deps.now()
			);
		});
		return outcome;
	}
	await finishSuccess(
		ctx,
		`${create.site.id} is a copy of ${input.backupId} at ${create.hostname}; secrets were not carried`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
