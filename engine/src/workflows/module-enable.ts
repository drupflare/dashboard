import type { Plan } from '@contracts/operations';
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

export interface ModuleEnableInput extends ModuleInput {
	// the census row as the dashboard read it; null when the name is not on the list
	census: Pick<ModuleRow, 'state' | 'shipping' | 'reason'> | null;
}

export function planModuleEnable(
	input: Pick<ModuleEnableInput, 'siteId' | 'name' | 'backupId'>
): Plan {
	return buildPlan({
		type: 'module.enable',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`${input.name} is on the site`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the module' },
			...RESTORE_POINT_STEPS,
			{ id: 'enable', name: `Enable ${input.name}` },
			{ id: 'verify', name: 'Check that the module is on' }
		],
		rollbackPoint: input.backupId
	});
}

// a module that ships with every site may be off, so only an unknown or blocked row is refused
async function preflight(ctx: Ctx, deps: ModuleDeps, input: ModuleEnableInput) {
	return openForChange(ctx, deps, input, async (site) => {
		if (input.census === null) {
			throw new PermanentError('module_refused', 'That module is not on the list.');
		}
		if (input.census.state === 'blocked') {
			throw new PermanentError(
				'module_refused',
				input.census.reason ?? 'This module cannot run here.'
			);
		}
		const reading = await readModule(deps, input, site, machineName(input.name));
		if (!reading.present) {
			throw new PermanentError(
				'module_missing',
				'The module is not on the site yet. Install it first.'
			);
		}
	});
}

export async function runModuleEnable(
	step: StepRunner,
	deps: ModuleDeps,
	input: ModuleEnableInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'module.enable',
		epoch: null
	};
	const project = machineName(input.name);
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const site = await preflight(ctx, deps, input);
		await takeRestorePoint(ctx, deps, input, `Restore point before enabling ${input.name}`);
		await runStep(ctx, 'enable', 'enable', async () => {
			await fenced(ctx);
			// a lost answer from an earlier run leaves the module on, and a second call would repeat the work
			if ((await readModule(deps, input, site, project)).enabled) return;
			const done = await withOwnerToken(deps, input, site, (auth) =>
				deps.modules.enable(site.hostname, project, auth)
			);
			if (!done.ok) {
				throw new PermanentError(
					'enable_failed',
					`The site could not enable ${input.name}.`
				);
			}
		});
		await verifiedStep(ctx, deps, async () => {
			if (!(await readModule(deps, input, site, project)).enabled) {
				throw new PermanentError(
					'enable_unverified',
					'The site does not show the module as on after the change.'
				);
			}
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return stopFailed(ctx, deps, input, error, {
			changing: ['enable', 'verify'],
			project,
			unchanged: (reading) => !reading.enabled,
			asWas: 'the module was not turned on and the site was left as it was.',
			unknown: 'the module may be partly turned on.'
		});
	}
	await finishSuccess(ctx, `${input.name} is enabled on ${input.siteId}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
