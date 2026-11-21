import type { CollegeDBClient } from '@earth-app/collegedb';
import type {
	ReviewDecision,
	ReviewInterval,
	ReviewItemKind,
	ReviewState
} from '../../../shared/access-reviews';
import { wasChanged } from '../collegedb';

// #region service accounts

export interface ServiceAccountRow {
	id: string;
	organizationId: string;
	departmentId: string | null;
	name: string;
	ownerUserId: string;
	expiresAt: number;
	disabledAt: number | null;
	createdAt: number;
}

interface AccountSql {
	id: string;
	organization_id: string;
	department_id: string | null;
	name: string;
	owner_user_id: string;
	expires_at: number;
	disabled_at: number | null;
	created_at: number;
}

const ACCOUNT_COLUMNS =
	'id, organization_id, department_id, name, owner_user_id, expires_at, disabled_at, created_at';

const toAccount = (row: AccountSql): ServiceAccountRow => ({
	id: row.id,
	organizationId: row.organization_id,
	departmentId: row.department_id,
	name: row.name,
	ownerUserId: row.owner_user_id,
	expiresAt: row.expires_at,
	disabledAt: row.disabled_at,
	createdAt: row.created_at
});

export async function insertServiceAccount(
	db: CollegeDBClient,
	row: ServiceAccountRow
): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO service_accounts (${ACCOUNT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.organizationId,
			row.departmentId,
			row.name,
			row.ownerUserId,
			row.expiresAt,
			row.disabledAt,
			row.createdAt
		]
	);
}

export async function getServiceAccount(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<ServiceAccountRow | null> {
	const row = await db.first<AccountSql>(
		orgId,
		`SELECT ${ACCOUNT_COLUMNS} FROM service_accounts WHERE organization_id = ? AND id = ?`,
		[orgId, id]
	);
	return row ? toAccount(row) : null;
}

export async function listServiceAccounts(
	db: CollegeDBClient,
	orgId: string
): Promise<ServiceAccountRow[]> {
	const { results } = await db.all<AccountSql>(
		orgId,
		`SELECT ${ACCOUNT_COLUMNS} FROM service_accounts WHERE organization_id = ?
		 ORDER BY created_at, id`,
		[orgId]
	);
	return results.map(toAccount);
}

export async function setServiceAccountDisabled(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	at: number
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE service_accounts SET disabled_at = ?
		 WHERE organization_id = ? AND id = ? AND disabled_at IS NULL`,
		[at, orgId, id]
	);
	return wasChanged(result);
}

export async function setServiceAccountOwner(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	ownerUserId: string
): Promise<boolean> {
	const result = await db.run(
		orgId,
		'UPDATE service_accounts SET owner_user_id = ? WHERE organization_id = ? AND id = ?',
		[ownerUserId, orgId, id]
	);
	return wasChanged(result);
}

export async function linkAccountKey(
	db: CollegeDBClient,
	orgId: string,
	accountId: string,
	keyId: string
): Promise<void> {
	await db.run(
		orgId,
		'INSERT INTO service_account_keys (key_id, organization_id, service_account_id) VALUES (?, ?, ?)',
		[keyId, orgId, accountId]
	);
}

export interface KeyRowOut {
	id: string;
	name: string;
	scopes: string[];
	createdBy: string;
	expiresAt: number | null;
	revokedAt: number | null;
	createdAt: number;
	lastUsedAt: number | null;
}

interface KeySql {
	id: string;
	name: string;
	scopes: string;
	created_by: string;
	expires_at: number | null;
	revoked_at: number | null;
	created_at: number;
	last_used_at: number | null;
}

const toKey = (row: KeySql): KeyRowOut => ({
	id: row.id,
	name: row.name,
	scopes: JSON.parse(row.scopes) as string[],
	createdBy: row.created_by,
	expiresAt: row.expires_at,
	revokedAt: row.revoked_at,
	createdAt: row.created_at,
	lastUsedAt: row.last_used_at
});

const KEY_COLUMNS =
	'k.id, k.name, k.scopes, k.created_by, k.expires_at, k.revoked_at, k.created_at, k.last_used_at';

// every key of one account, newest first
export async function listAccountKeys(
	db: CollegeDBClient,
	orgId: string,
	accountId: string
): Promise<KeyRowOut[]> {
	const { results } = await db.all<KeySql>(
		orgId,
		`SELECT ${KEY_COLUMNS} FROM api_keys k
		 JOIN service_account_keys l ON l.key_id = k.id AND l.organization_id = k.organization_id
		 WHERE k.organization_id = ? AND l.service_account_id = ?
		 ORDER BY k.created_at DESC, k.id DESC`,
		[orgId, accountId]
	);
	return results.map(toKey);
}

// keyId to account id for the whole organisation
export async function accountKeyLinks(
	db: CollegeDBClient,
	orgId: string
): Promise<Map<string, string>> {
	const { results } = await db.all<{ key_id: string; service_account_id: string }>(
		orgId,
		'SELECT key_id, service_account_id FROM service_account_keys WHERE organization_id = ?',
		[orgId]
	);
	return new Map(results.map((row) => [row.key_id, row.service_account_id]));
}

// keys that still work, for a snapshot or a stale report
export async function listLiveKeys(
	db: CollegeDBClient,
	orgId: string,
	now: number
): Promise<KeyRowOut[]> {
	const { results } = await db.all<KeySql>(
		orgId,
		`SELECT ${KEY_COLUMNS} FROM api_keys k
		 WHERE k.organization_id = ? AND k.revoked_at IS NULL
		 AND (k.expires_at IS NULL OR k.expires_at > ?) ORDER BY k.created_at, k.id`,
		[orgId, now]
	);
	return results.map(toKey);
}

export async function moveKeysToOwner(
	db: CollegeDBClient,
	orgId: string,
	accountId: string,
	ownerUserId: string
): Promise<void> {
	await db.run(
		orgId,
		`UPDATE api_keys SET created_by = ? WHERE organization_id = ?
		 AND id IN (SELECT key_id FROM service_account_keys
		            WHERE organization_id = ? AND service_account_id = ?)`,
		[ownerUserId, orgId, orgId, accountId]
	);
}

// #endregion

// #region organisation lists

export interface SiteGrantListing {
	id: string;
	siteId: string;
	siteName: string;
	userId: string;
	role: string;
	createdAt: number;
	expiresAt: number | null;
	// the department the site sits in now, null when it sits at organization level
	departmentId: string | null;
}

interface SiteGrantSql {
	id: string;
	site_id: string;
	site_name: string | null;
	site_department_id: string | null;
	user_id: string;
	role: string;
	created_at: number;
	expires_at: number | null;
}

// live grants (not revoked, not expired); a department list keeps only sites placed in it
export async function listLiveSiteGrants(
	db: CollegeDBClient,
	orgId: string,
	now: number,
	departmentIds?: readonly string[]
): Promise<SiteGrantListing[]> {
	const marks = departmentIds?.map(() => '?').join(', ');
	const filter = departmentIds === undefined ? '' : `AND s.department_id IN (${marks})`;
	const { results } = await db.all<SiteGrantSql>(
		orgId,
		`SELECT g.id, g.site_id, s.name AS site_name, s.department_id AS site_department_id, g.user_id,
		 g.role, g.created_at, g.expires_at
		 FROM site_grants g LEFT JOIN sites s ON s.id = g.site_id AND s.organization_id = g.organization_id
		 WHERE g.organization_id = ? AND g.revoked_at IS NULL
		 AND (g.expires_at IS NULL OR g.expires_at > ?) ${filter} ORDER BY g.created_at, g.id`,
		[orgId, now, ...(departmentIds ?? [])]
	);
	return results.map((row) => ({
		id: row.id,
		siteId: row.site_id,
		siteName: row.site_name ?? row.site_id,
		userId: row.user_id,
		role: row.role,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		departmentId: row.site_department_id
	}));
}

export interface DepartmentRoleListing {
	departmentId: string;
	departmentName: string;
	userId: string;
	role: string;
	grantedAt: number;
}

export async function listDepartmentRoles(
	db: CollegeDBClient,
	orgId: string,
	options: { departmentIds?: readonly string[]; userId?: string } = {}
): Promise<DepartmentRoleListing[]> {
	const where: string[] = ['m.organization_id = ?'];
	const binds: unknown[] = [orgId];
	if (options.departmentIds !== undefined) {
		where.push(`m.department_id IN (${options.departmentIds.map(() => '?').join(', ')})`);
		binds.push(...options.departmentIds);
	}
	if (options.userId !== undefined) {
		where.push('m.user_id = ?');
		binds.push(options.userId);
	}
	const { results } = await db.all<{
		department_id: string;
		name: string | null;
		user_id: string;
		role: string;
		granted_at: number;
	}>(
		orgId,
		`SELECT m.department_id, d.name, m.user_id, m.role, m.granted_at FROM department_members m
		 LEFT JOIN departments d ON d.id = m.department_id AND d.organization_id = m.organization_id
		 WHERE ${where.join(' AND ')} ORDER BY m.granted_at, m.department_id, m.user_id`,
		binds
	);
	return results.map((row) => ({
		departmentId: row.department_id,
		departmentName: row.name ?? row.department_id,
		userId: row.user_id,
		role: row.role,
		grantedAt: row.granted_at
	}));
}

export interface DelegationListing {
	id: string;
	agencyOrganizationId: string;
	role: string;
	siteId: string | null;
	state: string;
	createdBy: string;
	createdAt: number;
}

// pending and active rows where this organisation is the client; revoked rows are history
export async function listOpenDelegations(
	db: CollegeDBClient,
	orgId: string,
	createdBy?: string
): Promise<DelegationListing[]> {
	const { results } = await db.all<{
		id: string;
		agency_organization_id: string;
		role: string;
		site_id: string | null;
		state: string;
		created_by: string;
		created_at: number;
	}>(
		orgId,
		`SELECT id, agency_organization_id, role, site_id, state, created_by, created_at
		 FROM delegations WHERE organization_id = ? AND state IN ('pending', 'active')
		 ${createdBy === undefined ? '' : 'AND created_by = ?'} ORDER BY created_at, id`,
		createdBy === undefined ? [orgId] : [orgId, createdBy]
	);
	return results.map((row) => ({
		id: row.id,
		agencyOrganizationId: row.agency_organization_id,
		role: row.role,
		siteId: row.site_id,
		state: row.state,
		createdBy: row.created_by,
		createdAt: row.created_at
	}));
}

export async function listGrantsOf(
	db: CollegeDBClient,
	orgId: string,
	userId: string,
	now: number
): Promise<SiteGrantListing[]> {
	const all = await listLiveSiteGrants(db, orgId, now);
	return all.filter((grant) => grant.userId === userId);
}

export interface SentInvite {
	id: string;
	email: string;
}

export async function listInvitesSentBy(
	db: CollegeDBClient,
	orgId: string,
	userId: string
): Promise<SentInvite[]> {
	const { results } = await db.all<SentInvite>(
		orgId,
		`SELECT id, email FROM invites WHERE organization_id = ? AND invited_by = ?
		 AND state = 'pending' ORDER BY created_at, id`,
		[orgId, userId]
	);
	return results;
}

export async function revokeSiteGrantsOf(
	db: CollegeDBClient,
	orgId: string,
	userId: string,
	at: number
): Promise<void> {
	await db.run(
		orgId,
		`UPDATE site_grants SET revoked_at = ?
		 WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL`,
		[at, orgId, userId]
	);
}

export async function listSiteIdsInDepartments(
	db: CollegeDBClient,
	orgId: string,
	departmentIds: readonly string[]
): Promise<string[]> {
	if (departmentIds.length === 0) return [];
	const { results } = await db.all<{ id: string }>(
		orgId,
		`SELECT id FROM sites WHERE organization_id = ?
		 AND department_id IN (${departmentIds.map(() => '?').join(', ')})`,
		[orgId, ...departmentIds]
	);
	return results.map((row) => row.id);
}

// #endregion

// #region reviews

export interface ReviewRow {
	id: string;
	organizationId: string;
	scope: string;
	state: ReviewState;
	dueAt: number;
	createdBy: string;
	createdAt: number;
	closedAt: number | null;
}

interface ReviewSql {
	id: string;
	organization_id: string;
	scope: string;
	state: ReviewState;
	due_at: number;
	created_by: string;
	created_at: number;
	closed_at: number | null;
}

const REVIEW_COLUMNS =
	'id, organization_id, scope, state, due_at, created_by, created_at, closed_at';

const toReview = (row: ReviewSql): ReviewRow => ({
	id: row.id,
	organizationId: row.organization_id,
	scope: row.scope,
	state: row.state,
	dueAt: row.due_at,
	createdBy: row.created_by,
	createdAt: row.created_at,
	closedAt: row.closed_at
});

export interface ItemRow {
	organizationId: string;
	reviewId: string;
	kind: ReviewItemKind;
	subjectRef: string;
	subjectUserId: string | null;
	label: string;
	detail: string;
	decision: ReviewDecision;
	decidedBy: string | null;
	decidedAt: number | null;
	reason: string | null;
	appliedAt: number | null;
	applyError: string | null;
	// the department the subject belonged to when the review opened; null is organization level
	departmentId: string | null;
}

interface ItemSql {
	organization_id: string;
	review_id: string;
	kind: ReviewItemKind;
	subject_ref: string;
	subject_user_id: string | null;
	label: string;
	detail: string;
	decision: ReviewDecision;
	decided_by: string | null;
	decided_at: number | null;
	reason: string | null;
	applied_at: number | null;
	apply_error: string | null;
	department_id: string | null;
}

const ITEM_COLUMNS = `organization_id, review_id, kind, subject_ref, subject_user_id, label, detail,
	decision, decided_by, decided_at, reason, applied_at, apply_error, department_id`;

const toItem = (row: ItemSql): ItemRow => ({
	organizationId: row.organization_id,
	reviewId: row.review_id,
	kind: row.kind,
	subjectRef: row.subject_ref,
	subjectUserId: row.subject_user_id,
	label: row.label,
	detail: row.detail,
	decision: row.decision,
	decidedBy: row.decided_by,
	decidedAt: row.decided_at,
	reason: row.reason,
	appliedAt: row.applied_at,
	applyError: row.apply_error,
	departmentId: row.department_id
});

export async function insertReview(db: CollegeDBClient, row: ReviewRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO access_reviews (${REVIEW_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.organizationId,
			row.scope,
			row.state,
			row.dueAt,
			row.createdBy,
			row.createdAt,
			row.closedAt
		]
	);
}

export async function insertReviewItem(db: CollegeDBClient, row: ItemRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO access_review_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.organizationId,
			row.reviewId,
			row.kind,
			row.subjectRef,
			row.subjectUserId,
			row.label,
			row.detail,
			row.decision,
			row.decidedBy,
			row.decidedAt,
			row.reason,
			row.appliedAt,
			row.applyError,
			row.departmentId
		]
	);
}

export async function getReview(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<ReviewRow | null> {
	const row = await db.first<ReviewSql>(
		orgId,
		`SELECT ${REVIEW_COLUMNS} FROM access_reviews WHERE organization_id = ? AND id = ?`,
		[orgId, id]
	);
	return row ? toReview(row) : null;
}

export async function listReviewRows(db: CollegeDBClient, orgId: string): Promise<ReviewRow[]> {
	const { results } = await db.all<ReviewSql>(
		orgId,
		`SELECT ${REVIEW_COLUMNS} FROM access_reviews WHERE organization_id = ?
		 ORDER BY created_at DESC, id DESC`,
		[orgId]
	);
	return results.map(toReview);
}

export async function listReviewItems(
	db: CollegeDBClient,
	orgId: string,
	reviewId: string
): Promise<ItemRow[]> {
	const { results } = await db.all<ItemSql>(
		orgId,
		`SELECT ${ITEM_COLUMNS} FROM access_review_items WHERE organization_id = ? AND review_id = ?
		 ORDER BY kind, label, subject_ref`,
		[orgId, reviewId]
	);
	return results.map(toItem);
}

export async function getReviewItem(
	db: CollegeDBClient,
	orgId: string,
	reviewId: string,
	kind: ReviewItemKind,
	subjectRef: string
): Promise<ItemRow | null> {
	const row = await db.first<ItemSql>(
		orgId,
		`SELECT ${ITEM_COLUMNS} FROM access_review_items
		 WHERE organization_id = ? AND review_id = ? AND kind = ? AND subject_ref = ?`,
		[orgId, reviewId, kind, subjectRef]
	);
	return row ? toItem(row) : null;
}

export async function decideReviewItem(
	db: CollegeDBClient,
	item: ItemRow,
	input: {
		decision: 'keep' | 'revoke';
		decidedBy: string;
		decidedAt: number;
		reason: string | null;
	}
): Promise<boolean> {
	const result = await db.run(
		item.organizationId,
		`UPDATE access_review_items SET decision = ?, decided_by = ?, decided_at = ?, reason = ?,
		 applied_at = NULL, apply_error = NULL
		 WHERE organization_id = ? AND review_id = ? AND kind = ? AND subject_ref = ?
		 AND applied_at IS NULL`,
		[
			input.decision,
			input.decidedBy,
			input.decidedAt,
			input.reason,
			item.organizationId,
			item.reviewId,
			item.kind,
			item.subjectRef
		]
	);
	return wasChanged(result);
}

export async function markItemApplied(
	db: CollegeDBClient,
	item: ItemRow,
	result: { appliedAt: number | null; error: string | null }
): Promise<void> {
	await db.run(
		item.organizationId,
		`UPDATE access_review_items SET applied_at = ?, apply_error = ?
		 WHERE organization_id = ? AND review_id = ? AND kind = ? AND subject_ref = ?`,
		[
			result.appliedAt,
			result.error,
			item.organizationId,
			item.reviewId,
			item.kind,
			item.subjectRef
		]
	);
}

export async function closeReviewRow(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	at: number
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE access_reviews SET state = 'closed', closed_at = ?
		 WHERE organization_id = ? AND id = ? AND state = 'open'`,
		[at, orgId, id]
	);
	return wasChanged(result);
}

export async function pendingItemsAbout(
	db: CollegeDBClient,
	orgId: string,
	userId: string
): Promise<ItemRow[]> {
	const { results } = await db.all<ItemSql>(
		orgId,
		`SELECT ${ITEM_COLUMNS} FROM access_review_items i
		 WHERE i.organization_id = ? AND i.subject_user_id = ? AND i.decision = 'pending'
		 AND i.review_id IN (SELECT id FROM access_reviews WHERE organization_id = ? AND state = 'open')`,
		[orgId, userId, orgId]
	);
	return results.map(toItem);
}

export async function setItemSubject(
	db: CollegeDBClient,
	item: ItemRow,
	userId: string
): Promise<void> {
	await db.run(
		item.organizationId,
		`UPDATE access_review_items SET subject_user_id = ?
		 WHERE organization_id = ? AND review_id = ? AND kind = ? AND subject_ref = ?`,
		[userId, item.organizationId, item.reviewId, item.kind, item.subjectRef]
	);
}

// #endregion

// #region schedule

export interface ScheduleRow {
	organizationId: string;
	interval: ReviewInterval;
	lastOpenedAt: number | null;
}

export async function getSchedule(db: CollegeDBClient, orgId: string): Promise<ScheduleRow | null> {
	const row = await db.first<{
		organization_id: string;
		interval: ReviewInterval;
		last_opened_at: number | null;
	}>(
		orgId,
		'SELECT organization_id, interval, last_opened_at FROM access_review_schedules WHERE organization_id = ?',
		[orgId]
	);
	return row
		? {
				organizationId: row.organization_id,
				interval: row.interval,
				lastOpenedAt: row.last_opened_at
			}
		: null;
}

export async function putSchedule(
	db: CollegeDBClient,
	orgId: string,
	input: { interval: ReviewInterval; setBy: string; at: number }
): Promise<void> {
	await db.run(
		orgId,
		`INSERT INTO access_review_schedules (organization_id, interval, last_opened_at, set_by, set_at)
		 VALUES (?, ?, NULL, ?, ?)
		 ON CONFLICT (organization_id) DO UPDATE SET interval = excluded.interval,
		 set_by = excluded.set_by, set_at = excluded.set_at`,
		[orgId, input.interval, input.setBy, input.at]
	);
}

export async function touchSchedule(db: CollegeDBClient, orgId: string, at: number): Promise<void> {
	await db.run(
		orgId,
		'UPDATE access_review_schedules SET last_opened_at = ? WHERE organization_id = ?',
		[at, orgId]
	);
}

export async function listActiveSchedules(db: CollegeDBClient): Promise<ScheduleRow[]> {
	const shards = await db.allAllShards<{
		organization_id: string;
		interval: ReviewInterval;
		last_opened_at: number | null;
		set_at: number;
	}>(
		`SELECT organization_id, interval, last_opened_at, set_at FROM access_review_schedules
		 WHERE interval <> 'off' ORDER BY organization_id`
	);
	const rows: ScheduleRow[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new Error('a shard did not answer');
		for (const row of shard.results) {
			rows.push({
				organizationId: row.organization_id,
				interval: row.interval,
				lastOpenedAt: row.last_opened_at ?? row.set_at
			});
		}
	}
	return rows;
}

// #endregion
