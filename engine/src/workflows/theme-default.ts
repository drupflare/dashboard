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

export const NEEDS_THEME_UPDATE = 'Changing Themes Needs a Worker Update';

export interface ThemeDefaultInput extends ModuleInput {
	census: Pick<ModuleRow, 'state' | 'reason'> | null;
	target: 'default' | 'admin';
}

export function planThemeDefault(
	input: Pick<ThemeDefaultInput, 'siteId' | 'name' | 'backupId' | 'target'>
): Plan {
	return buildPlan({
		type: 'theme.default',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`${input.name} is enabled on the site`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the theme' },
			...RESTORE_POINT_STEPS,
			{ id: 'set', name: `Make ${input.name} the ${input.target} theme` },
			{ id: 'verify', name: 'Check which theme the site uses' }
		],
		rollbackPoint: input.backupId
	});
}

async function preflight(ctx: Ctx, deps: ModuleDeps, input: ThemeDefaultInput) {
	const project = machineName(input.name);
	return openForChange(ctx, deps, input, async (site) => {
		if (input.census === null) {
			throw new PermanentError('theme_refused', 'That theme is not on the list.');
		}
		if (input.census.state === 'blocked') {
			throw new PermanentError(
				'theme_refused',
				input.census.reason ?? 'This theme cannot run here.'
			);
		}
		const answer = await withOwnerToken(deps, input, site, (auth) =>
			deps.modules.setDefaultTheme(
				site.hostname,
				{ project, target: input.target },
				{ dryRun: true },
				auth
			)
		);
		if (answer.kind === 'not_available') {
			throw new PermanentError('not_available', NEEDS_THEME_UPDATE);
		}
		if (!(await readModule(deps, input, site, project)).enabled) {
			throw new PermanentError(
				'theme_not_enabled',
				'Enable the theme before making it the default.'
			);
		}
	});
}

export async function runThemeDefault(
	step: StepRunner,
	deps: ModuleDeps,
	input: ThemeDefaultInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'theme.default',
		epoch: null
	};
	const project = machineName(input.name);
	const change = { project, target: input.target } as const;
	let previous: string | null = null;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const site = await preflight(ctx, deps, input);
		await takeRestorePoint(
			ctx,
			deps,
			input,
			`Restore point before changing the ${input.target} theme`
		);
		previous = await runStep(ctx, 'set', 'set', async () => {
			await fenced(ctx);
			const before = await withOwnerToken(deps, input, site, (auth) =>
				deps.modules.setDefaultTheme(site.hostname, change, { dryRun: true }, auth)
			);
			const was = before.kind === 'set' ? before[input.target] : null;
			if (was === project) return was;
			const answer = await withOwnerToken(deps, input, site, (auth) =>
				deps.modules.setDefaultTheme(site.hostname, change, { dryRun: false }, auth)
			);
			if (answer.kind !== 'set') {
				throw new PermanentError(
					'set_failed',
					`The site could not make ${input.name} the ${input.target} theme.`
				);
			}
			return was;
		});
		await verifiedStep(ctx, deps, async () => {
			const now = await withOwnerToken(deps, input, site, (auth) =>
				deps.modules.setDefaultTheme(site.hostname, change, { dryRun: true }, auth)
			);
			if (now.kind !== 'set' || now[input.target] !== project) {
				throw new PermanentError(
					'set_unverified',
					`The site does not use ${input.name} as its ${input.target} theme after the change.`
				);
			}
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return stopFailed(ctx, deps, input, error, {
			changing: ['set', 'verify'],
			project,
			// a theme change leaves the module list alone, so the reading cannot show it as it was
			unchanged: () => false,
			asWas: '',
			unknown: 'the theme setting may have changed.'
		});
	}
	await finishSuccess(
		ctx,
		`${input.name} is the ${input.target} theme of ${input.siteId}, replacing ${previous ?? 'none'}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
