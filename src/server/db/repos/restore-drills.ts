import type { CollegeDBClient } from '@earth-app/collegedb';

export interface DrillCandidate {
	siteId: string;
	organizationId: string;
	backupId: string;
	bytes: number;
}

export class DrillScanFailedError extends Error {
	readonly code = 'DRILL_SCAN_FAILED';

	constructor() {
		super('a shard failed while looking for sites due a restore drill');
		this.name = 'DrillScanFailedError';
	}
}

// an active site whose newest restorable backup has had no test restore since `sinceMs`; the
// newest backup is the one that matters, since it is the one a person would restore
export async function listDrillCandidates(
	db: CollegeDBClient,
	sinceMs: number,
	limit = 50
): Promise<DrillCandidate[]> {
	const shards = await db.allAllShards<{
		site_id: string;
		organization_id: string;
		backup_id: string;
		bytes: number;
		backup_at: number;
	}>(
		`SELECT s.id AS site_id, s.organization_id AS organization_id, b.id AS backup_id,
		        b.bytes AS bytes, b.created_at AS backup_at
		 FROM sites s
		 JOIN backups b ON b.id = (
		   SELECT id FROM backups
		   WHERE site_id = s.id AND restorable = 1 AND deleted_at IS NULL
		   ORDER BY created_at DESC, id DESC LIMIT 1
		 )
		 WHERE s.state = 'active' AND s.ready_at IS NOT NULL
		   AND NOT EXISTS (
		     SELECT 1 FROM operations o
		     WHERE o.site_id = s.id AND o.type = 'backup.verify' AND o.created_at > ?
		   )
		 ORDER BY s.id LIMIT ?`,
		[sinceMs, limit]
	);
	const rows: DrillCandidate[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new DrillScanFailedError();
		for (const row of shard.results) {
			rows.push({
				siteId: row.site_id,
				organizationId: row.organization_id,
				backupId: row.backup_id,
				bytes: row.bytes
			});
		}
	}
	return rows.sort((a, b) => a.siteId.localeCompare(b.siteId)).slice(0, limit);
}

// the copy's first admin mail and the operation's owner go to the longest-standing owner
export async function getOrganizationOwnerId(
	db: CollegeDBClient,
	organizationId: string
): Promise<string | null> {
	const row = await db.first<{ user_id: string }>(
		organizationId,
		`SELECT user_id FROM members WHERE organization_id = ? AND role = 'owner'
		 ORDER BY created_at, id LIMIT 1`,
		[organizationId]
	);
	return row?.user_id ?? null;
}
