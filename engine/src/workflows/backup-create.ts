import { canonicalJson, utf8 } from '@contracts/common';
import type { Plan } from '@contracts/operations';
import {
	BackupError,
	backupKeys,
	buildManifest,
	checkPart,
	DEFAULT_RESTORE_CEILING_BYTES,
	describePart,
	manifestDigest,
	MAX_EXPORT_PAGES,
	restorable,
	type BackupErrorCode,
	type BackupManifest,
	type PartDescriptor
} from '../backup-parts';
import { buildPlan, observe, setCursor, setVerification, transition } from '../operations/state';
import type { BackupDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
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

export interface BackupCreateInput {
	operationId: string;
	orgId: string;
	siteId: string;
	accountId: string;
	backupId: string;
	label: string | null;
	// the worker's own limit on a restore body; a larger dump is stored and never restorable
	restoreCeilingBytes?: number;
	maxPages?: number;
}

export function planBackupCreate(input: Pick<BackupCreateInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'backup.create',
		targetIds: [input.siteId],
		preconditions: [`${input.siteId} is active and has an owner token`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'export', name: 'Page the database dump into the bucket' },
			{ id: 'verify', name: 'Check every part against its hash' },
			{ id: 'record', name: 'Record the backup' }
		]
	});
}

// #region the site a backup reads or restores into

export interface OpenSite {
	hostname: string;
	ownerTokenId: string;
	plane: 'managed' | 'self-managed' | 'self-hosted';
}

// what a workflow step may know about a site: where it answers and which sealed token opens it
export async function openSite(
	deps: BackupDeps,
	site: { id: string; orgId: string; accountId: string },
	codes: { notReady: BackupErrorCode; foreign: BackupErrorCode }
): Promise<OpenSite> {
	const row = await deps.backups.site(site.id);
	if (row === null || row.state !== 'active' || row.primaryHostname === null) {
		throw new BackupError(codes.notReady, `${site.id} is not an active site`);
	}
	if (row.organizationId !== site.orgId || row.accountId !== site.accountId) {
		throw new BackupError(codes.foreign, `${site.id} does not belong to this organisation`);
	}
	const { ownerTokenId } = await deps.custody.sealed(site.id);
	if (ownerTokenId === null) {
		throw new BackupError('no_owner_token', `${site.id} has no owner token in custody`);
	}
	return { hostname: row.primaryHostname, ownerTokenId, plane: row.plane };
}

export async function assertOperationOrg(
	deps: BackupDeps,
	operationId: string,
	orgId: string,
	code: BackupErrorCode
): Promise<void> {
	const operation = await deps.store.get(operationId);
	if (operation === null || operation.orgId !== orgId) {
		throw new BackupError(code, `${operationId} does not belong to this organisation`);
	}
}

// #endregion

// #region paging the dump

// the operation's cursor, so a fresh instance picks up where a killed one stopped
interface Progress {
	seq: number;
	cursor: string | null;
	parts: PartDescriptor[];
	hostname: string;
	ownerTokenId: string;
}

interface Saved {
	seq: number;
	cursor: string | null;
}

function readSaved(text: string | null): Saved | null {
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as Partial<Saved>;
		const seq = parsed.seq;
		const cursor = parsed.cursor;
		if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) {
			if (cursor === null || typeof cursor === 'string') return { seq, cursor };
		}
	} catch {
		return null;
	}
	return null;
}

async function startExport(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput
): Promise<Progress> {
	return runStep(
		ctx,
		'export.start',
		'export',
		async () => {
			await fenced(ctx);
			await assertOperationOrg(deps, ctx.operationId, input.orgId, 'site_not_ready');
			const site = await openSite(
				deps,
				{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
				{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
			);
			const operation = await deps.store.get(ctx.operationId);
			const saved = readSaved(operation?.cursor ?? null) ?? { seq: 0, cursor: 'start' };
			const parts: PartDescriptor[] = [];
			for (let seq = 0; seq < saved.seq; seq++) {
				const key = backupKeys.part(input.orgId, input.siteId, input.backupId, seq);
				const bytes = await deps.blobs.get(key);
				if (bytes === null) {
					throw new BackupError('part_missing', `part ${seq} is missing from the bucket`);
				}
				parts.push(await describePart(seq, bytes));
			}
			return { ...saved, parts, hostname: site.hostname, ownerTokenId: site.ownerTokenId };
		},
		{ finish: false }
	);
}

async function exportPage(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput,
	progress: Progress & { cursor: string }
): Promise<Progress> {
	const { seq, cursor } = progress;
	const page = await runStep(
		ctx,
		`export.page.${seq}`,
		'export',
		async () => {
			await fenced(ctx);
			const limit = input.maxPages ?? MAX_EXPORT_PAGES;
			if (seq >= limit) {
				throw new BackupError('export_too_long', `the dump needs more than ${limit} pages`);
			}
			const fetched = await deps.custody.withOwnerToken(
				input.siteId,
				progress.ownerTokenId,
				(bearer) => deps.worker.exportPage(progress.hostname, cursor, { bearer })
			);
			if (fetched.nextCursor === cursor) {
				throw new BackupError(
					'export_stalled',
					`page ${seq} answered with the cursor it was given`
				);
			}
			const bytes = utf8(fetched.sql);
			await deps.blobs.put(
				backupKeys.part(input.orgId, input.siteId, input.backupId, seq),
				bytes
			);
			const part = await describePart(seq, bytes);
			const saved: Saved = { seq: seq + 1, cursor: fetched.nextCursor };
			await deps.store.mutate(ctx.operationId, (operation) =>
				setCursor(operation, JSON.stringify(saved), deps.now())
			);
			return { part, next: fetched.nextCursor };
		},
		{ begin: false, finish: false }
	);
	return {
		...progress,
		seq: seq + 1,
		cursor: page.next,
		parts: [...progress.parts, page.part]
	};
}

async function exportParts(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput
): Promise<PartDescriptor[]> {
	let progress = await startExport(ctx, deps, input);
	while (progress.cursor !== null) {
		progress = await exportPage(ctx, deps, input, { ...progress, cursor: progress.cursor });
	}
	const { parts } = progress;
	await runStep(ctx, 'export.complete', 'export', async () => parts.length, { begin: false });
	return parts;
}

// #endregion

// #region checking and recording

async function verifyParts(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput,
	parts: readonly PartDescriptor[]
): Promise<BackupManifest> {
	return runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		let running = 0;
		for (const part of parts) {
			const key = backupKeys.part(input.orgId, input.siteId, input.backupId, part.seq);
			await checkPart(part, await deps.blobs.get(key));
			running += part.bytes;
		}
		const manifest = buildManifest({
			id: input.backupId,
			orgId: input.orgId,
			siteId: input.siteId,
			parts
		});
		if (manifest.bytes !== running) {
			throw new BackupError(
				'manifest_invalid',
				'the running size does not match the manifest'
			);
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
		return manifest;
	});
}

// the row lands last, so a row always points at a manifest and parts that checked out; verified
// stays false because no scratch restore has proved the dump replays
async function recordBackup(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput,
	manifest: BackupManifest
): Promise<void> {
	const ceiling = input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
	await runStep(ctx, 'record', 'record', async () => {
		await fenced(ctx);
		await deps.blobs.put(
			backupKeys.manifest(input.orgId, input.siteId, input.backupId),
			utf8(canonicalJson(manifest))
		);
		await deps.backups.record({
			id: input.backupId,
			siteId: input.siteId,
			organizationId: input.orgId,
			operationId: input.operationId,
			bytes: manifest.bytes,
			sha256: await manifestDigest(manifest),
			parts: manifest.parts.length,
			restorable: restorable(manifest.bytes, ceiling),
			verified: false,
			label: input.label,
			createdAt: deps.now(),
			deletedAt: null
		});
	});
}

// #endregion

// a failed create records nothing: the parts under this backup's own prefix go, unless a row
// already points at them
async function rollback(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupCreateInput,
	failure: StepFailed
): Promise<Outcome> {
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		await releaseLease(ctx);
		return { status: 'cancelled', reason };
	}
	await plainStep(ctx, 'rollback.parts', async () => {
		if ((await deps.backups.get(input.orgId, input.backupId)) !== null) return;
		await deps.blobs.deletePrefix(backupKeys.prefix(input.orgId, input.siteId, input.backupId));
	});
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'rolled-back'
				? operation
				: transition(
						observe(operation, `nothing was recorded after ${reason}`, deps.now()),
						'rolled-back',
						deps.now()
					)
		);
	});
	await releaseLease(ctx);
	return { status: 'rolled-back', reason };
}

export async function runBackupCreate(
	step: StepRunner,
	deps: BackupDeps,
	input: BackupCreateInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'backup.create',
		epoch: null
	};
	let manifest: BackupManifest;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		const parts = await exportParts(ctx, deps, input);
		manifest = await verifyParts(ctx, deps, input, parts);
		await recordBackup(ctx, deps, input, manifest);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollback(ctx, deps, input, error);
	}
	await finishSuccess(
		ctx,
		`backup ${input.backupId} of ${input.siteId} holds ${manifest.bytes} bytes in ${manifest.parts.length} parts, not yet restore-tested`
	);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
