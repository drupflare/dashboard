import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

// everything here is metadata about the platform and never reads a site's content

export interface AdminOverview {
	users: number;
	organizations: number;
	sites: Record<string, number>;
	operations: Record<string, number>;
}

export interface Page<T> {
	items: T[];
	// the created-at of the last item when more rows follow, else null
	nextBefore: number | null;
}

export interface AdminUser {
	id: string;
	email: string;
	displayName: string | null;
	platformRole: string | null;
	createdAt: number;
}

export interface AdminOrganization {
	id: string;
	name: string;
	personal: boolean;
	createdBy: string;
	createdAt: number;
}

export interface AdminSite {
	id: string;
	organizationId: string;
	name: string;
	kind: string;
	plane: string;
	state: string;
	primaryHostname: string | null;
	createdAt: number;
}

export interface AdminOperation {
	id: string;
	organizationId: string;
	siteId: string | null;
	type: string;
	status: string;
	verification: string;
	createdAt: number;
	updatedAt: number;
}

export class AdminReadError extends Error {
	constructor() {
		super('a shard did not answer');
		this.name = 'AdminReadError';
	}
}

const NEWEST = Number.MAX_SAFE_INTEGER;

async function eachShard<T>(
	db: CollegeDBClient,
	sql: string,
	params: unknown[] = []
): Promise<T[]> {
	const shards = await db.allAllShards<T>(sql, params);
	const rows: T[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new AdminReadError();
		rows.push(...shard.results);
	}
	return rows;
}

function countsBy(rows: { key: string; n: number }[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const row of rows) out[row.key] = (out[row.key] ?? 0) + row.n;
	return out;
}

export async function adminOverview(db: CollegeDBClient): Promise<AdminOverview> {
	const users = await db.first<{ n: number }>(DIRECTORY_KEY, 'SELECT COUNT(*) AS n FROM users');
	const orgs = await eachShard<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM organizations');
	const sites = await eachShard<{ key: string; n: number }>(
		db,
		'SELECT state AS key, COUNT(*) AS n FROM sites GROUP BY state'
	);
	const operations = await eachShard<{ key: string; n: number }>(
		db,
		'SELECT status AS key, COUNT(*) AS n FROM operations GROUP BY status'
	);
	return {
		users: users?.n ?? 0,
		organizations: orgs.reduce((sum, row) => sum + row.n, 0),
		sites: countsBy(sites),
		operations: countsBy(operations)
	};
}

// newest first across shards; rows sharing a created-at millisecond at a page edge can repeat or
// skip, which is fine for an admin read
function toPage<T extends { createdAt: number }>(rows: T[], limit: number): Page<T> {
	rows.sort((a, b) => b.createdAt - a.createdAt);
	const items = rows.slice(0, limit);
	const more = rows.length > limit;
	return { items, nextBefore: more ? (items[items.length - 1]?.createdAt ?? null) : null };
}

interface UserRow {
	id: string;
	email: string;
	display_name: string | null;
	platform_role: string | null;
	created_at: number;
}

export async function listAdminUsers(
	db: CollegeDBClient,
	options: { before?: number; limit: number }
): Promise<Page<AdminUser>> {
	const { results } = await db.all<UserRow>(
		DIRECTORY_KEY,
		`SELECT id, email, display_name, platform_role, created_at FROM users
		 WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
		[options.before ?? NEWEST, options.limit + 1]
	);
	return toPage(
		results.map((row) => ({
			id: row.id,
			email: row.email,
			displayName: row.display_name,
			platformRole: row.platform_role,
			createdAt: row.created_at
		})),
		options.limit
	);
}

interface OrganizationRow {
	id: string;
	name: string;
	personal: number;
	created_by: string;
	created_at: number;
}

export async function listAdminOrganizations(
	db: CollegeDBClient,
	options: { before?: number; limit: number }
): Promise<Page<AdminOrganization>> {
	const rows = await eachShard<OrganizationRow>(
		db,
		`SELECT id, name, personal, created_by, created_at FROM organizations
		 WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
		[options.before ?? NEWEST, options.limit + 1]
	);
	return toPage(
		rows.map((row) => ({
			id: row.id,
			name: row.name,
			personal: row.personal === 1,
			createdBy: row.created_by,
			createdAt: row.created_at
		})),
		options.limit
	);
}

interface SiteRow {
	id: string;
	organization_id: string;
	name: string;
	kind: string;
	plane: string;
	state: string;
	primary_hostname: string | null;
	created_at: number;
}

export async function listAdminSites(
	db: CollegeDBClient,
	options: { before?: number; limit: number }
): Promise<Page<AdminSite>> {
	const rows = await eachShard<SiteRow>(
		db,
		`SELECT id, organization_id, name, kind, plane, state, primary_hostname, created_at FROM sites
		 WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
		[options.before ?? NEWEST, options.limit + 1]
	);
	return toPage(
		rows.map((row) => ({
			id: row.id,
			organizationId: row.organization_id,
			name: row.name,
			kind: row.kind,
			plane: row.plane,
			state: row.state,
			primaryHostname: row.primary_hostname,
			createdAt: row.created_at
		})),
		options.limit
	);
}

interface OperationRow {
	id: string;
	organization_id: string;
	site_id: string | null;
	type: string;
	status: string;
	verification: string;
	created_at: number;
	updated_at: number;
}

export async function listAdminOperations(
	db: CollegeDBClient,
	options: { before?: number; limit: number }
): Promise<Page<AdminOperation>> {
	const rows = await eachShard<OperationRow>(
		db,
		`SELECT id, organization_id, site_id, type, status, verification, created_at, updated_at
		 FROM operations WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
		[options.before ?? NEWEST, options.limit + 1]
	);
	return toPage(
		rows.map((row) => ({
			id: row.id,
			organizationId: row.organization_id,
			siteId: row.site_id,
			type: row.type,
			status: row.status,
			verification: row.verification,
			createdAt: row.created_at,
			updatedAt: row.updated_at
		})),
		options.limit
	);
}
