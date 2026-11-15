import type { CollegeDBClient } from '@earth-app/collegedb';
import { newBackupId } from '../../../engine/src/backup-parts';
import {
	buildEditBundle,
	editBundleBytes,
	editKeys,
	parseEditBundle
} from '../../../engine/src/modify-bundle';
import { planModifyApply, type ModifyApplyInput } from '../../../engine/src/workflows/modify-apply';
import { ApiError } from '../../shared/errors';
import { checkModifyFiles, type ModifyFileInput } from '../../shared/modify';
import { restoreCeiling } from '../../shared/restore-limits';
import {
	findOpenSiteOperation,
	getOperationByKey,
	type StoredOperation
} from '../db/repos/operations';
import { getRelease } from '../db/repos/releases';
import { getSiteRevision } from '../db/repos/site-revisions';
import { getReadySite, type SiteRecord } from '../db/repos/sites';
import type { Entitlement } from '../domain/entitlements';
import { guardRollback } from '../domain/rollback-guard';
import type { AuditInput } from './audit';
import { newOperation, startAndReturn, type BackupServices } from './backups';
import type { OwnerTokenStore } from './owner-tokens';

export interface ModifyServices {
	getDb: () => Promise<CollegeDBClient>;
	startOperation: BackupServices['startOperation'];
	planOf: (orgId: string) => Promise<Entitlement>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	ownerTokens: Pick<OwnerTokenStore, 'get'>;
	// the engine reads the files from here, so they never ride in the operation or the workflow start
	blobs: {
		put(key: string, bytes: Uint8Array): Promise<void>;
		get(key: string): Promise<Uint8Array | null>;
	};
	restoreCeilingBytes: number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): ModifyServices {
	return {
		getDb: notBuilt('The site store'),
		startOperation: notBuilt('Starting an operation'),
		planOf: notBuilt('The plan lookup'),
		audit: notBuilt('The audit log'),
		ownerTokens: { get: notBuilt('Secret custody') },
		blobs: { put: notBuilt('The file store'), get: notBuilt('The file store') },
		restoreCeilingBytes: restoreCeiling(false)
	};
}

let installed = productionServices();

export function setModifyServices(over: Partial<ModifyServices>): void {
	installed = { ...installed, ...over };
}

export function resetModifyServices(): void {
	installed = productionServices();
}

export function modifyServices(): ModifyServices {
	return installed;
}

const refused = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
	new ApiError('unprocessable', message, { reason, ...extra });

export interface EditRequest {
	orgId: string;
	siteId: string;
	actor: string;
	idempotencyKey: string;
	operationId: string;
}

// the same request again returns the operation it made; another request on the key is refused
async function knownOperation(
	db: CollegeDBClient,
	input: EditRequest
): Promise<StoredOperation | null> {
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known === null) return null;
	if (known.operation.type !== 'modify.apply' || known.operation.targetIds[0] !== input.siteId) {
		throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
			reason: 'idempotency_key_reused'
		});
	}
	return known;
}

// both planes reach the site by hostname and owner token, so one set of checks serves both
async function editableSite(
	services: ModifyServices,
	db: CollegeDBClient,
	input: EditRequest
): Promise<SiteRecord & { accountId: string }> {
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.kind !== 'drupal') throw refused('Edits are for Drupal sites.', 'not_drupal');
	if (site.state !== 'active' || site.accountId === null || site.primaryHostname === null) {
		throw refused('This site is not active, so it cannot take an edit.', 'site_not_active');
	}
	if ((await services.ownerTokens.get(site.id)) === null) {
		throw refused(
			'Drupflare holds no access for this site, so it cannot deliver files to it.',
			'no_owner_token'
		);
	}
	if (!(await services.planOf(input.orgId)).features.customCode) {
		throw refused(
			'Delivering your own code is not included on this plan.',
			'feature_not_included'
		);
	}
	const busy = await findOpenSiteOperation(db, input.orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}
	return { ...site, accountId: site.accountId };
}

async function start(
	services: ModifyServices,
	db: CollegeDBClient,
	site: SiteRecord & { accountId: string },
	input: EditRequest,
	params: ModifyApplyInput
): Promise<{ stored: StoredOperation; created: boolean }> {
	const { operation, created } = await newOperation(db, {
		id: input.operationId,
		orgId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'modify.apply',
		plan: planModifyApply(params),
		idempotencyKey: input.idempotencyKey,
		inputs: params
	});
	if (!created) return { stored: operation, created };
	const stored = await startAndReturn(
		services,
		db,
		operation,
		{
			workflow: 'modify-apply',
			id: input.operationId,
			params: params as unknown as Record<string, unknown>
		},
		input.orgId
	);
	return { stored, created };
}

const baseParams = (
	services: ModifyServices,
	site: SiteRecord & { accountId: string },
	input: EditRequest,
	name: string,
	bundleKey: string,
	note: string
): ModifyApplyInput => ({
	operationId: input.operationId,
	orgId: input.orgId,
	siteId: site.id,
	accountId: site.accountId,
	backupId: newBackupId(),
	name,
	restoreCeilingBytes: services.restoreCeilingBytes,
	bundleKey,
	note
});

export async function modifySiteFiles(
	services: ModifyServices,
	input: EditRequest & { files: readonly ModifyFileInput[]; note: string }
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await knownOperation(db, input);
	if (known !== null) return known;
	const site = await editableSite(services, db, input);
	const checked = checkModifyFiles(input.files);
	if (!checked.ok) {
		const { problems } = checked;
		throw refused(
			problems.length === 1 && problems[0] !== undefined
				? problems[0].message
				: `${problems.length} files were refused. Each one has its own reason.`,
			'files_refused',
			{ problems }
		);
	}
	const { package: name, files, bytes } = checked.value;
	const bundleKey = editKeys.bundle(input.orgId, site.id, input.operationId);
	await services.blobs.put(bundleKey, editBundleBytes(await buildEditBundle(name, files)));
	const { stored, created } = await start(
		services,
		db,
		site,
		input,
		baseParams(services, site, input, name, bundleKey, input.note)
	);
	if (created) {
		await services.audit(input.orgId, {
			actor: input.actor,
			action: 'site.modify',
			target: site.id,
			detail: { operationId: input.operationId, package: name, files: files.length, bytes }
		});
	}
	return stored;
}

// an edit is rolled back to by sending its stored files again; the data stays as it is
export async function rollbackSiteEdit(
	services: ModifyServices,
	input: EditRequest & { revisionId: string }
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await knownOperation(db, input);
	if (known !== null) return known;
	const site = await editableSite(services, db, input);
	const row = await getSiteRevision(db, input.orgId, site.id, input.revisionId);
	if (row === null) throw new ApiError('not_found', 'Not found');
	if (row.kind !== 'edit' || row.bundleKey === null) {
		throw refused(
			'This entry did not keep its files, so the site cannot go back to it.',
			'no_bundle'
		);
	}
	const target = row.releaseId === null ? null : await getRelease(db, row.releaseId);
	if (target !== null) {
		const verdict = guardRollback({
			dataSchemaVersion: site.dataSchemaVersion,
			target: { schemaVersion: target.schemaVersion, acceptsSchema: target.acceptsSchema }
		});
		if (!verdict.allowed) {
			throw refused(verdict.reason, 'rollback_refused', { offers: verdict.offers });
		}
	}
	const bytes = await services.blobs.get(row.bundleKey);
	if (bytes === null) {
		throw refused('The files for this edit are no longer stored.', 'bundle_missing');
	}
	const bundle = await parseEditBundle(bytes).catch(() => null);
	if (bundle === null) {
		throw refused('The stored files for this edit are damaged.', 'bundle_invalid');
	}
	const note = `Rolled back to: ${row.note ?? 'an earlier edit'}`.slice(0, 200);
	const { stored, created } = await start(
		services,
		db,
		site,
		input,
		baseParams(services, site, input, bundle.package, row.bundleKey, note)
	);
	if (created) {
		await services.audit(input.orgId, {
			actor: input.actor,
			action: 'site.modify.rollback',
			target: site.id,
			detail: { operationId: input.operationId, revision: row.id, package: bundle.package }
		});
	}
	return stored;
}
