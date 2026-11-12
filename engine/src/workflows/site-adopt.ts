import type { Plan } from '@contracts/operations';
import { backupKeys, DEFAULT_RESTORE_CEILING_BYTES } from '../backup-parts';
import { buildPlan, observe, transition } from '../operations/state';
import type { BackupDeps, SiteCall } from '../ports';
import { planResources } from '../provision-plan';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	exportParts,
	openSite,
	recordBackup,
	verifyParts,
	type BackupCreateInput
} from './backup-create';
import {
	apply,
	check as checkRestore,
	adopt as copyFiles,
	grant,
	sendDump,
	verify as verifyRestore,
	type BackupRestoreInput
} from './backup-restore';
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
import { cleanTarget } from './site-cleanup';
import {
	activate,
	applyAuthority,
	createResource,
	firstRun,
	putRoute,
	reserveName,
	uploadAssets,
	uploadScript,
	type FirstRunSealed,
	type SiteCreateInput
} from './site-create';

export interface SiteAdoptInput {
	operationId: string;
	orgId: string;
	// where the copy of the source database is kept
	backupId: string;
	// the self-managed site; it is read and marked and nothing else
	source: { id: string; accountId: string };
	// the managed copy, built as a create builds it; its first run reads the owner token only
	create: SiteCreateInput & { firstRun: SiteCall };
	waitMs: number;
	pollMs: number;
	restoreCeilingBytes?: number;
}

export const ADOPT_ERROR_CODES = [
	'not_self_managed',
	'already_adopted',
	'source_unreachable',
	'unsupported_kind'
] as const;
export type AdoptErrorCode = (typeof ADOPT_ERROR_CODES)[number];

export class AdoptError extends PermanentError {
	declare readonly code: AdoptErrorCode;

	constructor(code: AdoptErrorCode, message: string) {
		super(code, message);
	}
}

export const ADOPT_COPY_LABEL = 'Copy made to adopt the site';

// the same plan ids a create, a backup and a restore write, renamed where two of them share one
const DUMP_IDS = { verify: 'export-verify', record: 'export-record' };
const RESTORE_IDS = { check: 'restore-check', grant: 'restore-grant', adopt: 'files' };

export function planSiteAdopt(input: SiteAdoptInput): Plan {
	const { create, source } = input;
	const resources = planResources(create.site, create.site.config, { database: create.database });
	return buildPlan({
		type: 'site.adopt',
		targetIds: [create.site.id, source.id],
		preconditions: [
			`${source.id} is a live self-managed site with an owner token and no earlier adoption`,
			`${create.subdomain} is free`,
			`release ${create.releaseId} is published`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the source site' },
			{ id: 'export', name: 'Page the source database into the bucket' },
			{ id: DUMP_IDS.verify, name: 'Check every part against its hash' },
			{ id: DUMP_IDS.record, name: 'Record the copy' },
			{ id: 'reserve-name', name: `Reserve ${create.subdomain}` },
			...resources.create.map((resource) => ({
				id: `resource.${resource.binding}`,
				name: `Create ${resource.kind} ${resource.name}`
			})),
			{ id: 'assets', name: 'Upload static assets' },
			{ id: 'upload-script', name: 'Upload the script' },
			{ id: 'authority', name: 'Write site authority' },
			{ id: 'route', name: `Route ${create.hostname}` },
			{ id: 'first-run', name: 'Run the first-run call' },
			{ id: 'link', name: 'Record the link from the source to the new site' },
			{ id: RESTORE_IDS.check, name: 'Check the new site and the copy' },
			{ id: RESTORE_IDS.grant, name: 'Grant the source files to the new site' },
			{ id: 'restore', name: 'Send the dump to the new site' },
			{ id: 'apply', name: 'Wait for the new site to apply the dump' },
			{ id: RESTORE_IDS.adopt, name: 'Wait for the files to be copied and drop the grant' },
			{ id: 'verify', name: 'Probe the new site' },
			{ id: 'activate', name: 'Mark the new site active' }
		],
		rollbackPoint: null
	});
}

// the reused step functions run under their own step names, so the same name in a create, a backup
// and a restore never meets in one workflow instance
function phase(ctx: Ctx, prefix: string, stepIds: Record<string, string> = {}): Ctx {
	return {
		...ctx,
		step: { do: (name, fn) => ctx.step.do(`${prefix}.${name}`, fn) },
		stepIds
	};
}

const ceilingOf = (input: SiteAdoptInput) =>
	input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;

// #region the source

async function preflight(ctx: Ctx, deps: BackupDeps, input: SiteAdoptInput): Promise<void> {
	const { source, create } = input;
	await runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		if (create.firstRun.reads?.ownerToken === undefined) {
			throw new AdoptError('unsupported_kind', `${create.site.kind} sites are not adopted`);
		}
		const row = await deps.backups.site(source.id);
		if (row !== null && row.plane !== 'self-managed') {
			throw new AdoptError('not_self_managed', `${source.id} is not a self-managed site`);
		}
		if (row !== null && row.adoptedTo !== null && row.adoptedTo !== create.site.id) {
			throw new AdoptError('already_adopted', `${source.id} was already adopted`);
		}
		const opened = await openSite(
			deps,
			{ id: source.id, orgId: input.orgId, accountId: source.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		// a site that answers with a client error is up; one that answers 5xx or not at all is not
		let status = 0;
		try {
			status = (await deps.site.probe(opened.hostname, '/')).status;
		} catch (error) {
			if (!(error instanceof PermanentError && error.code === 'site_rejected')) throw error;
		}
		if (status >= 500) {
			throw new AdoptError('source_unreachable', `${source.id} answered ${status}`);
		}
	});
}

function dumpInput(input: SiteAdoptInput): BackupCreateInput {
	return {
		operationId: input.operationId,
		orgId: input.orgId,
		siteId: input.source.id,
		accountId: input.source.accountId,
		backupId: input.backupId,
		label: ADOPT_COPY_LABEL,
		restoreCeilingBytes: ceilingOf(input),
		stopAboveBytes: ceilingOf(input)
	};
}

function restoreInput(input: SiteAdoptInput): BackupRestoreInput {
	return {
		operationId: input.operationId,
		orgId: input.orgId,
		backupId: input.backupId,
		siteId: input.create.site.id,
		accountId: input.create.site.accountId,
		waitMs: input.waitMs,
		pollMs: input.pollMs,
		restoreCeilingBytes: ceilingOf(input)
	};
}

// #endregion

// #region the link

// the source is marked before the copy is restored, because the restore reads the new site's row
// and that row needs its account; a failure takes the mark off again
async function link(ctx: Ctx, deps: BackupDeps, input: SiteAdoptInput): Promise<void> {
	const { source, create } = input;
	await runStep(ctx, 'link', 'link', async () => {
		await fenced(ctx);
		const linked = await deps.store.linkAdoption(
			source.id,
			{ id: create.site.id, accountId: create.site.accountId },
			deps.now()
		);
		if (!linked) {
			throw new AdoptError('already_adopted', `${source.id} was already adopted`);
		}
	});
}

// #endregion

// #region rollback

// the source keeps its data and its address; only the mark and what this operation made go. The
// copy of the source database stays once it was recorded, as a backup the owner can see
async function rollback(
	ctx: Ctx,
	deps: BackupDeps,
	input: SiteAdoptInput,
	failure: StepFailed
): Promise<Outcome> {
	const { source, create } = input;
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		await releaseLease(ctx);
		return { status: 'cancelled', reason };
	}
	// a site that went live is kept whole, so nothing is taken off it
	if (await plainStep(ctx, 'rollback.live', () => deps.store.siteLive(create.site.id))) {
		await releaseLease(ctx);
		return { status: 'failed', reason, leaked: [] };
	}
	const leaked: string[] = [];
	const actions: [string, () => Promise<unknown>][] = [
		['unlink', () => deps.store.unlinkAdoption(source.id, create.site.id, deps.now())],
		[
			'parts',
			async () => {
				if ((await deps.backups.get(input.orgId, input.backupId)) !== null) return;
				await deps.blobs.deletePrefix(
					backupKeys.prefix(input.orgId, source.id, input.backupId)
				);
			}
		],
		[
			'target',
			() =>
				cleanTarget(deps, ctx.operationId, ctx.purpose, {
					siteId: create.site.id,
					accountId: create.site.accountId,
					plane: create.site.plane,
					hostname: create.hostname,
					subdomain: create.subdomain
				})
		]
	];
	for (const [name, action] of actions) {
		try {
			await plainStep(ctx, `rollback.${name}`, action);
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			leaked.push(name);
		}
	}
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'rolled-back') return operation;
			return leaked.length === 0
				? transition(
						observe(operation, `rolled back after ${reason}`, deps.now()),
						'rolled-back',
						deps.now()
					)
				: observe(
						operation,
						`rollback incomplete (${leaked.join(', ')}) after ${reason}`,
						deps.now()
					);
		});
	});
	await releaseLease(ctx);
	return leaked.length === 0
		? { status: 'rolled-back', reason }
		: { status: 'failed', reason, leaked };
}

// #endregion

export async function runSiteAdopt(
	step: StepRunner,
	deps: BackupDeps,
	input: SiteAdoptInput
): Promise<Outcome> {
	const { create } = input;
	// the lease is on the source, so nothing else changes it while it is read
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.source.id,
		accountId: create.site.accountId,
		purpose: 'site.adopt',
		epoch: null
	};
	const resources = planResources(create.site, create.site.config, { database: create.database });
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		await preflight(ctx, deps, input);

		const dump = dumpInput(input);
		const source = phase(ctx, 'source', DUMP_IDS);
		const parts = await exportParts(source, deps, dump);
		const manifest = await verifyParts(source, deps, dump, parts);
		await recordBackup(source, deps, dump, manifest);

		const target = phase(ctx, 'target');
		await reserveName(target, create);
		for (const [index, resource] of resources.create.entries()) {
			await createResource(target, create, resource, index === 0 ? resources : null);
		}
		const token = await uploadAssets(target, create);
		await uploadScript(target, create, token);
		await applyAuthority(target, create);
		await putRoute(target, create);
		const sealed: FirstRunSealed = await firstRun(target, create, create.firstRun);
		await link(ctx, deps, input);

		const restore = phase(ctx, 'restore', RESTORE_IDS);
		const restoring = restoreInput(input);
		const checked = await checkRestore(restore, deps, restoring);
		await grant(restore, deps, restoring, checked);
		const sent = await sendDump(restore, deps, restoring, checked);
		await apply(restore, deps, restoring, checked, sent);
		await copyFiles(restore, deps, restoring, checked);
		await verifyRestore(restore, deps, restoring, checked);
		await activate(target, create, sealed);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollback(ctx, deps, input, error);
	}
	await finishSuccess(
		ctx,
		`${input.source.id} was adopted as ${create.site.id} at ${create.hostname}`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
