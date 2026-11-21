import type { CollegeDBClient } from '@earth-app/collegedb';
import type { SupportGrantScope } from '../../../shared/support';
import { DIRECTORY_KEY } from '../collegedb';

export interface SupportGrantRow {
	id: string;
	organizationId: string;
	grantedBy: string;
	scope: SupportGrantScope;
	reason: string;
	createdAt: number;
	expiresAt: number;
	revokedAt: number | null;
}

export interface BreakGlassRow {
	id: string;
	organizationId: string;
	adminUserId: string;
	reason: string;
	startedAt: number;
	expiresAt: number;
	ownersNotified: number;
}

interface GrantDb {
	id: string;
	organization_id: string;
	granted_by: string;
	scope: SupportGrantScope;
	reason: string;
	created_at: number;
	expires_at: number;
	revoked_at: number | null;
}

interface GlassDb {
	id: string;
	organization_id: string;
	admin_user_id: string;
	reason: string;
	started_at: number;
	expires_at: number;
	owners_notified: number;
}

const GRANT_COLUMNS =
	'id, organization_id, granted_by, scope, reason, created_at, expires_at, revoked_at';
const GLASS_COLUMNS =
	'id, organization_id, admin_user_id, reason, started_at, expires_at, owners_notified';

const toGrant = (row: GrantDb): SupportGrantRow => ({
	id: row.id,
	organizationId: row.organization_id,
	grantedBy: row.granted_by,
	scope: row.scope,
	reason: row.reason,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	revokedAt: row.revoked_at
});

const toGlass = (row: GlassDb): BreakGlassRow => ({
	id: row.id,
	organizationId: row.organization_id,
	adminUserId: row.admin_user_id,
	reason: row.reason,
	startedAt: row.started_at,
	expiresAt: row.expires_at,
	ownersNotified: row.owners_notified
});

export async function insertSupportGrant(
	db: CollegeDBClient,
	input: Omit<SupportGrantRow, 'revokedAt'>
): Promise<SupportGrantRow> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO support_grants (${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
		[
			input.id,
			input.organizationId,
			input.grantedBy,
			input.scope,
			input.reason,
			input.createdAt,
			input.expiresAt
		]
	);
	return { ...input, revokedAt: null };
}

export async function getSupportGrant(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<SupportGrantRow | null> {
	const row = await db.first<GrantDb>(
		DIRECTORY_KEY,
		`SELECT ${GRANT_COLUMNS} FROM support_grants WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toGrant(row) : null;
}

export async function listSupportGrants(
	db: CollegeDBClient,
	organizationId: string,
	limit = 100
): Promise<SupportGrantRow[]> {
	const { results } = await db.all<GrantDb>(
		DIRECTORY_KEY,
		`SELECT ${GRANT_COLUMNS} FROM support_grants WHERE organization_id = ?
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, limit]
	);
	return results.map(toGrant);
}

// grants that still let support in: not revoked and not past their end
export async function listLiveSupportGrants(
	db: CollegeDBClient,
	now: number,
	limit = 200
): Promise<SupportGrantRow[]> {
	const { results } = await db.all<GrantDb>(
		DIRECTORY_KEY,
		`SELECT ${GRANT_COLUMNS} FROM support_grants WHERE revoked_at IS NULL AND expires_at > ?
		 ORDER BY expires_at ASC, id ASC LIMIT ?`,
		[now, limit]
	);
	return results.map(toGrant);
}

// the grant with the latest end that was not revoked, which may already have run out
export async function currentSupportGrant(
	db: CollegeDBClient,
	organizationId: string
): Promise<SupportGrantRow | null> {
	const row = await db.first<GrantDb>(
		DIRECTORY_KEY,
		`SELECT ${GRANT_COLUMNS} FROM support_grants WHERE organization_id = ? AND revoked_at IS NULL
		 ORDER BY expires_at DESC, id DESC LIMIT 1`,
		[organizationId]
	);
	return row ? toGrant(row) : null;
}

// true when this call revoked it; false when it was already revoked
export async function revokeSupportGrant(
	db: CollegeDBClient,
	input: { organizationId: string; id: string; by: string; now: number }
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		`UPDATE support_grants SET revoked_at = ?, revoked_by = ?
		 WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
		[input.now, input.by, input.organizationId, input.id]
	);
	return (result.meta.changes ?? 0) > 0;
}

export async function insertBreakGlass(
	db: CollegeDBClient,
	input: BreakGlassRow
): Promise<BreakGlassRow> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO break_glass_events (${GLASS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			input.id,
			input.organizationId,
			input.adminUserId,
			input.reason,
			input.startedAt,
			input.expiresAt,
			input.ownersNotified
		]
	);
	return input;
}

export async function setBreakGlassNotified(
	db: CollegeDBClient,
	id: string,
	count: number
): Promise<void> {
	await db.run(DIRECTORY_KEY, 'UPDATE break_glass_events SET owners_notified = ? WHERE id = ?', [
		count,
		id
	]);
}

export async function liveBreakGlass(
	db: CollegeDBClient,
	adminUserId: string,
	organizationId: string,
	now: number
): Promise<BreakGlassRow | null> {
	const row = await db.first<GlassDb>(
		DIRECTORY_KEY,
		`SELECT ${GLASS_COLUMNS} FROM break_glass_events
		 WHERE admin_user_id = ? AND organization_id = ? AND expires_at > ?
		 ORDER BY started_at DESC LIMIT 1`,
		[adminUserId, organizationId, now]
	);
	return row ? toGlass(row) : null;
}

export async function countBreakGlassSince(
	db: CollegeDBClient,
	adminUserId: string,
	since: number
): Promise<number> {
	const row = await db.first<{ n: number }>(
		DIRECTORY_KEY,
		'SELECT COUNT(*) AS n FROM break_glass_events WHERE admin_user_id = ? AND started_at > ?',
		[adminUserId, since]
	);
	return row?.n ?? 0;
}

export async function listBreakGlass(db: CollegeDBClient, limit = 100): Promise<BreakGlassRow[]> {
	const { results } = await db.all<GlassDb>(
		DIRECTORY_KEY,
		`SELECT ${GLASS_COLUMNS} FROM break_glass_events ORDER BY started_at DESC, id DESC LIMIT ?`,
		[limit]
	);
	return results.map(toGlass);
}
