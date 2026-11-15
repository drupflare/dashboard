import type { Plan } from '@contracts/operations';
import { blobRequestBytes, MODIFY_MAX_REQUEST_BYTES } from '../../../src/shared/modify';
import { recipeFor } from '../../../src/shared/recipes';
import { backupKeys } from '../backup-parts';
import { editKeys, parseEditBundle, revisionOf, type EditBundle } from '../modify-bundle';
import { buildPlan, observe, setVerification } from '../operations/state';
import type { ModifyDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite, type OpenSite } from './backup-create';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome
} from './common';
import {
	RESTORE_POINT_STEPS,
	takeRestorePoint,
	verifiedStep,
	withOwnerToken,
	type ModuleInput
} from './module-common';

export interface ModifyApplyInput extends ModuleInput {
	// the stored files to deliver; a rollback names the bundle an earlier edit kept
	bundleKey: string;
	// the text of the history row
	note: string;
}

// the history row of an edit is named by the operation that delivered it
export const editRowId = (operationId: string) => `rev_${operationId}`;

export function planModifyApply(
	input: Pick<ModifyApplyInput, 'siteId' | 'name' | 'backupId'>
): Plan {
	return buildPlan({
		type: 'modify.apply',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active and has an owner token`,
			`the files for ${input.name} are stored`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the files' },
			...RESTORE_POINT_STEPS,
			{ id: 'deliver', name: `Send the files for ${input.name} to the site` },
			{ id: 'verify', name: 'Check that the site runs the new files' },
			{ id: 'record', name: 'Add the edit to the code history' }
		],
		rollbackPoint: input.backupId
	});
}

interface Opened {
	site: OpenSite;
	// the revision this edit makes active
	rev: string;
	// the revision the site ran for the package before, null when it had none
	prior: string | null;
}

async function loadBundle(deps: ModifyDeps, input: ModifyApplyInput): Promise<EditBundle> {
	if (!input.bundleKey.startsWith(editKeys.prefix(input.orgId, input.siteId))) {
		throw new PermanentError('bundle_invalid', 'the stored files belong to another site');
	}
	const bytes = await deps.blobs.get(input.bundleKey);
	if (bytes === null) throw new PermanentError('bundle_missing', 'The stored files are gone.');
	const bundle = await parseEditBundle(bytes);
	if (bundle.package !== input.name) {
		throw new PermanentError('bundle_invalid', 'the stored files belong to another package');
	}
	return bundle;
}

async function preflight(ctx: Ctx, deps: ModifyDeps, input: ModifyApplyInput): Promise<Opened> {
	return runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
		const site = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		const bundle = await loadBundle(deps, input);
		if (bundle.files.some((file) => blobRequestBytes(file.source) > MODIFY_MAX_REQUEST_BYTES)) {
			throw new PermanentError(
				'modify_too_large',
				'A file is too large for the site to take.'
			);
		}
		const prior = await withOwnerToken(deps, input, site, (auth) =>
			deps.modify.active(site.hostname, bundle.package, auth)
		);
		return { site, rev: await revisionOf(bundle), prior };
	});
}

// the revision the site runs now, read with the owner token
const activeOf = (deps: ModifyDeps, input: ModifyApplyInput, site: OpenSite) =>
	withOwnerToken(deps, input, site, (auth) =>
		deps.modify.active(site.hostname, input.name, auth)
	);

async function deliver(
	ctx: Ctx,
	deps: ModifyDeps,
	input: ModifyApplyInput,
	opened: Opened
): Promise<void> {
	const { site, rev } = opened;
	await runStep(ctx, 'deliver', 'deliver', async () => {
		await fenced(ctx);
		const bundle = await loadBundle(deps, input);
		// a lost answer from an earlier run leaves the revision running, and the set would go again
		const answer = await withOwnerToken(deps, input, site, async (auth) =>
			(await deps.modify.active(site.hostname, input.name, auth)) === rev
				? ({ kind: 'applied', rev } as const)
				: deps.modify.deliver(
						site.hostname,
						{ name: input.name, label: input.note, files: bundle.files },
						auth
					)
		);
		if (answer.kind === 'refused') throw new PermanentError('modify_refused', answer.reason);
		if (answer.rev !== rev) {
			throw new PermanentError(
				'modify_unverified',
				'The site reports a different revision than the one sent.'
			);
		}
	});
}

async function verify(
	ctx: Ctx,
	deps: ModifyDeps,
	input: ModifyApplyInput,
	opened: Opened
): Promise<void> {
	const { site, rev } = opened;
	await verifiedStep(ctx, deps, async () => {
		if ((await activeOf(deps, input, site)) !== rev) {
			throw new PermanentError(
				'modify_unverified',
				'The site does not report the new files as running after the change.'
			);
		}
		const path = recipeFor('drupal')?.probe.path ?? '/health';
		const answered = await withOwnerToken(deps, input, site, (auth) =>
			deps.site.probe(site.hostname, path, 200, auth)
		);
		if (answered.status !== 200) {
			throw new PermanentError(
				'modify_unverified',
				`The site answered ${answered.status} to its health check after the change.`
			);
		}
	});
}

async function record(ctx: Ctx, deps: ModifyDeps, input: ModifyApplyInput): Promise<void> {
	await runStep(ctx, 'record', 'record', async () => {
		await fenced(ctx);
		await deps.edits.record({
			id: editRowId(ctx.operationId),
			organizationId: input.orgId,
			siteId: input.siteId,
			bundleKey: input.bundleKey,
			note: input.note,
			now: deps.now()
		});
	});
}

// what the site holds after a failure at or past the send; a failed check puts the earlier revision back
async function putBack(
	deps: ModifyDeps,
	input: ModifyApplyInput,
	opened: Opened,
	pointer: string
): Promise<string> {
	const { site, prior } = opened;
	try {
		return await withOwnerToken(deps, input, site, async (auth) => {
			const now = await deps.modify.active(site.hostname, input.name, auth);
			if (now === prior) return 'the site was left as it was.';
			if (prior === null) {
				return `the new files are on the site, and it had no earlier revision to put back.${pointer}`;
			}
			const back = await deps.modify.activate(site.hostname, input.name, prior, auth);
			return back.ok
				? 'the earlier files are back on the site.'
				: `the new files may still be on the site.${pointer}`;
		});
	} catch {
		return `the new files may be on the site.${pointer}`;
	}
}

async function stopFailed(
	ctx: Ctx,
	deps: ModifyDeps,
	input: ModifyApplyInput,
	failure: StepFailed,
	opened: Opened | undefined
): Promise<Outcome> {
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		await releaseLease(ctx);
		return { status: 'cancelled', reason };
	}
	// the parts of a restore point that never got a row go; one that has a row stays
	await plainStep(ctx, 'rollback.parts', async () => {
		if ((await deps.backups.get(input.orgId, input.backupId)) !== null) return;
		await deps.blobs.deletePrefix(backupKeys.prefix(input.orgId, input.siteId, input.backupId));
	});
	const recorded = (await deps.backups.get(input.orgId, input.backupId)) !== null;
	const pointer = recorded
		? ` Restore point ${input.backupId} holds the database from before.`
		: '';
	let outcome: string;
	if (opened === undefined || !['deliver', 'verify', 'record'].includes(failure.step)) {
		outcome = `${reason}; nothing on the site was changed.`;
	} else if (failure.step === 'record') {
		outcome = `${reason}; the new files are on the site, but the edit is missing from the code history.`;
	} else {
		const found = await plainStep(ctx, 'rollback.files', () =>
			putBack(deps, input, opened, pointer)
		);
		outcome = `${reason}; ${found}`;
	}
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) =>
			setVerification(observe(operation, outcome, deps.now()), 'failed', deps.now())
		);
	});
	await releaseLease(ctx);
	return { status: 'failed', reason: outcome, leaked: [] };
}

export async function runModifyApply(
	step: StepRunner,
	deps: ModifyDeps,
	input: ModifyApplyInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'modify.apply',
		epoch: null
	};
	let opened: Opened | undefined;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		opened = await preflight(ctx, deps, input);
		await takeRestorePoint(ctx, deps, input, `Restore point before editing ${input.name}`);
		await deliver(ctx, deps, input, opened);
		await verify(ctx, deps, input, opened);
		await record(ctx, deps, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return stopFailed(ctx, deps, input, error, opened);
	}
	await finishSuccess(ctx, `${input.name} was edited on ${input.siteId}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
