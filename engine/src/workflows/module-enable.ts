import type { Plan } from '@contracts/operations';
import { machineName, type ModuleRow } from '../../../src/shared/modules';
import { STRATA_CAPTURES_STATEMENTS, type StrataAllocation } from '../../../src/shared/strata';
import { buildPlan } from '../operations/state';
import type { ModuleDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { openSite } from './backup-create';
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
import { runStrataStore } from './strata-store';

export interface ModuleEnableInput extends ModuleInput {
	// the census row as the dashboard read it; null when the name is not on the list
	census: Pick<ModuleRow, 'state' | 'shipping' | 'reason'> | null;
	// Strata starts with statement capture on, which is the costly setting, so the stored choice is
	// sent as soon as the module is on
	// store is true when the site is managed, so it gets a private bucket and the key to it; the
	// caller sets it only after the plan's Strata entitlement has passed
	strata?: { allocation: StrataAllocation; store?: boolean };
}

const STRATA_ATTEMPTS = 3;
const STRATA_RETRY_MS = 2_000;

export function planModuleEnable(
	input: Pick<ModuleEnableInput, 'siteId' | 'name' | 'backupId' | 'strata'>
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
			{ id: 'verify', name: 'Check that the module is on' },
			...(input.strata?.store === true
				? [{ id: 'strata-store', name: 'Set up private storage for Strata' }]
				: []),
			...(input.strata === undefined
				? []
				: [{ id: 'strata', name: 'Set how much of the allowance Strata may use' }])
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
	if (input.strata?.store === true) await runStrataStore(ctx, deps, input);
	if (input.strata !== undefined) {
		const { allocation } = input.strata;
		const wanted = STRATA_CAPTURES_STATEMENTS[allocation];
		// the module is on whatever this answers, so a site that will not take the setting leaves it
		// unapplied for the owner to retry instead of undoing the enable
		await runStep(ctx, 'strata', 'strata', async () => {
			const site = await openSite(
				deps,
				{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
				{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
			);
			for (let attempt = 1; attempt <= STRATA_ATTEMPTS; attempt++) {
				try {
					const done = await withOwnerToken(deps, input, site, (auth) =>
						deps.modules.setStrata(site.hostname, wanted, auth)
					);
					if (done.ok) {
						await deps.strata.markApplied(
							input.orgId,
							input.siteId,
							allocation,
							deps.now()
						);
						return;
					}
				} catch (error) {
					if (error instanceof PermanentError) return;
				}
				if (attempt < STRATA_ATTEMPTS) await deps.sleep(STRATA_RETRY_MS);
			}
		});
	}
	await finishSuccess(ctx, `${input.name} is enabled on ${input.siteId}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
