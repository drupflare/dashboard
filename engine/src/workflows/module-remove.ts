import type { Plan } from '@contracts/operations';
import { guardRemoval } from '../../../src/server/domain/module-removal';
import { machineName, type ModuleRow } from '../../../src/shared/modules';
import { buildPlan } from '../operations/state';
import type { ModuleDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
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
	openForChange,
	readModule,
	RESTORE_POINT_STEPS,
	stopFailed,
	takeRestorePoint,
	verifiedStep,
	withOwnerToken,
	type ModuleInput
} from './module-common';

export const NEEDS_WORKER_UPDATE = 'Removing Modules Needs a Worker Update';

export interface ModuleRemoveInput extends ModuleInput {
	// the census row as the dashboard read it; null when the name is not on the list
	census: ModuleRow | null;
}

export function planModuleRemove(
	input: Pick<ModuleRemoveInput, 'siteId' | 'name' | 'backupId'>
): Plan {
	return buildPlan({
		type: 'module.remove',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`no enabled module needs ${input.name}`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Ask the site what removing the module would change' },
			...RESTORE_POINT_STEPS,
			{ id: 'remove', name: `Turn off and remove ${input.name}` },
			{ id: 'verify', name: 'Check that the module is gone' }
		],
		rollbackPoint: input.backupId
	});
}

// nothing is changed here: the site only reports what a removal would touch
async function preflight(ctx: Ctx, deps: ModuleDeps, input: ModuleRemoveInput) {
	const project = machineName(input.name);
	return openForChange(ctx, deps, input, async (site) => {
		const answer = await withOwnerToken(deps, input, site, (auth) =>
			deps.modules.uninstall(site.hostname, project, { dryRun: true }, auth)
		);
		if (answer.kind === 'not_available') {
			throw new PermanentError('not_available', NEEDS_WORKER_UPDATE);
		}
		if (answer.kind !== 'plan') {
			throw new PermanentError(
				'removal_unreadable',
				'The site did not say what removal would change.'
			);
		}
		const verdict = guardRemoval({
			name: input.name,
			enabledModules: answer.enabledModules,
			dependents: answer.dependents,
			census: { modules: input.census === null ? [] : [input.census] },
			wouldDelete: answer.wouldDelete
		});
		if (!verdict.ok) throw new PermanentError('removal_refused', verdict.reason);
	});
}

export async function runModuleRemove(
	step: StepRunner,
	deps: ModuleDeps,
	input: ModuleRemoveInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'module.remove',
		epoch: null
	};
	const project = machineName(input.name);
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const site = await preflight(ctx, deps, input);
		await takeRestorePoint(ctx, deps, input, `Restore point before removing ${input.name}`);
		await runStep(ctx, 'remove', 'remove', async () => {
			await fenced(ctx);
			// a lost answer from an earlier run leaves the module off, and a second call would find nothing
			if (!(await readModule(deps, input, site, project)).enabled) return;
			const answer = await withOwnerToken(deps, input, site, (auth) =>
				deps.modules.uninstall(site.hostname, project, { dryRun: false }, auth)
			);
			if (answer.kind !== 'removed') {
				throw new PermanentError(
					'remove_failed',
					`The site could not remove ${input.name}.`
				);
			}
		});
		await verifiedStep(ctx, deps, async () => {
			if ((await readModule(deps, input, site, project)).enabled) {
				throw new PermanentError(
					'remove_unverified',
					'The site still shows the module as on after the removal.'
				);
			}
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return stopFailed(ctx, deps, input, error, {
			changing: ['remove', 'verify'],
			project,
			unchanged: (reading) => reading.enabled,
			asWas: 'the module was not removed and the site was left as it was.',
			unknown: 'the module may be partly removed.'
		});
	}
	await finishSuccess(ctx, `${input.name} is removed from ${input.siteId}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
