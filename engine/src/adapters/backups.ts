import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { BACKUP_COLUMNS, toBackupRecord, type BackupRecord, type BackupRow } from '../backup-parts';
import type { SiteRowState } from '../operations/store';
import type { BackupBlobs, BackupLedger, BackupSite } from '../ports';

const isUnique = (error: unknown) =>
	error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export class D1BackupLedger implements BackupLedger {
	constructor(private readonly db: D1Database) {}

	async site(siteId: string): Promise<BackupSite | null> {
		const row = await this.db
			.prepare(
				'SELECT id, organization_id, account_id, plane, state, primary_hostname FROM sites WHERE id = ?'
			)
			.bind(siteId)
			.first<{
				id: string;
				organization_id: string;
				account_id: string | null;
				plane: BackupSite['plane'];
				state: SiteRowState;
				primary_hostname: string | null;
			}>();
		if (row === null) return null;
		return {
			id: row.id,
			organizationId: row.organization_id,
			accountId: row.account_id,
			plane: row.plane,
			state: row.state,
			primaryHostname: row.primary_hostname
		};
	}

	// one row per operation: a replay that finds its own row returns it
	async record(row: BackupRecord): Promise<BackupRecord> {
		try {
			await this.db
				.prepare(
					`INSERT INTO backups (${BACKUP_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
				)
				.bind(
					row.id,
					row.siteId,
					row.organizationId,
					row.operationId,
					row.bytes,
					row.sha256,
					row.parts,
					row.restorable ? 1 : 0,
					row.verified ? 1 : 0,
					row.label,
					row.createdAt
				)
				.run();
		} catch (error) {
			if (!isUnique(error)) throw error;
			const kept = await this.db
				.prepare(`SELECT ${BACKUP_COLUMNS} FROM backups WHERE operation_id = ?`)
				.bind(row.operationId)
				.first<BackupRow>();
			if (kept === null) throw error;
			return toBackupRecord(kept);
		}
		return row;
	}

	async get(organizationId: string, id: string): Promise<BackupRecord | null> {
		const row = await this.db
			.prepare(
				`SELECT ${BACKUP_COLUMNS} FROM backups
				WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`
			)
			.bind(organizationId, id)
			.first<BackupRow>();
		return row === null ? null : toBackupRecord(row);
	}
}

export function r2BackupBlobs(bucket: R2Bucket): BackupBlobs {
	return {
		async put(key, bytes) {
			await bucket.put(key, bytes);
		},
		async get(key) {
			const object = await bucket.get(key);
			return object === null ? null : new Uint8Array(await object.arrayBuffer());
		},
		async deletePrefix(prefix) {
			let removed = 0;
			let cursor: string | undefined;
			do {
				const page = await bucket.list({ prefix, cursor });
				if (page.objects.length > 0) {
					await bucket.delete(page.objects.map((object) => object.key));
					removed += page.objects.length;
				}
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor !== undefined);
			return removed;
		}
	};
}
