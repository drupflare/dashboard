import { siteId as siteIdSchema } from '@contracts/common';
import type { Plan } from '@contracts/operations';
import type { SitePlane } from '@contracts/sites';
import {
	BackupError,
	backupKeys,
	checkPart,
	DEFAULT_RESTORE_CEILING_BYTES,
	joinParts,
	manifestDigest,
	parseManifest,
	restorable,
	type BackupManifest,
	type BackupRecord
} from '../backup-parts';
import { buildPlan, setVerification, transition } from '../operations/state';
import { assertOwned } from '../ownership';
import type { BackupDeps } from '../ports';
import { StepFailed, type StepRunner } from '../step';
import { assertOperationOrg, openSite } from './backup-create';
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
import { chooseRoute, finishRestore, landPaged } from './restore-pages';

export interface BackupRestoreInput {
	operationId: string;
	orgId: string;
	backupId: string;
	// the site the dump is restored into
	siteId: string;
	accountId: string;
	// the longest each wait for the site may take, and how long to pause between reads
	waitMs: number;
	pollMs: number;
	probe?: { path: string; expectStatus: number };
	restoreCeilingBytes?: number;
}

export function planBackupRestore(input: Pick<BackupRestoreInput, 'siteId'>): Plan {
	return buildPlan({
		type: 'backup.restore',
		targetIds: [input.siteId],
		preconditions: [
			`${input.siteId} is active, has an owner token and belongs to the organisation`,
			'the backup is restorable and its parts match the manifest'
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'check', name: 'Check the target and the backup' },
			{ id: 'grant', name: 'Grant the source files to the target' },
			{ id: 'restore', name: 'Send the dump to the site' },
			{ id: 'apply', name: 'Wait for the site to apply the dump' },
			{ id: 'adopt', name: 'Wait for the files to be copied and drop the grant' },
			{ id: 'verify', name: 'Probe the restored site' }
		]
	});
}

// #region the file grant

export const grantKey = (targetSiteId: string) => `file_clone:${targetSiteId}`;

interface GrantClaim {
	siteId: string;
	accountId: string;
	plane: SitePlane;
}

// the namespace must be a live ledger row of the target in its own account, so a namespace id
// from anywhere else is refused before any call is made
async function guardedNamespace(
	deps: BackupDeps,
	claim: GrantClaim,
	namespaceId: string
): Promise<void> {
	assertOwned(
		claim.plane,
		{
			siteId: claim.siteId,
			accountId: claim.accountId,
			kind: 'kv',
			id: namespaceId,
			action: 'update'
		},
		await deps.ledger.live(claim.siteId)
	);
}

async function configNamespace(deps: BackupDeps, claim: GrantClaim): Promise<string> {
	const row = (await deps.ledger.live(claim.siteId)).find(
		(live) => live.kind === 'kv' && live.binding === 'CONFIG_KV'
	);
	if (row === undefined || row.providerId === null) {
		throw new BackupError(
			'grant_no_namespace',
			`${claim.siteId} has no config namespace on record`
		);
	}
	return row.providerId;
}

// sources are site ids from this organisation's own records, never a value from a request
export async function grantFileClone(
	deps: BackupDeps,
	claim: GrantClaim,
	namespaceId: string,
	sources: readonly string[]
): Promise<void> {
	for (const source of sources) {
		if (!siteIdSchema.safeParse(source).success) {
			throw new BackupError('grant_refused', 'a grant source is not a site id');
		}
	}
	await guardedNamespace(deps, claim, namespaceId);
	await deps.kv.put(namespaceId, grantKey(claim.siteId), sources.join(','));
}

export async function dropFileClone(
	deps: BackupDeps,
	claim: GrantClaim,
	namespaceId: string
): Promise<void> {
	await guardedNamespace(deps, claim, namespaceId);
	await deps.kv.delete(namespaceId, grantKey(claim.siteId));
}

// the backup's own site, when it is still a live site of this organisation with a bucket of files;
// a gone source has nothing to copy, and a source in another organisation is refused
export async function grantSources(
	deps: BackupDeps,
	backup: BackupRecord,
	orgId: string,
	targetSiteId: string
): Promise<string[]> {
	const sources: string[] = [];
	for (const id of [backup.siteId]) {
		if (id === targetSiteId) continue;
		const site = await deps.backups.site(id);
		if (site === null || site.state === 'deleted') continue;
		if (site.organizationId !== orgId) {
			throw new BackupError('grant_refused', `${id} belongs to another organisation`);
		}
		const live = await deps.ledger.live(id);
		const holdsFiles = live.some(
			(row) => row.kind === 'r2' && row.providerId !== null && row.missingAt === null
		);
		if (holdsFiles) sources.push(id);
	}
	return sources;
}

// #endregion

// #region the backup

async function loadManifest(deps: BackupDeps, backup: BackupRecord): Promise<BackupManifest> {
	const key = backupKeys.manifest(backup.organizationId, backup.siteId, backup.id);
	const stored = await deps.blobs.get(key);
	if (stored === null)
		throw new BackupError('part_missing', 'the manifest is missing from the bucket');
	const manifest = parseManifest(new TextDecoder().decode(stored));
	const same =
		manifest.id === backup.id &&
		manifest.orgId === backup.organizationId &&
		manifest.siteId === backup.siteId &&
		manifest.parts.length === backup.parts &&
		manifest.bytes === backup.bytes &&
		(await manifestDigest(manifest)) === backup.sha256;
	if (!same) throw new BackupError('manifest_changed', 'the manifest does not match the record');
	return manifest;
}

// every part is checked against the manifest; the bytes are kept only when the caller will send
// them in one body, so a large dump is never held whole
async function readParts(
	deps: BackupDeps,
	backup: BackupRecord,
	manifest: BackupManifest,
	keep = true
): Promise<Uint8Array[]> {
	const parts: Uint8Array[] = [];
	for (const part of manifest.parts) {
		const bytes = await deps.blobs.get(
			backupKeys.part(backup.organizationId, backup.siteId, backup.id, part.seq)
		);
		await checkPart(part, bytes);
		if (keep) parts.push(bytes as Uint8Array);
	}
	return parts;
}

async function loadBackup(
	deps: BackupDeps,
	input: BackupRestoreInput
): Promise<{ backup: BackupRecord; manifest: BackupManifest }> {
	const backup = await deps.backups.get(input.orgId, input.backupId);
	if (backup === null) {
		throw new BackupError(
			'backup_not_found',
			`${input.backupId} is not a backup of this organisation`
		);
	}
	const ceiling = input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
	if (!backup.restorable || !restorable(backup.bytes, ceiling)) {
		throw new BackupError(
			'not_restorable',
			`${backup.id} is larger than the site accepts in a restore`
		);
	}
	return { backup, manifest: await loadManifest(deps, backup) };
}

// #endregion

// #region steps

export interface Checked {
	hostname: string;
	ownerTokenId: string;
	plane: SitePlane;
	label: string;
	sources: string[];
}

export async function check(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput
): Promise<Checked> {
	return runStep(ctx, 'check', 'check', async () => {
		await fenced(ctx);
		await assertOperationOrg(deps, ctx.operationId, input.orgId, 'target_other_organisation');
		const site = await openSite(
			deps,
			{ id: input.siteId, orgId: input.orgId, accountId: input.accountId },
			{ notReady: 'target_not_ready', foreign: 'target_other_organisation' }
		);
		const { backup, manifest } = await loadBackup(deps, input);
		await readParts(deps, backup, manifest);
		return {
			hostname: site.hostname,
			ownerTokenId: site.ownerTokenId,
			plane: site.plane,
			label: ctx.operationId,
			sources: await grantSources(deps, backup, input.orgId, input.siteId)
		};
	});
}

export async function grant(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput,
	checked: Checked
): Promise<void> {
	await runStep(ctx, 'grant', 'grant', async () => {
		await fenced(ctx);
		if (checked.sources.length === 0) return;
		const claim = { siteId: input.siteId, accountId: input.accountId, plane: checked.plane };
		await grantFileClone(deps, claim, await configNamespace(deps, claim), checked.sources);
	});
}

// the stored statements that ride after a backup's own parts, such as files copied from the source
export interface DumpExtra {
	keys: readonly string[];
	bytes: number;
}

// the import carries the operation id as its label, so a resumed step finds its own import and
// does not send the dump twice. A body that fits one request goes in one call; a larger one goes
// through the paged restore, when the site has it
export async function sendDump(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput,
	checked: Checked,
	extra: DumpExtra = { keys: [], bytes: 0 }
): Promise<{ startedAt: number; bytes: number }> {
	const ceiling = input.restoreCeilingBytes ?? DEFAULT_RESTORE_CEILING_BYTES;
	const target = {
		siteId: input.siteId,
		hostname: checked.hostname,
		ownerTokenId: checked.ownerTokenId,
		label: checked.label
	};
	const sent = await runStep(
		ctx,
		'restore',
		'restore',
		async () => {
			await fenced(ctx);
			const { backup, manifest } = await loadBackup(deps, input);
			const total = backup.bytes + extra.bytes;
			const route = await chooseRoute(deps, target, total, ceiling);
			if (route === 'paged') {
				await readParts(deps, backup, manifest, false);
				return { route, bytes: total };
			}
			const stored = await readParts(deps, backup, manifest);
			for (const key of extra.keys) {
				const bytes = await deps.blobs.get(key);
				if (bytes === null)
					throw new BackupError('part_missing', 'a part of the dump is missing');
				stored.push(bytes);
			}
			const body = joinParts(stored);
			if (!restorable(body.byteLength, ceiling)) {
				throw new BackupError(
					'not_restorable',
					`${backup.id} is larger than the site accepts in a restore`
				);
			}
			await deps.custody.withOwnerToken(
				input.siteId,
				checked.ownerTokenId,
				async (bearer) => {
					const state = await deps.worker.importState(checked.hostname, checked.label, {
						bearer
					});
					if (state === 'absent') {
						await deps.worker.restore(checked.hostname, body, checked.label, {
							bearer
						});
					}
				}
			);
			return { route, bytes: body.byteLength };
		},
		{ finish: false }
	);
	if (sent.route === 'single') {
		return { startedAt: await finishRestore(ctx), bytes: sent.bytes };
	}
	const { backup } = await loadBackup(deps, input);
	const keys = [
		...Array.from({ length: backup.parts }, (_, seq) =>
			backupKeys.part(backup.organizationId, backup.siteId, backup.id, seq)
		),
		...extra.keys
	];
	return { startedAt: await landPaged(ctx, deps, target, keys, ceiling), bytes: sent.bytes };
}

export async function apply(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput,
	checked: Checked,
	sent: { startedAt: number }
): Promise<void> {
	await runStep(ctx, 'apply', 'apply', async () => {
		await fenced(ctx);
		const deadline = sent.startedAt + input.waitMs;
		for (;;) {
			const state = await deps.custody.withOwnerToken(
				input.siteId,
				checked.ownerTokenId,
				(bearer) => deps.worker.importState(checked.hostname, checked.label, { bearer })
			);
			if (state === 'applied') return;
			if (state === 'failed') {
				const reason = await deps.custody.withOwnerToken(
					input.siteId,
					checked.ownerTokenId,
					(bearer) =>
						deps.worker.importReason(checked.hostname, checked.label, { bearer })
				);
				throw new BackupError(
					'import_failed',
					`${input.siteId} reported that the import failed${reason === '' ? '' : ` at ${reason}`}`
				);
			}
			if (deps.now() >= deadline) {
				throw new BackupError(
					'import_timeout',
					`${input.siteId} had not applied the dump in time`
				);
			}
			await deps.sleep(input.pollMs);
		}
	});
}

// the key stays until the copies finish; a timeout leaves it in place on purpose
export async function adopt(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput,
	checked: Checked
): Promise<void> {
	await runStep(ctx, 'adopt', 'adopt', async () => {
		await fenced(ctx);
		if (checked.sources.length === 0) return;
		const deadline = deps.now() + input.waitMs;
		for (;;) {
			const adopting = await deps.custody.withOwnerToken(
				input.siteId,
				checked.ownerTokenId,
				(bearer) => deps.worker.adopting(checked.hostname, { bearer })
			);
			if (adopting === 0) break;
			if (deps.now() >= deadline) {
				throw new BackupError('adopting_timeout', `${input.siteId} is still copying files`);
			}
			await deps.sleep(input.pollMs);
		}
		const claim = { siteId: input.siteId, accountId: input.accountId, plane: checked.plane };
		await dropFileClone(deps, claim, await configNamespace(deps, claim));
	});
}

// the site answers 503 until the replay lands, so the probe runs only after it applied
export async function verify(
	ctx: Ctx,
	deps: BackupDeps,
	input: BackupRestoreInput,
	checked: Checked
): Promise<void> {
	const probe = input.probe ?? { path: '/', expectStatus: 200 };
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const { status } = await deps.site.probe(checked.hostname, probe.path, probe.expectStatus);
		if (status !== probe.expectStatus) {
			throw new Error(`the probe answered ${status}, wanted ${probe.expectStatus}`);
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

// #endregion

// a restore overwrites the database, so a failure is finished by running it again and never rolled back
export async function runBackupRestore(
	step: StepRunner,
	deps: BackupDeps,
	input: BackupRestoreInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.siteId,
		accountId: input.accountId,
		purpose: 'backup.restore',
		epoch: null
	};
	let checked: Checked;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		checked = await check(ctx, deps, input);
		await grant(ctx, deps, input, checked);
		const sent = await sendDump(ctx, deps, input, checked);
		await apply(ctx, deps, input, checked, sent);
		await adopt(ctx, deps, input, checked);
		await verify(ctx, deps, input, checked);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const closed = await closeFailed(ctx, error);
		const reason = describeFailure(error);
		await releaseLease(ctx);
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	const note =
		checked.sources.length === 0
			? ''
			: `; the buckets of ${checked.sources.join(', ')} must outlive the copy of their files`;
	await finishSuccess(ctx, `${input.siteId} was restored from ${input.backupId}${note}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
