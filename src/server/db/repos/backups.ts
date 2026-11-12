import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	BACKUP_COLUMNS,
	toBackupRecord,
	type BackupRecord,
	type BackupRow
} from '../../../../engine/src/backup-parts';
import { BatchFailedError } from './accounts';
import { getOperationByKey, type NewOperation, type StoredOperation } from './operations';

// backups shard by organisation, as operations do, so the engine's write and these reads agree
export async function getBackup(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string
): Promise<BackupRecord | null> {
	const row = await db.first<BackupRow>(
		organizationId,
		`SELECT ${BACKUP_COLUMNS} FROM backups
		 WHERE organization_id = ? AND site_id = ? AND id = ? AND deleted_at IS NULL`,
		[organizationId, siteId, id]
	);
	return row ? toBackupRecord(row) : null;
}

// newest first; the cursor is the (created_at, id) of the last row of the previous page
export async function listBackups(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	options: { after?: { createdAt: number; id: string }; count: number }
): Promise<BackupRecord[]> {
	const after = options.after;
	const keyset = after ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
	const cursor = after ? [after.createdAt, after.createdAt, after.id] : [];
	const { results } = await db.all<BackupRow>(
		organizationId,
		`SELECT ${BACKUP_COLUMNS} FROM backups
		 WHERE organization_id = ? AND site_id = ? AND deleted_at IS NULL ${keyset}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, ...cursor, options.count]
	);
	return results.map(toBackupRecord);
}

// the operation and its steps in one batch on the organisation's shard; a repeated key returns the
// first operation and writes nothing
export async function createOperationRecord(
	db: CollegeDBClient,
	operation: NewOperation
): Promise<{ operation: StoredOperation; created: boolean }> {
	const existing = await getOperationByKey(
		db,
		operation.organizationId,
		operation.idempotencyKey
	);
	if (existing) return { operation: existing, created: false };
	const org = operation.organizationId;
	const groups = await db.batch([
		{
			key: org,
			sql: `INSERT OR IGNORE INTO operations (id, organization_id, account_id, site_id, type,
				status, idempotency_key, target_ids, preconditions, plan_digest, fencing_epoch,
				blast_radius, rollback_point, cursor, verification, final_observation, budget,
				retry_of, inputs, created_at, updated_at, version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0)`,
			bindings: [
				operation.id,
				org,
				operation.accountId,
				operation.siteId,
				operation.type,
				operation.status,
				operation.idempotencyKey,
				JSON.stringify(operation.targetIds),
				JSON.stringify(operation.preconditions),
				operation.planDigest,
				JSON.stringify(operation.blastRadius),
				operation.rollbackPoint,
				operation.verification,
				JSON.stringify(operation.budget),
				operation.retryOf ?? null,
				operation.inputs === undefined ? null : JSON.stringify(operation.inputs),
				operation.now,
				operation.now
			]
		},
		...operation.steps.map((step, position) => ({
			key: org,
			sql: `INSERT INTO operation_steps (operation_id, id, position, name, state, attempt,
				started_at, finished_at, error)
				SELECT ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL
				WHERE (SELECT id FROM operations WHERE organization_id = ? AND idempotency_key = ?) = ?`,
			bindings: [
				operation.id,
				step.id,
				position,
				step.name,
				org,
				operation.idempotencyKey,
				operation.id
			]
		}))
	]);
	for (const group of groups) {
		if (group.error !== undefined) throw new BatchFailedError(group.shard, group.error);
	}
	const stored = await getOperationByKey(db, org, operation.idempotencyKey);
	if (!stored) throw new BatchFailedError('unknown', 'the operation is missing after the batch');
	return { operation: stored, created: stored.operation.id === operation.id };
}
