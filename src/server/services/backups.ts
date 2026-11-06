import type { R2Bucket } from '@cloudflare/workers-types';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest, type Plan } from '@contracts/operations';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import {
	backupKeys,
	checkPart,
	manifestDigest,
	newBackupId,
	parseManifest,
	type BackupRecord
} from '../../../engine/src/backup-parts';
import {
	planBackupCreate,
	type BackupCreateInput
} from '../../../engine/src/workflows/backup-create';
import {
	planBackupRestore,
	type BackupRestoreInput
} from '../../../engine/src/workflows/backup-restore';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord, getBackup, listBackups } from '../db/repos/backups';
import { getOperation, updateOperationStatus, type StoredOperation } from '../db/repos/operations';
import { getReadySite, type SiteRecord } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { EngineStartError, type EngineStartRequest } from '../integrations/engine';
import { append, type AuditInput, type HeadStore } from './audit';
import { principalActor } from './owner-tokens';

export interface BackupServices {
	getDb: () => Promise<CollegeDBClient>;
	startOperation: (request: EngineStartRequest) => Promise<void>;
	blobs: { get(key: string): Promise<Uint8Array | null> };
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	// the worker's limit on a restore body; a larger dump is stored and refused on restore
	restoreCeilingBytes: number;
	// how long a restore waits on the site for the replay and for file copies, and the pause between reads
	waitMs: number;
	pollMs: number;
}

// unreviewed: below the engine's ten minute step limit, and a pause short of the worker's cache
export const DEFAULT_WAIT_MS = 480_000;
export const DEFAULT_POLL_MS = 5_000;

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): BackupServices {
	return {
		getDb: notBuilt('The backup store'),
		startOperation: notBuilt('Starting an operation'),
		blobs: { get: notBuilt('The backup bucket') },
		audit: notBuilt('The audit log'),
		restoreCeilingBytes: 16 * 1024 * 1024,
		waitMs: DEFAULT_WAIT_MS,
		pollMs: DEFAULT_POLL_MS
	};
}

let installed = productionServices();

export function setBackupServices(over: Partial<BackupServices>): void {
	installed = { ...installed, ...over };
}

export function resetBackupServices(): void {
	installed = productionServices();
}

export function backupServices(): BackupServices {
	return installed;
}

// the audit row goes to the organisation's own chain
export function backupServicesOf(
	env: { BLOB: R2Bucket },
	base: {
		getDb: () => Promise<CollegeDBClient>;
		startOperation: BackupServices['startOperation'];
	},
	heads: HeadStore,
	options: Partial<Pick<BackupServices, 'restoreCeilingBytes' | 'waitMs' | 'pollMs'>> = {}
): BackupServices {
	const defaults = productionServices();
	return {
		getDb: base.getDb,
		startOperation: base.startOperation,
		blobs: {
			async get(key) {
				const object = await env.BLOB.get(key);
				return object === null ? null : new Uint8Array(await object.arrayBuffer());
			}
		},
		audit: async (orgId, input) => append(await base.getDb(), orgId, input, heads),
		restoreCeilingBytes: options.restoreCeilingBytes ?? defaults.restoreCeilingBytes,
		waitMs: options.waitMs ?? defaults.waitMs,
		pollMs: options.pollMs ?? defaults.pollMs
	};
}

// #region the view

export const backupViewSchema = z.strictObject({
	id: z.string(),
	siteId: z.string(),
	operationId: z.string(),
	bytes: z.int().nonnegative(),
	sha256: z.string(),
	parts: z.int().nonnegative(),
	restorable: z.boolean(),
	notRestorableReason: z.string().nullable(),
	verified: z.boolean(),
	label: z.string().nullable(),
	createdAt: z.string()
});
export type BackupView = z.infer<typeof backupViewSchema>;

const mebibytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export function toBackupView(record: BackupRecord, ceiling: number): BackupView {
	return {
		id: record.id,
		siteId: record.siteId,
		operationId: record.operationId,
		bytes: record.bytes,
		sha256: record.sha256,
		parts: record.parts,
		restorable: record.restorable,
		notRestorableReason: record.restorable
			? null
			: `The dump is ${mebibytes(record.bytes)} and a site accepts at most ${mebibytes(ceiling)} in a restore. You can still export it.`,
		verified: record.verified,
		label: record.label,
		createdAt: new Date(record.createdAt).toISOString()
	};
}

// #endregion

const notFound = () => new ApiError('not_found', 'Not found');

async function activeSite(
	services: BackupServices,
	orgId: string,
	siteId: string
): Promise<{ db: CollegeDBClient; site: SiteRecord & { accountId: string } }> {
	const db = await services.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw notFound();
	if (site.state !== 'active' || site.accountId === null) {
		throw new ApiError('unprocessable', 'The site is not active', {
			reason: 'site_not_active'
		});
	}
	return { db, site: { ...site, accountId: site.accountId } };
}

// the engine owns every status after it accepts the start; a refused start is the dashboard's to close
async function startAndReturn(
	services: BackupServices,
	db: CollegeDBClient,
	operation: StoredOperation,
	request: EngineStartRequest,
	orgId: string
): Promise<StoredOperation> {
	try {
		await services.startOperation(request);
	} catch (error) {
		await updateOperationStatus(
			db,
			orgId,
			request.id,
			operation.version,
			'failed',
			nowUtc().toMillis()
		);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The operation could not be started', {
			operationId: request.id,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	const latest = await getOperation(db, orgId, request.id);
	if (!latest) throw new Error(`operation ${request.id} is missing after its start`);
	return latest;
}

async function newOperation(
	db: CollegeDBClient,
	input: {
		id: string;
		orgId: string;
		accountId: string;
		siteId: string;
		type: 'backup.create' | 'backup.restore';
		plan: Plan;
		idempotencyKey: string;
	}
) {
	const now = nowUtc().toMillis();
	return createOperationRecord(db, {
		id: input.id,
		organizationId: input.orgId,
		accountId: input.accountId,
		siteId: input.siteId,
		type: input.type,
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: input.plan.targetIds,
		preconditions: input.plan.preconditions,
		planDigest: await computePlanDigest(input.plan),
		blastRadius: input.plan.blastRadius,
		rollbackPoint: input.plan.rollbackPoint,
		verification: 'pending',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: input.plan.steps,
		now
	});
}

// #region the routes' operations

export async function startBackup(
	services: BackupServices,
	input: {
		orgId: string;
		siteId: string;
		label: string | null;
		idempotencyKey: string;
		operationId: string;
	}
): Promise<StoredOperation> {
	const { db, site } = await activeSite(services, input.orgId, input.siteId);
	const params: BackupCreateInput = {
		operationId: input.operationId,
		orgId: input.orgId,
		siteId: site.id,
		accountId: site.accountId,
		backupId: newBackupId(),
		label: input.label,
		restoreCeilingBytes: services.restoreCeilingBytes
	};
	const { operation, created } = await newOperation(db, {
		id: input.operationId,
		orgId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'backup.create',
		plan: planBackupCreate(params),
		idempotencyKey: input.idempotencyKey
	});
	if (!created) return operation;
	return startAndReturn(
		services,
		db,
		operation,
		{
			workflow: 'backup-create',
			id: input.operationId,
			params: params as unknown as Record<string, unknown>
		},
		input.orgId
	);
}

export async function listSiteBackups(
	services: BackupServices,
	input: {
		orgId: string;
		siteId: string;
		after?: { createdAt: number; id: string };
		count: number;
	}
): Promise<BackupRecord[]> {
	const db = await services.getDb();
	if ((await getReadySite(db, input.orgId, input.siteId)) === null) throw notFound();
	return listBackups(db, input.orgId, input.siteId, { after: input.after, count: input.count });
}

// the backup is the path's site's own, and the target is another ready site of the same organisation
export async function startRestore(
	services: BackupServices,
	input: {
		orgId: string;
		siteId: string;
		backupId: string;
		targetSiteId: string;
		idempotencyKey: string;
		operationId: string;
	}
): Promise<StoredOperation> {
	const db = await services.getDb();
	const backup = await getBackup(db, input.orgId, input.siteId, input.backupId);
	if (backup === null) throw notFound();
	const { site: target } = await activeSite(services, input.orgId, input.targetSiteId);
	if (!backup.restorable || backup.bytes > services.restoreCeilingBytes) {
		throw new ApiError('unprocessable', 'This backup is too large to restore into a site', {
			reason: 'not_restorable',
			bytes: backup.bytes,
			limit: services.restoreCeilingBytes
		});
	}
	const params: BackupRestoreInput = {
		operationId: input.operationId,
		orgId: input.orgId,
		backupId: backup.id,
		siteId: target.id,
		accountId: target.accountId,
		waitMs: services.waitMs,
		pollMs: services.pollMs,
		restoreCeilingBytes: services.restoreCeilingBytes
	};
	const { operation, created } = await newOperation(db, {
		id: input.operationId,
		orgId: input.orgId,
		accountId: target.accountId,
		siteId: target.id,
		type: 'backup.restore',
		plan: planBackupRestore(params),
		idempotencyKey: input.idempotencyKey
	});
	if (!created) return operation;
	return startAndReturn(
		services,
		db,
		operation,
		{
			workflow: 'backup-restore',
			id: input.operationId,
			params: params as unknown as Record<string, unknown>
		},
		input.orgId
	);
}

function partStream(
	services: BackupServices,
	backup: BackupRecord,
	parts: { seq: number; bytes: number; sha256: string }[]
): ReadableStream<Uint8Array> {
	let next = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const part = parts[next];
			if (part === undefined) return controller.close();
			try {
				const bytes = await services.blobs.get(
					backupKeys.part(backup.organizationId, backup.siteId, backup.id, part.seq)
				);
				await checkPart(part, bytes);
				controller.enqueue(bytes as Uint8Array);
				next++;
			} catch (error) {
				// a part that no longer matches ends the download as a failure, never as a short file
				controller.error(error);
			}
		}
	});
}

// the audit row goes first, so an export that fails still leaves a trace; the dump never carries
// secrets because the engine's page request never asks for them
export async function exportBackup(
	services: BackupServices,
	input: { orgId: string; siteId: string; backupId: string; principal: Principal }
): Promise<Response> {
	if (input.principal.kind !== 'user') {
		throw new ApiError('forbidden', 'This action needs a signed-in session', {
			reason: 'session_only'
		});
	}
	const db = await services.getDb();
	const backup = await getBackup(db, input.orgId, input.siteId, input.backupId);
	if (backup === null) throw notFound();
	await services.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.backup.export',
		target: backup.siteId,
		detail: { backupId: backup.id, bytes: backup.bytes }
	});
	const stored = await services.blobs.get(
		backupKeys.manifest(backup.organizationId, backup.siteId, backup.id)
	);
	if (stored === null) throw new ApiError('internal', 'The backup is incomplete');
	const manifest = parseManifest(new TextDecoder().decode(stored));
	if (
		manifest.bytes !== backup.bytes ||
		manifest.parts.length !== backup.parts ||
		(await manifestDigest(manifest)) !== backup.sha256
	) {
		throw new ApiError('internal', 'The backup does not match its record');
	}
	return new Response(partStream(services, backup, manifest.parts), {
		status: 200,
		headers: {
			'Content-Type': 'application/sql; charset=utf-8',
			'Content-Disposition': `attachment; filename="${backup.id}.sql"`,
			'Content-Length': String(backup.bytes),
			'Cache-Control': 'no-store'
		}
	});
}

// #endregion
