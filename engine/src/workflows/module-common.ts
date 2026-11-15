import { backupKeys, DEFAULT_RESTORE_CEILING_BYTES } from '../backup-parts';
import { observe, setVerification, transition } from '../operations/state';
import type { ModuleDeps, ModuleReading } from '../ports';
import type { StepFailed } from '../step';
import {
	assertOperationOrg,
	exportParts,
	openSite,
	recordBackup,
	verifyParts,
	type BackupCreateInput,
	type OpenSite
} from './backup-create';
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
import { phase } from './site-adopt';

export interface ModuleInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	// where the restore point taken before the change is kept
	backupId: string;
	// the composer name, vendor/project
	name: string;
	restoreCeilingBytes?: number;
}

// the restore point's steps carry their own ids so they never meet the change's own
const DUMP_IDS = { verify: 'restore-point-verify', record: 'restore-point-record' };

export const RESTORE_POINT_STEPS = [
	{ id: 'export', name: 'Copy the site database into a restore point' },
	{ id: DUMP_IDS.verify, name: 'Check every part of the restore point' },
	{ id: DUMP_IDS.record, name: 'Record the restore point' }
];

const ceilingOf = (input: ModuleInput) =>
	input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;

export function dumpInput(input: ModuleInput, label: string): BackupCreateInput {
	return {
		operationId: input.operationId,
		orgId: input.orgId,
		siteId: input.siteId,
		accountId: input.accountId,
		backupId: input.backupId,
		label,
		restoreCeilingBytes: ceilingOf(input),
		// a restore point the site could not take back is no rollback point
		stopAboveBytes: ceilingOf(input)
	};
}

export async function takeRestorePoint(
	ctx: Ctx,
	deps: ModuleDeps,
	input: ModuleInput,
	label: string
): Promise<void> {
	const dump = phase(ctx, 'restore-point', DUMP_IDS);
	const create = dumpInput(input, label);
	const parts = await exportParts(dump, deps, create);
	const manifest = await verifyParts(dump, deps, create, parts);
	await recordBackup(dump, deps, create, manifest);
}

// where the site answers and which sealed token opens it, after the lease is held
export async function openForChange(
	ctx: Ctx,
	deps: ModuleDeps,
	input: ModuleInput,
	then?: (site: OpenSite) => Promise<void>
): Promise<OpenSite> {
	return runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
		const site = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
		);
		await then?.(site);
		return site;
	});
}

export function withOwnerToken<T>(
	deps: ModuleDeps,
	input: Pick<ModuleInput, 'siteId'>,
	site: OpenSite,
	use: (auth: { bearer: string }) => Promise<T>
): Promise<T> {
	return deps.custody.withOwnerToken(input.siteId, site.ownerTokenId, (bearer) =>
		use({ bearer })
	);
}

export async function readModule(
	deps: ModuleDeps,
	input: ModuleInput,
	site: OpenSite,
	project: string
): Promise<ModuleReading> {
	return withOwnerToken(deps, input, site, (auth) =>
		deps.modules.read(site.hostname, project, auth)
	);
}

// the steps at and after these may have changed the site
export async function stopFailed(
	ctx: Ctx,
	deps: ModuleDeps,
	input: ModuleInput,
	failure: StepFailed,
	after: {
		changing: readonly string[];
		project: string;
		// true when the reading shows the site as it was before the change
		unchanged: (reading: ModuleReading) => boolean;
		// what the owner reads when the site is as it was, and when it is not or cannot be read
		asWas: string;
		unknown: string;
	}
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
	const pointer = recorded ? ` Restore point ${input.backupId} holds the site from before.` : '';
	let outcome: string;
	if (!after.changing.includes(failure.step)) {
		outcome = `${reason}; nothing on the site was changed.`;
	} else {
		const reading = await plainStep(ctx, 'rollback.read', async () => {
			try {
				const site = await openSite(
					deps,
					{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
					{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
				);
				return await readModule(deps, input, site, after.project);
			} catch {
				return null;
			}
		});
		outcome =
			reading !== null && after.unchanged(reading)
				? `${reason}; ${after.asWas}`
				: `${reason}; ${after.unknown}${pointer}`;
	}
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) =>
			setVerification(observe(operation, outcome, deps.now()), 'failed', deps.now())
		);
	});
	await releaseLease(ctx);
	return { status: 'failed', reason: outcome, leaked: [] };
}

export const verifiedStep = (ctx: Ctx, deps: ModuleDeps, work: () => Promise<void>) =>
	runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		await work();
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
