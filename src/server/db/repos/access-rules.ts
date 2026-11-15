import type { CollegeDBClient } from '@earth-app/collegedb';
import type { AccessPresetId } from '../../../shared/access-presets';
import { wasChanged } from '../collegedb';

export interface AccessRuleRecord {
	id: string;
	organizationId: string;
	siteId: string;
	environment: string;
	preset: AccessPresetId;
	config: Record<string, unknown>;
	createdBy: string;
	createdAt: number;
	revokedAt: number | null;
}

interface AccessRuleRow {
	id: string;
	organization_id: string;
	site_id: string;
	environment: string;
	preset: AccessPresetId;
	config: string;
	created_by: string;
	created_at: number;
	revoked_at: number | null;
}

const COLUMNS = `id, organization_id, site_id, environment, preset, config, created_by,
	created_at, revoked_at`;

function toRecord(row: AccessRuleRow): AccessRuleRecord {
	return {
		id: row.id,
		organizationId: row.organization_id,
		siteId: row.site_id,
		environment: row.environment,
		preset: row.preset,
		config: JSON.parse(row.config) as Record<string, unknown>,
		createdBy: row.created_by,
		createdAt: row.created_at,
		revokedAt: row.revoked_at
	};
}

export async function createAccessRule(
	db: CollegeDBClient,
	rule: Omit<AccessRuleRecord, 'revokedAt'>
): Promise<AccessRuleRecord> {
	await db.run(
		rule.organizationId,
		`INSERT INTO site_access_rules (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		[
			rule.id,
			rule.organizationId,
			rule.siteId,
			rule.environment,
			rule.preset,
			JSON.stringify(rule.config),
			rule.createdBy,
			rule.createdAt
		]
	);
	return { ...rule, revokedAt: null };
}

// active rules only; a revoked row stays for the record and never reaches the hash
export async function listAccessRules(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<AccessRuleRecord[]> {
	const { results } = await db.all<AccessRuleRow>(
		organizationId,
		`SELECT ${COLUMNS} FROM site_access_rules
		 WHERE organization_id = ? AND site_id = ? AND revoked_at IS NULL
		 ORDER BY created_at ASC, id ASC`,
		[organizationId, siteId]
	);
	return results.map(toRecord);
}

// the newest rule change and the start of the newest succeeded access sync, so a caller can tell
// whether the site has caught up; a site that never had a rule has nothing to catch up on
export async function accessSyncState(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<{ changedAt: number; syncedAt: number | null }> {
	const changes = await db.first<{ created: number | null; revoked: number | null }>(
		organizationId,
		`SELECT MAX(created_at) AS created, MAX(revoked_at) AS revoked FROM site_access_rules
		 WHERE organization_id = ? AND site_id = ?`,
		[organizationId, siteId]
	);
	const sync = await db.first<{ created_at: number | null }>(
		organizationId,
		`SELECT MAX(created_at) AS created_at FROM operations
		 WHERE organization_id = ? AND site_id = ? AND type = 'access.sync' AND status = 'succeeded'`,
		[organizationId, siteId]
	);
	return {
		changedAt: Math.max(changes?.created ?? 0, changes?.revoked ?? 0),
		syncedAt: sync?.created_at ?? null
	};
}

export async function revokeAccessRule(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE site_access_rules SET revoked_at = ?
		 WHERE organization_id = ? AND site_id = ? AND id = ? AND revoked_at IS NULL`,
		[now, organizationId, siteId, id]
	);
	return wasChanged(result);
}
