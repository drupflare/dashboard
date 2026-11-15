import type { Plan } from '@contracts/operations';
import { scriptName } from '@contracts/sites';
import { guardRollback } from '../../../src/server/domain/rollback-guard';
import { migrationTagOfTags, releaseOfTags, UNTAGGED_MIGRATION_TAG } from '../descriptor';
import { buildPlan, setVerification, transition } from '../operations/state';
import { claimScript } from '../ownership';
import type { RollbackDeps } from '../ports';
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
import {
	checkSite,
	claimOf,
	descriptorFor,
	loadBundle,
	migrationRefusal,
	putRelease,
	uploadAssets,
	type SiteUpgradeInput
} from './site-upgrade';

// releaseId is the release to go back to, currentRelease the one the site runs now
export type SiteRollbackInput = SiteUpgradeInput;

export function planSiteRollback(
	input: Pick<SiteRollbackInput, 'site' | 'releaseId' | 'currentRelease'>
): Plan {
	return buildPlan({
		type: 'site.rollback',
		targetIds: [input.site.id],
		preconditions: [
			`${input.site.id} is active and answers its probe`,
			`release ${input.releaseId} is registered and its bundle is stored`
		],
		steps: [
			{ id: 'guard', name: 'Check the data allows the earlier code' },
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the release' },
			{ id: 'assets', name: 'Upload changed static assets' },
			{ id: 'upload-script', name: 'Upload the script' },
			{ id: 'record', name: 'Record the release' },
			{ id: 'verify', name: 'Probe the site' }
		],
		rollbackPoint: input.currentRelease
	});
}

// the refusal carries its offers in the text, so the operation shows what to do next
async function guard(ctx: Ctx, deps: RollbackDeps, input: SiteRollbackInput): Promise<void> {
	await runStep(ctx, 'guard', 'guard', async () => {
		const facts = await deps.rollbackFacts(input.site.id, input.releaseId);
		if (facts.target === null) {
			throw new PermanentError('release_unknown', `${input.releaseId} is not registered`);
		}
		const verdict = guardRollback({
			dataSchemaVersion: facts.dataSchemaVersion,
			target: facts.target
		});
		if (!verdict.allowed) {
			throw new PermanentError(
				'rollback_refused',
				`${verdict.reason} Offers: ${verdict.offers.join(', ')}.`
			);
		}
	});
}

async function preflight(ctx: Ctx, input: SiteRollbackInput): Promise<string | null> {
	const { deps } = ctx;
	return runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		if (input.site.plane !== 'managed') {
			throw new PermanentError(
				'unsupported_plane',
				'only a managed site is rolled back here'
			);
		}
		if ((await deps.store.siteState(input.site.id)) !== 'active') {
			throw new PermanentError('site_not_active', `${input.site.id} is not active`);
		}
		await claimScript(deps, claimOf(ctx, input));
		const info = await deps.cloudflare.getScript(scriptName(input.site.id));
		if (info === null) {
			throw new PermanentError('script_missing', `${input.site.id} has no script of its own`);
		}
		if (releaseOfTags(info.tags) === input.releaseId) {
			throw new PermanentError(
				'up_to_date',
				`${input.site.id} already runs ${input.releaseId}`
			);
		}
		await checkSite(ctx, input);
		await loadBundle(deps, input.releaseId);
		const target = await descriptorFor(deps, input, input.releaseId);
		const targetTags = (target.metadata.migrations ?? []).flatMap((migration) =>
			migration.tag === undefined ? [] : [migration.tag]
		);
		const recorded =
			migrationTagOfTags(info.tags) ??
			(targetTags.length === 0 ? null : UNTAGGED_MIGRATION_TAG);
		const refusal = migrationRefusal(recorded, targetTags);
		if (refusal !== null) throw new PermanentError('migration_downgrade', refusal);
		return recorded;
	});
}

async function uploadScript(
	ctx: Ctx,
	input: SiteRollbackInput,
	token: string,
	tag: string | null
): Promise<void> {
	await runStep(ctx, 'upload-script', 'upload-script', async () => {
		await fenced(ctx);
		await putRelease(ctx, input, input.releaseId, token, tag);
	});
}

// the row follows the live script, so a failed check afterwards still leaves a row that matches it
async function record(ctx: Ctx, input: SiteRollbackInput): Promise<void> {
	await runStep(ctx, 'record', 'record', async () => {
		await fenced(ctx);
		await ctx.deps.store.setSiteRelease(input.site.id, input.releaseId, ctx.deps.now());
	});
}

async function verify(ctx: Ctx, input: SiteRollbackInput): Promise<void> {
	const { deps } = ctx;
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		await checkSite(ctx, input);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

const AFTER_UPLOAD = ['upload-script', 'record', 'verify'];

export async function runSiteRollback(
	step: StepRunner,
	deps: RollbackDeps,
	input: SiteRollbackInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.site.id,
		accountId: input.site.accountId,
		purpose: 'site.rollback',
		epoch: null
	};
	try {
		await startOperation(ctx);
		await guard(ctx, deps, input);
		await acquireLease(ctx, 'lease');
		const tag = await preflight(ctx, input);
		const token = await uploadAssets(ctx, input, input.releaseId, '', 'assets');
		await uploadScript(ctx, input, token, tag);
		await record(ctx, input);
		await verify(ctx, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const reason = describeFailure(error);
		const closed = await closeFailed(ctx, error);
		await releaseLease(ctx);
		if (closed === 'cancelled') return { status: 'cancelled', reason };
		const changed = AFTER_UPLOAD.includes(error.step);
		// past the upload the site runs the earlier code and the row says so
		return {
			status: 'failed',
			reason: changed
				? `${reason}; the site runs ${input.releaseId} but did not pass its check`
				: reason,
			leaked: []
		};
	}
	await finishSuccess(
		ctx,
		`${input.site.id} runs ${input.releaseId} again, back from ${input.currentRelease}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
