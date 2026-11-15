import type { Plan } from '@contracts/operations';
import { installRefusal, machineName, type ModuleRow } from '../../../src/shared/modules';
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

export interface ModuleInstallInput extends ModuleInput {
	// the census row as the dashboard read it; null when the name is not on the list
	census: Pick<ModuleRow, 'state' | 'shipping' | 'reason'> | null;
	// the owner confirmed a module that has never run on a site
	confirm: boolean;
}

export function planModuleInstall(
	input: Pick<ModuleInstallInput, 'siteId' | 'name' | 'backupId'>
): Plan {
	return buildPlan({
		type: 'module.install',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`${input.name} is on the list`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the module again' },
			...RESTORE_POINT_STEPS,
			{ id: 'install', name: `Install ${input.name}` },
			{ id: 'verify', name: 'Check that the site holds the module' }
		],
		rollbackPoint: input.backupId
	});
}

const restoreLabel = (name: string) => `Restore point before installing ${name}`;

// the check runs here again, since the answer a browser holds may be old
async function preflight(ctx: Ctx, deps: ModuleDeps, input: ModuleInstallInput) {
	return openForChange(ctx, deps, input, async (site) => {
		const refusal = installRefusal(input.census ?? undefined, input.confirm);
		if (refusal !== null) throw new PermanentError('module_refused', refusal);
		const verdict = await withOwnerToken(deps, input, site, (auth) =>
			deps.modules.installable(site.hostname, input.name, auth)
		);
		if (verdict.verdict === 'not-found') {
			throw new PermanentError('module_not_found', 'No release of this module was found.');
		}
		if (verdict.verdict !== 'installable') {
			const named = verdict.conflicts.map((c) => `${c.requires} ${c.constraint}`).join(', ');
			throw new PermanentError(
				'module_conflict',
				verdict.verdict === 'blocked'
					? `Installing this module would conflict with the code the site already has${named === '' ? '' : ` (${named})`}.`
					: 'The requirements of this module cannot be checked, so it cannot be installed yet.'
			);
		}
	});
}

async function install(
	ctx: Ctx,
	deps: ModuleDeps,
	input: ModuleInstallInput,
	site: Awaited<ReturnType<typeof preflight>>
): Promise<void> {
	await runStep(ctx, 'install', 'install', async () => {
		await fenced(ctx);
		// a lost answer from an earlier run leaves the code in place, and a second install would repeat it
		if ((await readModule(deps, input, site, machineName(input.name))).present) return;
		const done = await withOwnerToken(deps, input, site, (auth) =>
			deps.modules.install(site.hostname, input.name, auth)
		);
		if (!done.ok) {
			throw new PermanentError('install_failed', `The site could not install ${input.name}.`);
		}
	});
}

export async function runModuleInstall(
	step: StepRunner,
	deps: ModuleDeps,
	input: ModuleInstallInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'module.install',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const site = await preflight(ctx, deps, input);
		await takeRestorePoint(ctx, deps, input, restoreLabel(input.name));
		await install(ctx, deps, input, site);
		await verifiedStep(ctx, deps, async () => {
			if (!(await readModule(deps, input, site, machineName(input.name))).present) {
				throw new PermanentError(
					'install_unverified',
					'The site does not show the module after the install.'
				);
			}
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return stopFailed(ctx, deps, input, error, {
			changing: ['install', 'verify'],
			project: machineName(input.name),
			unchanged: (reading) => !reading.present,
			asWas: 'the module was not installed and the site was left as it was.',
			unknown: 'the module may be partly installed.'
		});
	}
	await finishSuccess(ctx, `${input.name} is installed on ${input.siteId}, not yet enabled`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
