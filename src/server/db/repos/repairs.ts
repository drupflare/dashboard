import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	REPAIR_COLUMNS,
	toRepairRecord,
	type RepairRecord,
	type RepairRow
} from '../../../../engine/src/repair/rows';

export type { RepairRecord };

// repairs shard by organisation, as operations do, so the engine's write and these reads agree
export async function getRepair(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<RepairRecord | null> {
	const row = await db.first<RepairRow>(
		organizationId,
		`SELECT ${REPAIR_COLUMNS} FROM repairs WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRepairRecord(row) : null;
}

// newest first; the cursor is the (created_at, id) of the last row of the previous page
export async function listRepairs(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	options: { after?: { createdAt: number; id: string }; count: number }
): Promise<RepairRecord[]> {
	const after = options.after;
	const keyset = after ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
	const cursor = after ? [after.createdAt, after.createdAt, after.id] : [];
	const { results } = await db.all<RepairRow>(
		organizationId,
		`SELECT ${REPAIR_COLUMNS} FROM repairs
		 WHERE organization_id = ? AND site_id = ? ${keyset}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, ...cursor, options.count]
	);
	return results.map(toRepairRecord);
}

// the attempts of one repair on one site, newest first, for the attempt bound and cool-down
export async function repairHistory(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	repairId: string,
	count: number
): Promise<RepairRecord[]> {
	const { results } = await db.all<RepairRow>(
		organizationId,
		`SELECT ${REPAIR_COLUMNS} FROM repairs
		 WHERE organization_id = ? AND site_id = ? AND repair_id = ?
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, repairId, count]
	);
	return results.map(toRepairRecord);
}

export class RepairScanFailedError extends Error {
	readonly code = 'REPAIR_SCAN_FAILED';

	constructor() {
		super('a shard failed while reading repairs');
		this.name = 'RepairScanFailedError';
	}
}

// every shard, for the fleet-wide hourly budget; a refused repair spent nothing
export async function repairsSince(
	db: CollegeDBClient,
	sinceMs: number
): Promise<{ orgId: string; atMs: number }[]> {
	const shards = await db.allAllShards<{ organization_id: string; created_at: number }>(
		`SELECT organization_id, created_at FROM repairs
		 WHERE created_at >= ? AND status <> 'refused'`,
		[sinceMs]
	);
	const spent: { orgId: string; atMs: number }[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new RepairScanFailedError();
		for (const row of shard.results) {
			spent.push({ orgId: row.organization_id, atMs: row.created_at });
		}
	}
	return spent;
}

export interface ActiveSiteRef {
	id: string;
	organizationId: string;
}

export async function listActiveSites(db: CollegeDBClient): Promise<ActiveSiteRef[]> {
	const shards = await db.allAllShards<{ id: string; organization_id: string }>(
		`SELECT id, organization_id FROM sites
		 WHERE state = 'active' AND ready_at IS NOT NULL AND primary_hostname IS NOT NULL
		 ORDER BY id`,
		[]
	);
	const sites: ActiveSiteRef[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new RepairScanFailedError();
		for (const row of shard.results) {
			sites.push({ id: row.id, organizationId: row.organization_id });
		}
	}
	return sites;
}
