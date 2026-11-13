import type { CollegeDBClient } from '@earth-app/collegedb';
import { toPage } from '../../utils/pagination';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';
import type {
	DelegationRole,
	DelegationState,
	InviteState,
	OrganizationRole,
	SiteGrantRole
} from '../schema';

export interface Organization {
	id: string;
	name: string;
	personal: boolean;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface Member {
	id: string;
	organizationId: string;
	userId: string;
	role: OrganizationRole;
	createdAt: number;
	updatedAt: number;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
}

export interface Invite {
	id: string;
	organizationId: string;
	email: string;
	role: OrganizationRole;
	state: InviteState;
	invitedBy: string;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export interface ApiKey {
	id: string;
	organizationId: string;
	name: string;
	scopes: string[];
	createdBy: string;
	expiresAt: number | null;
	revokedAt: number | null;
	createdAt: number;
	lastUsedAt: number | null;
}

export interface Delegation {
	id: string;
	organizationId: string;
	agencyOrganizationId: string;
	role: DelegationRole;
	siteId: string | null;
	state: DelegationState;
	expiresAt: number | null;
	createdBy: string;
	acceptedBy: string | null;
	createdAt: number;
	updatedAt: number;
	revokedAt: number | null;
}

export interface SiteGrant {
	id: string;
	organizationId: string;
	siteId: string;
	userId: string;
	role: SiteGrantRole;
	createdBy: string;
	createdAt: number;
	revokedAt: number | null;
}

interface OrganizationRow {
	id: string;
	name: string;
	personal: number;
	created_by: string;
	created_at: number;
	updated_at: number;
}

interface MemberRow {
	id: string;
	organization_id: string;
	user_id: string;
	role: OrganizationRole;
	created_at: number;
	updated_at: number;
}

interface InviteRow {
	id: string;
	organization_id: string;
	email: string;
	role: OrganizationRole;
	state: InviteState;
	invited_by: string;
	expires_at: number;
	created_at: number;
	updated_at: number;
}

interface ApiKeyRow {
	id: string;
	organization_id: string;
	name: string;
	scopes: string;
	created_by: string;
	expires_at: number | null;
	revoked_at: number | null;
	created_at: number;
	last_used_at: number | null;
}

interface DelegationRow {
	id: string;
	organization_id: string;
	agency_organization_id: string;
	role: DelegationRole;
	site_id: string | null;
	state: DelegationState;
	expires_at: number | null;
	created_by: string;
	accepted_by: string | null;
	created_at: number;
	updated_at: number;
	revoked_at: number | null;
}

interface SiteGrantRow {
	id: string;
	organization_id: string;
	site_id: string;
	user_id: string;
	role: SiteGrantRole;
	created_by: string;
	created_at: number;
	revoked_at: number | null;
}

const ORGANIZATION_COLUMNS = 'id, name, personal, created_by, created_at, updated_at';
const MEMBER_COLUMNS = 'id, organization_id, user_id, role, created_at, updated_at';
const INVITE_COLUMNS =
	'id, organization_id, email, role, state, invited_by, expires_at, created_at, updated_at';
const API_KEY_COLUMNS =
	'id, organization_id, name, scopes, created_by, expires_at, revoked_at, created_at, last_used_at';
const DELEGATION_COLUMNS = `id, organization_id, agency_organization_id, role, site_id,
	state, expires_at, created_by, accepted_by, created_at, updated_at, revoked_at`;
const SITE_GRANT_COLUMNS =
	'id, organization_id, site_id, user_id, role, created_by, created_at, revoked_at';

function toOrganization(row: OrganizationRow): Organization {
	return {
		id: row.id,
		name: row.name,
		personal: row.personal === 1,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toMember(row: MemberRow): Member {
	return {
		id: row.id,
		organizationId: row.organization_id,
		userId: row.user_id,
		role: row.role,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toInvite(row: InviteRow): Invite {
	return {
		id: row.id,
		organizationId: row.organization_id,
		email: row.email,
		role: row.role,
		state: row.state,
		invitedBy: row.invited_by,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toApiKey(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		organizationId: row.organization_id,
		name: row.name,
		scopes: JSON.parse(row.scopes) as string[],
		createdBy: row.created_by,
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

function toDelegation(row: DelegationRow): Delegation {
	return {
		id: row.id,
		organizationId: row.organization_id,
		agencyOrganizationId: row.agency_organization_id,
		role: row.role,
		siteId: row.site_id,
		state: row.state,
		expiresAt: row.expires_at,
		createdBy: row.created_by,
		acceptedBy: row.accepted_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		revokedAt: row.revoked_at
	};
}

function toSiteGrant(row: SiteGrantRow): SiteGrant {
	return {
		id: row.id,
		organizationId: row.organization_id,
		siteId: row.site_id,
		userId: row.user_id,
		role: row.role,
		createdBy: row.created_by,
		createdAt: row.created_at,
		revokedAt: row.revoked_at
	};
}

export async function createOrganization(
	db: CollegeDBClient,
	input: { name: string; personal: boolean; createdBy: string }
): Promise<Organization> {
	const now = Date.now();
	const org: Organization = {
		id: crypto.randomUUID(),
		name: input.name,
		personal: input.personal,
		createdBy: input.createdBy,
		createdAt: now,
		updatedAt: now
	};
	await db.run(
		org.id,
		`INSERT INTO organizations (${ORGANIZATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
		[org.id, org.name, org.personal ? 1 : 0, org.createdBy, org.createdAt, org.updatedAt]
	);
	return org;
}

export async function getOrganization(
	db: CollegeDBClient,
	id: string
): Promise<Organization | null> {
	const row = await db.first<OrganizationRow>(
		id,
		`SELECT ${ORGANIZATION_COLUMNS} FROM organizations WHERE id = ?`,
		[id]
	);
	return row ? toOrganization(row) : null;
}

export class OrganizationListError extends Error {
	readonly code = 'ORGANIZATION_LIST';

	constructor() {
		super('the organisation list failed on a shard');
		this.name = 'OrganizationListError';
	}
}

export interface UserOrganization {
	id: string;
	name: string;
	personal: boolean;
	role: OrganizationRole;
}

export interface OrganizationCursor {
	personal: boolean;
	name: string;
	id: string;
}

interface UserOrganizationRow {
	id: string;
	name: string;
	personal: number;
	role: OrganizationRole;
}

// personal first, then name, then id: the order is total, so a cursor names exactly one row
function compareOrganizations(a: OrganizationCursor, b: OrganizationCursor): number {
	if (a.personal !== b.personal) return a.personal ? -1 : 1;
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

function toUserOrganization(row: UserOrganizationRow): UserOrganization {
	return { id: row.id, name: row.name, personal: row.personal === 1, role: row.role };
}

// a user's member rows sit on every shard, so the merge and the page run in memory; a failed shard
// stops the list rather than hiding organisations.
export async function listUserOrganizations(
	db: CollegeDBClient,
	userId: string,
	options: { after?: OrganizationCursor; limit: number }
): Promise<Page<UserOrganization>> {
	const shards = await db.allAllShards<UserOrganizationRow>(
		`SELECT o.id, o.name, o.personal, m.role FROM members m
		 JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ?`,
		[userId]
	);
	const rows: UserOrganization[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new OrganizationListError();
		rows.push(...shard.results.map(toUserOrganization));
	}
	rows.sort(compareOrganizations);
	const after = options.after;
	const remaining =
		after === undefined ? rows : rows.filter((row) => compareOrganizations(row, after) > 0);
	return toPage(remaining.slice(0, options.limit + 1), options.limit, (row) => ({
		personal: row.personal,
		name: row.name,
		id: row.id
	}));
}

export async function addMember(
	db: CollegeDBClient,
	organizationId: string,
	input: { userId: string; role: OrganizationRole }
): Promise<Member> {
	const now = Date.now();
	const member: Member = {
		id: crypto.randomUUID(),
		organizationId,
		userId: input.userId,
		role: input.role,
		createdAt: now,
		updatedAt: now
	};
	await uniqueOrDuplicate(() =>
		db.run(
			organizationId,
			`INSERT INTO members (${MEMBER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
			[member.id, organizationId, member.userId, member.role, now, now]
		)
	);
	return member;
}

export async function getMember(
	db: CollegeDBClient,
	organizationId: string,
	userId: string
): Promise<Member | null> {
	const row = await db.first<MemberRow>(
		organizationId,
		`SELECT ${MEMBER_COLUMNS} FROM members WHERE organization_id = ? AND user_id = ?`,
		[organizationId, userId]
	);
	return row ? toMember(row) : null;
}

export async function listMembers(
	db: CollegeDBClient,
	organizationId: string,
	options: { after?: string; limit: number }
): Promise<Page<Member>> {
	const { results } = await db.all<MemberRow>(
		organizationId,
		`SELECT ${MEMBER_COLUMNS} FROM members
		 WHERE organization_id = ? AND id > ? ORDER BY id LIMIT ?`,
		[organizationId, options.after ?? '', options.limit + 1]
	);
	const items = results.slice(0, options.limit).map(toMember);
	const nextCursor = results.length > options.limit ? (items.at(-1)?.id ?? null) : null;
	return { items, nextCursor };
}

export async function setMemberRole(
	db: CollegeDBClient,
	organizationId: string,
	memberId: string,
	role: OrganizationRole
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		'UPDATE members SET role = ?, updated_at = ? WHERE organization_id = ? AND id = ?',
		[role, Date.now(), organizationId, memberId]
	);
	return wasChanged(result);
}

export async function createInvite(
	db: CollegeDBClient,
	organizationId: string,
	input: {
		email: string;
		role: OrganizationRole;
		tokenHash: string;
		invitedBy: string;
		expiresAt: number;
	}
): Promise<Invite> {
	const now = Date.now();
	const invite: Invite = {
		id: crypto.randomUUID(),
		organizationId,
		email: input.email,
		role: input.role,
		state: 'pending',
		invitedBy: input.invitedBy,
		expiresAt: input.expiresAt,
		createdAt: now,
		updatedAt: now
	};
	await db.run(
		organizationId,
		`INSERT INTO invites (id, organization_id, email, role, token_hash, state, invited_by,
		 expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
		[
			invite.id,
			organizationId,
			invite.email,
			invite.role,
			input.tokenHash,
			invite.invitedBy,
			invite.expiresAt,
			now,
			now
		]
	);
	return invite;
}

export async function getInvite(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<Invite | null> {
	const row = await db.first<InviteRow>(
		organizationId,
		`SELECT ${INVITE_COLUMNS} FROM invites WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toInvite(row) : null;
}

export async function setInviteState(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	state: Exclude<InviteState, 'pending'>
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE invites SET state = ?, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND state = 'pending'`,
		[state, Date.now(), organizationId, id]
	);
	return wasChanged(result);
}

export async function createApiKey(
	db: CollegeDBClient,
	organizationId: string,
	input: {
		name: string;
		keyHash: string;
		scopes: string[];
		createdBy: string;
		expiresAt: number | null;
	}
): Promise<ApiKey> {
	const now = Date.now();
	const key: ApiKey = {
		id: crypto.randomUUID(),
		organizationId,
		name: input.name,
		scopes: input.scopes,
		createdBy: input.createdBy,
		expiresAt: input.expiresAt,
		revokedAt: null,
		createdAt: now,
		lastUsedAt: null
	};
	await uniqueOrDuplicate(() =>
		db.run(
			organizationId,
			`INSERT INTO api_keys (id, organization_id, name, key_hash, scopes, created_by,
			 expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			[
				key.id,
				organizationId,
				key.name,
				input.keyHash,
				JSON.stringify(key.scopes),
				key.createdBy,
				key.expiresAt,
				now
			]
		)
	);
	return key;
}

export async function getApiKeyByHash(
	db: CollegeDBClient,
	organizationId: string,
	keyHash: string
): Promise<ApiKey | null> {
	const row = await db.first<ApiKeyRow>(
		organizationId,
		`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE organization_id = ? AND key_hash = ?`,
		[organizationId, keyHash]
	);
	return row ? toApiKey(row) : null;
}

export async function getApiKey(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<ApiKey | null> {
	const row = await db.first<ApiKeyRow>(
		organizationId,
		`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toApiKey(row) : null;
}

export async function revokeApiKey(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	at: number = Date.now()
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		'UPDATE api_keys SET revoked_at = ? WHERE organization_id = ? AND id = ? AND revoked_at IS NULL',
		[at, organizationId, id]
	);
	return wasChanged(result);
}

// newest first; the cursor is the last row's created_at and id
export async function listApiKeys(
	db: CollegeDBClient,
	organizationId: string,
	options: { after?: { createdAt: number; id: string }; count: number }
): Promise<ApiKey[]> {
	const keyset =
		options.after === undefined ? '' : 'AND (created_at < ? OR (created_at = ? AND id < ?))';
	const cursor =
		options.after === undefined
			? []
			: [options.after.createdAt, options.after.createdAt, options.after.id];
	const { results } = await db.all<ApiKeyRow>(
		organizationId,
		`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE organization_id = ? ${keyset}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, ...cursor, options.count]
	);
	return results.map(toApiKey);
}

export async function countActiveApiKeys(
	db: CollegeDBClient,
	organizationId: string,
	now: number
): Promise<number> {
	const row = await db.first<{ n: number }>(
		organizationId,
		`SELECT COUNT(*) AS n FROM api_keys WHERE organization_id = ? AND revoked_at IS NULL
		 AND (expires_at IS NULL OR expires_at > ?)`,
		[organizationId, now]
	);
	return row?.n ?? 0;
}

// moves the mark forward only; a write that finds a newer mark changes nothing
export async function touchApiKey(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	at: number,
	staleBefore: number
): Promise<void> {
	await db.run(
		organizationId,
		`UPDATE api_keys SET last_used_at = ?
		 WHERE organization_id = ? AND id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
		[at, organizationId, id, staleBefore]
	);
}

export async function createDelegation(
	db: CollegeDBClient,
	clientOrganizationId: string,
	input: {
		agencyOrganizationId: string;
		role: DelegationRole;
		siteId: string | null;
		createdBy: string;
		expiresAt: number | null;
	}
): Promise<Delegation> {
	const now = Date.now();
	const delegation: Delegation = {
		id: crypto.randomUUID(),
		organizationId: clientOrganizationId,
		agencyOrganizationId: input.agencyOrganizationId,
		role: input.role,
		siteId: input.siteId,
		state: 'pending',
		expiresAt: input.expiresAt,
		createdBy: input.createdBy,
		acceptedBy: null,
		createdAt: now,
		updatedAt: now,
		revokedAt: null
	};
	await db.run(
		clientOrganizationId,
		`INSERT INTO delegations (${DELEGATION_COLUMNS})
		 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, NULL)`,
		[
			delegation.id,
			clientOrganizationId,
			delegation.agencyOrganizationId,
			delegation.role,
			delegation.siteId,
			delegation.expiresAt,
			delegation.createdBy,
			now,
			now
		]
	);
	return delegation;
}

export async function getDelegation(
	db: CollegeDBClient,
	clientOrganizationId: string,
	id: string
): Promise<Delegation | null> {
	const row = await db.first<DelegationRow>(
		clientOrganizationId,
		`SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE organization_id = ? AND id = ?`,
		[clientOrganizationId, id]
	);
	return row ? toDelegation(row) : null;
}

export async function acceptDelegation(
	db: CollegeDBClient,
	clientOrganizationId: string,
	id: string,
	acceptedBy: string
): Promise<boolean> {
	const result = await db.run(
		clientOrganizationId,
		`UPDATE delegations SET state = 'active', accepted_by = ?, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND state = 'pending'`,
		[acceptedBy, Date.now(), clientOrganizationId, id]
	);
	return wasChanged(result);
}

export async function revokeDelegation(
	db: CollegeDBClient,
	clientOrganizationId: string,
	id: string
): Promise<boolean> {
	const now = Date.now();
	const result = await db.run(
		clientOrganizationId,
		`UPDATE delegations SET state = 'revoked', revoked_at = ?, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND state IN ('pending', 'active')`,
		[now, now, clientOrganizationId, id]
	);
	return wasChanged(result);
}

export async function createSiteGrant(
	db: CollegeDBClient,
	organizationId: string,
	input: { siteId: string; userId: string; role: SiteGrantRole; createdBy: string }
): Promise<SiteGrant> {
	const now = Date.now();
	const grant: SiteGrant = {
		id: crypto.randomUUID(),
		organizationId,
		siteId: input.siteId,
		userId: input.userId,
		role: input.role,
		createdBy: input.createdBy,
		createdAt: now,
		revokedAt: null
	};
	await uniqueOrDuplicate(() =>
		db.run(
			organizationId,
			`INSERT INTO site_grants (${SITE_GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
			[grant.id, organizationId, grant.siteId, grant.userId, grant.role, grant.createdBy, now]
		)
	);
	return grant;
}

export async function getSiteGrant(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<SiteGrant | null> {
	const row = await db.first<SiteGrantRow>(
		organizationId,
		`SELECT ${SITE_GRANT_COLUMNS} FROM site_grants WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toSiteGrant(row) : null;
}

export async function revokeSiteGrant(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE site_grants SET revoked_at = ?
		 WHERE organization_id = ? AND id = ? AND revoked_at IS NULL`,
		[Date.now(), organizationId, id]
	);
	return wasChanged(result);
}
