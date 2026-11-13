import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ProviderId } from '../../integrations/git-providers';
import { DIRECTORY_KEY, uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface ConnectionRow {
	id: string;
	organizationId: string;
	provider: ProviderId;
	externalId: string;
	displayName: string;
	credentialEnvelope: string | null;
	scopes: string[];
	state: 'active' | 'revoked';
	createdAt: number;
	revokedAt: number | null;
}

export interface RemoteRow {
	id: string;
	siteId: string;
	organizationId: string;
	connectionId: string;
	repoFullName: string;
	branch: string;
	mountPath: string;
	intervalMinutes: number;
	lastPullStatus: string | null;
	lastPullAt: number | null;
	createdAt: number;
}

interface ConnectionDbRow {
	id: string;
	organization_id: string;
	provider: string;
	external_id: string;
	display_name: string;
	credential_envelope: string | null;
	scopes: string;
	state: 'active' | 'revoked';
	created_at: number;
	revoked_at: number | null;
}

interface RemoteDbRow {
	id: string;
	site_id: string;
	organization_id: string;
	connection_id: string;
	repo_full_name: string;
	branch: string;
	mount_path: string;
	interval_minutes: number;
	last_pull_status: string | null;
	last_pull_at: number | null;
	created_at: number;
}

const CONNECTION_COLUMNS =
	'id, organization_id, provider, external_id, display_name, credential_envelope, scopes, state, created_at, revoked_at';
const REMOTE_COLUMNS =
	'id, site_id, organization_id, connection_id, repo_full_name, branch, mount_path, interval_minutes, last_pull_status, last_pull_at, created_at';

function parseScopes(raw: string): string[] {
	const parsed: unknown = JSON.parse(raw);
	return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

function toConnection(row: ConnectionDbRow): ConnectionRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		provider: row.provider as ProviderId,
		externalId: row.external_id,
		displayName: row.display_name,
		credentialEnvelope: row.credential_envelope,
		scopes: parseScopes(row.scopes),
		state: row.state,
		createdAt: row.created_at,
		revokedAt: row.revoked_at
	};
}

function toRemote(row: RemoteDbRow): RemoteRow {
	return {
		id: row.id,
		siteId: row.site_id,
		organizationId: row.organization_id,
		connectionId: row.connection_id,
		repoFullName: row.repo_full_name,
		branch: row.branch,
		mountPath: row.mount_path,
		intervalMinutes: row.interval_minutes,
		lastPullStatus: row.last_pull_status,
		lastPullAt: row.last_pull_at,
		createdAt: row.created_at
	};
}

// #region connections

export async function insertConnection(db: CollegeDBClient, row: ConnectionRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO repo_connections (${CONNECTION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.organizationId,
				row.provider,
				row.externalId,
				row.displayName,
				row.credentialEnvelope,
				JSON.stringify(row.scopes),
				row.state,
				row.createdAt,
				row.revokedAt
			]
		)
	);
}

export async function getConnection(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<ConnectionRow | null> {
	const row = await db.first<ConnectionDbRow>(
		DIRECTORY_KEY,
		`SELECT ${CONNECTION_COLUMNS} FROM repo_connections WHERE id = ? AND organization_id = ?`,
		[id, orgId]
	);
	return row ? toConnection(row) : null;
}

export async function activeConnectionByExternal(
	db: CollegeDBClient,
	provider: ProviderId,
	externalId: string
): Promise<ConnectionRow | null> {
	const row = await db.first<ConnectionDbRow>(
		DIRECTORY_KEY,
		`SELECT ${CONNECTION_COLUMNS} FROM repo_connections
		 WHERE provider = ? AND external_id = ? AND state = 'active'`,
		[provider, externalId]
	);
	return row ? toConnection(row) : null;
}

export async function listConnections(
	db: CollegeDBClient,
	orgId: string
): Promise<ConnectionRow[]> {
	const { results } = await db.all<ConnectionDbRow>(
		DIRECTORY_KEY,
		`SELECT ${CONNECTION_COLUMNS} FROM repo_connections WHERE organization_id = ?
		 ORDER BY created_at, id`,
		[orgId]
	);
	return results.map(toConnection);
}

// the envelope is replaced in place when a GitLab refresh token rotates
export async function setConnectionCredential(
	db: CollegeDBClient,
	id: string,
	envelope: string
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		'UPDATE repo_connections SET credential_envelope = ? WHERE id = ? AND state = ?',
		[envelope, id, 'active']
	);
	return wasChanged(result);
}

// revoking clears the envelope in the same write, so no stored credential outlives the revoke
export async function revokeConnectionRow(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		`UPDATE repo_connections SET state = 'revoked', credential_envelope = NULL, revoked_at = ?
		 WHERE id = ? AND organization_id = ? AND state = 'active'`,
		[now, id, orgId]
	);
	return wasChanged(result);
}

// #endregion

// #region remotes

export async function insertRemote(db: CollegeDBClient, row: RemoteRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO site_remotes (${REMOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.siteId,
				row.organizationId,
				row.connectionId,
				row.repoFullName,
				row.branch,
				row.mountPath,
				row.intervalMinutes,
				row.lastPullStatus,
				row.lastPullAt,
				row.createdAt
			]
		)
	);
}

export async function listRemotes(
	db: CollegeDBClient,
	orgId: string,
	siteId: string
): Promise<RemoteRow[]> {
	const { results } = await db.all<RemoteDbRow>(
		DIRECTORY_KEY,
		`SELECT ${REMOTE_COLUMNS} FROM site_remotes WHERE organization_id = ? AND site_id = ?
		 ORDER BY created_at, id`,
		[orgId, siteId]
	);
	return results.map(toRemote);
}

// only remotes on an active connection of the same provider are pulled
export async function listRemotesForPush(
	db: CollegeDBClient,
	provider: string,
	repo: string,
	branch: string
): Promise<RemoteRow[]> {
	const { results } = await db.all<RemoteDbRow>(
		DIRECTORY_KEY,
		`SELECT r.id, r.site_id, r.organization_id, r.connection_id, r.repo_full_name, r.branch,
		 r.mount_path, r.interval_minutes, r.last_pull_status, r.last_pull_at, r.created_at
		 FROM site_remotes r JOIN repo_connections c ON c.id = r.connection_id
		 WHERE c.provider = ? AND c.state = 'active' AND r.repo_full_name = ? AND r.branch = ?
		 ORDER BY r.id`,
		[provider, repo, branch]
	);
	return results.map(toRemote);
}

export async function setRemotePull(
	db: CollegeDBClient,
	id: string,
	status: string,
	at: number
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		'UPDATE site_remotes SET last_pull_status = ?, last_pull_at = ? WHERE id = ?',
		[status, at, id]
	);
}

// #endregion

// #region deliveries

export async function hasDelivery(
	db: CollegeDBClient,
	provider: string,
	deliveryId: string
): Promise<boolean> {
	const row = await db.first<{ delivery_id: string }>(
		DIRECTORY_KEY,
		'SELECT delivery_id FROM repo_deliveries WHERE provider = ? AND delivery_id = ?',
		[provider, deliveryId]
	);
	return row !== null;
}

export async function recordDelivery(
	db: CollegeDBClient,
	provider: string,
	deliveryId: string,
	now: number
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		'INSERT OR IGNORE INTO repo_deliveries (provider, delivery_id, received_at) VALUES (?, ?, ?)',
		[provider, deliveryId, now]
	);
}

// #endregion
