import { DEFAULT_RESTORE_CEILING_BYTES } from '../backup-parts';
import { observe, transition } from '../operations/state';
import type { CopyDeps, SiteCall } from '../ports';
import { planResources } from '../provision-plan';
import { PermanentError, StepFailed } from '../step';
import {
	apply,
	adopt as copyFiles,
	grant,
	grantSources,
	sendDump,
	verify,
	type BackupRestoreInput,
	type Checked
} from './backup-restore';
import {
	closeFailed,
	describeFailure,
	fenced,
	plainStep,
	releaseLease,
	runStep,
	type Ctx,
	type Outcome
} from './common';
import { ACTIONS } from './site-cleanup';
import {
	applyAuthority,
	createResource,
	firstRun,
	putRoute,
	uploadAssets,
	uploadScript,
	type FirstRunSealed,
	type SiteCreateInput
} from './site-create';

// a new site built as a create builds it, then filled from a saved copy of another site. Nothing in
// here reads or writes the source except the copy's own parts in the bucket
export interface CopyInput {
	operationId: string;
	orgId: string;
	backupId: string;
	create: SiteCreateInput & { firstRun: SiteCall };
	// set when the copy is an environment, so its host answers to that environment's access rules
	environment?: { id: string };
	waitMs: number;
	pollMs: number;
	restoreCeilingBytes?: number;
}

export const COPY_ERROR_CODES = [
	'backup_not_found',
	'not_restorable',
	'copy_no_owner_token'
] as const;
export type CopyErrorCode = (typeof COPY_ERROR_CODES)[number];

export class CopyError extends PermanentError {
	declare readonly code: CopyErrorCode;

	constructor(code: CopyErrorCode, message: string) {
		super(code, message);
	}
}

export const COPY_STEPS = [
	{ id: 'grant', name: 'Grant the source files to the copy' },
	{ id: 'restore', name: 'Send the dump to the copy' },
	{ id: 'apply', name: 'Wait for the copy to apply the dump' },
	{ id: 'adopt', name: 'Wait for the files to be copied and drop the grant' },
	{ id: 'verify', name: 'Probe the copy' }
] as const;

// the plan steps from the saved-copy check to the probe, in the order buildCopy runs them
export function copyPlanSteps(create: SiteCreateInput) {
	const resources = planResources(create.site, create.site.config, { database: create.database });
	return [
		{ id: 'check-backup', name: 'Check the saved copy' },
		...resources.create.map((resource) => ({
			id: `resource.${resource.binding}`,
			name: `Create ${resource.kind} ${resource.name}`
		})),
		{ id: 'assets', name: 'Upload static assets' },
		{ id: 'upload-script', name: 'Upload the script' },
		{ id: 'authority', name: 'Write site authority' },
		{ id: 'route', name: `Route ${create.hostname}` },
		{ id: 'first-run', name: 'Run the first-run call' },
		...COPY_STEPS
	];
}

export function restoreInputOf(input: CopyInput): BackupRestoreInput {
	return {
		operationId: input.operationId,
		orgId: input.orgId,
		backupId: input.backupId,
		siteId: input.create.site.id,
		accountId: input.create.site.accountId,
		waitMs: input.waitMs,
		pollMs: input.pollMs,
		restoreCeilingBytes: input.restoreCeilingBytes
	};
}

async function checkSaved(ctx: Ctx, deps: CopyDeps, input: CopyInput): Promise<void> {
	await runStep(ctx, 'check-backup', 'check-backup', async () => {
		await fenced(ctx);
		const backup = await deps.backups.get(input.orgId, input.backupId);
		if (backup === null) {
			throw new CopyError(
				'backup_not_found',
				`${input.backupId} is not a backup of this organisation`
			);
		}
		const ceiling = input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
		if (!backup.restorable || backup.bytes > ceiling) {
			throw new CopyError(
				'not_restorable',
				`${backup.id} is larger than a site accepts in a restore`
			);
		}
	});
}

export interface BuiltCopy {
	sealed: FirstRunSealed;
	checked: Checked;
}

// the lease on the new site is held by the caller; every step is fenced and safe to run again
export async function buildCopy(ctx: Ctx, deps: CopyDeps, input: CopyInput): Promise<BuiltCopy> {
	const { create } = input;
	const resources = planResources(create.site, create.site.config, { database: create.database });
	await checkSaved(ctx, deps, input);
	for (const [index, resource] of resources.create.entries()) {
		await createResource(ctx, create, resource, index === 0 ? resources : null);
	}
	const token = await uploadAssets(ctx, create);
	await uploadScript(ctx, create, token);
	await applyAuthority(ctx, create);
	await putRoute(ctx, create, input.environment?.id);
	const sealed = await firstRun(ctx, create, create.firstRun);
	if (sealed.ownerTokenId === null) {
		throw new CopyError('copy_no_owner_token', 'the copy has no owner token to restore with');
	}
	const restoring = restoreInputOf(input);
	const checked = await plainStep(ctx, 'copy.sources', async (): Promise<Checked> => {
		const backup = await deps.backups.get(input.orgId, input.backupId);
		if (backup === null) {
			throw new CopyError('backup_not_found', `${input.backupId} is gone`);
		}
		return {
			hostname: create.hostname,
			ownerTokenId: sealed.ownerTokenId as string,
			plane: create.site.plane,
			label: ctx.operationId,
			sources: await grantSources(deps, backup, input.orgId, create.site.id)
		};
	});
	await grant(ctx, deps, restoring, checked);
	const sent = await sendDump(ctx, deps, restoring, checked);
	await apply(ctx, deps, restoring, checked, sent);
	await copyFiles(ctx, deps, restoring, checked);
	await verify(ctx, deps, restoring, checked);
	return { sealed, checked };
}

const targetOf = (create: SiteCreateInput) => ({
	siteId: create.site.id,
	accountId: create.site.accountId,
	plane: create.site.plane,
	hostname: create.hostname,
	subdomain: create.subdomain
});

// takes off what this site's own ledger and route name, in the order a cleanup does, without a lease
// of its own; the caller holds the lease on the site and runs this inside one step
export async function discardCopy(deps: CopyDeps, create: SiteCreateInput): Promise<string[]> {
	const notes: string[] = [];
	for (const [, action] of ACTIONS) {
		const note = await action(deps, targetOf(create));
		if (typeof note === 'string') notes.push(note);
	}
	return notes;
}

// a copy that never went live is cleaned up and the operation closes as given; one that did go
// live is kept whole. The source is never touched
export async function rollBackCopy(
	ctx: Ctx,
	deps: CopyDeps,
	create: SiteCreateInput,
	failure: StepFailed,
	closeAs: 'rolled-back' | 'failed'
): Promise<Outcome> {
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		await releaseLease(ctx);
		return { status: 'cancelled', reason };
	}
	if (await plainStep(ctx, 'rollback.live', () => deps.store.siteLive(create.site.id))) {
		await releaseLease(ctx);
		return { status: 'failed', reason, leaked: [] };
	}
	const leaked: string[] = [];
	for (const [id, action] of ACTIONS) {
		try {
			await plainStep(
				ctx,
				`rollback.${id}`,
				async () => void (await action(deps, targetOf(create)))
			);
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			leaked.push(id);
		}
	}
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'rolled-back') return operation;
			const note =
				leaked.length === 0
					? `the copy was removed after ${reason}`
					: `removing the copy was incomplete (${leaked.join(', ')}) after ${reason}`;
			const noted = observe(operation, note, deps.now());
			return leaked.length === 0 && closeAs === 'rolled-back'
				? transition(noted, 'rolled-back', deps.now())
				: noted;
		});
	});
	await releaseLease(ctx);
	if (leaked.length > 0) return { status: 'failed', reason, leaked };
	return closeAs === 'rolled-back'
		? { status: 'rolled-back', reason }
		: { status: 'failed', reason, leaked: [] };
}
