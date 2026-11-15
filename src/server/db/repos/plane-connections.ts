import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ProbeCapability } from '../../../shared/cloudflare-probe';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface PlaneConnectionRow {
	id: string;
	organizationId: string;
	provider: 'cloudflare';
	accountId: string;
	accountName: string;
	tokenKind: 'user' | 'account';
	tokenId: string | null;
	minted: boolean;
	credentialEnvelope: string | null;
	capabilities: ProbeCapability[];
	workersSubdomain: string | null;
	expiresOn: string | null;
	state: 'active' | 'invalid' | 'revoked';
	createdAt: number;
	lastValidatedAt: number;
	revokedAt: number | null;
}

interface DbRow {
	id: string;
	organization_id: string;
	provider: string;
	account_id: string;
	account_name: string;
	token_kind: 'user' | 'account';
	token_id: string | null;
	minted: number;
	credential_envelope: string | null;
	capabilities: string;
	workers_subdomain: string | null;
	expires_on: string | null;
	state: 'active' | 'invalid' | 'revoked';
	created_at: number;
	last_validated_at: number;
	revoked_at: number | null;
}

const COLUMNS = `id, organization_id, provider, account_id, account_name, token_kind, token_id, minted,
	credential_envelope, capabilities, workers_subdomain, expires_on, state, created_at,
	last_validated_at, revoked_at`;

function toRow(row: DbRow): PlaneConnectionRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		provider: 'cloudflare',
		accountId: row.account_id,
		accountName: row.account_name,
		tokenKind: row.token_kind,
		tokenId: row.token_id,
		minted: row.minted === 1,
		credentialEnvelope: row.credential_envelope,
		capabilities: JSON.parse(row.capabilities) as ProbeCapability[],
		workersSubdomain: row.workers_subdomain,
		expiresOn: row.expires_on,
		state: row.state,
		createdAt: row.created_at,
		lastValidatedAt: row.last_validated_at,
		revokedAt: row.revoked_at
	};
}

// rows live on the organization's shard, beside its sites, so the engine joins them in one query
export async function insertPlaneConnection(
	db: CollegeDBClient,
	row: PlaneConnectionRow
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			row.organizationId,
			`INSERT INTO plane_connections (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.organizationId,
				row.provider,
				row.accountId,
				row.accountName,
				row.tokenKind,
				row.tokenId,
				row.minted ? 1 : 0,
				row.credentialEnvelope,
				JSON.stringify(row.capabilities),
				row.workersSubdomain,
				row.expiresOn,
				row.state,
				row.createdAt,
				row.lastValidatedAt,
				row.revokedAt
			]
		)
	);
}

export async function getPlaneConnection(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<PlaneConnectionRow | null> {
	const row = await db.first<DbRow>(
		orgId,
		`SELECT ${COLUMNS} FROM plane_connections WHERE id = ? AND organization_id = ?`,
		[id, orgId]
	);
	return row ? toRow(row) : null;
}

export async function listPlaneConnections(
	db: CollegeDBClient,
	orgId: string
): Promise<PlaneConnectionRow[]> {
	const { results } = await db.all<DbRow>(
		orgId,
		`SELECT ${COLUMNS} FROM plane_connections WHERE organization_id = ? ORDER BY created_at, id`,
		[orgId]
	);
	return results.map(toRow);
}

export async function openConnectionForAccount(
	db: CollegeDBClient,
	orgId: string,
	accountId: string
): Promise<PlaneConnectionRow | null> {
	const row = await db.first<DbRow>(
		orgId,
		`SELECT ${COLUMNS} FROM plane_connections
		 WHERE organization_id = ? AND provider = 'cloudflare' AND account_id = ? AND state <> 'revoked'`,
		[orgId, accountId]
	);
	return row ? toRow(row) : null;
}

export interface ValidationWrite {
	state: 'active' | 'invalid';
	capabilities: ProbeCapability[];
	workersSubdomain: string | null;
	expiresOn: string | null;
	now: number;
}

export async function writeValidation(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	write: ValidationWrite
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE plane_connections SET state = ?, capabilities = ?, workers_subdomain = ?,
		 expires_on = ?, last_validated_at = ? WHERE id = ? AND organization_id = ? AND state <> 'revoked'`,
		[
			write.state,
			JSON.stringify(write.capabilities),
			write.workersSubdomain,
			write.expiresOn,
			write.now,
			id,
			orgId
		]
	);
	return wasChanged(result);
}

// an invalid connection takes a new token in place, so the sites that name its account keep working
export async function replaceCredential(
	db: CollegeDBClient,
	orgId: string,
	row: PlaneConnectionRow
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE plane_connections SET token_kind = ?, token_id = ?, minted = ?, credential_envelope = ?,
		 account_name = ?, capabilities = ?, workers_subdomain = ?, expires_on = ?, state = 'active',
		 last_validated_at = ? WHERE id = ? AND organization_id = ? AND state = 'invalid'`,
		[
			row.tokenKind,
			row.tokenId,
			row.minted ? 1 : 0,
			row.credentialEnvelope,
			row.accountName,
			JSON.stringify(row.capabilities),
			row.workersSubdomain,
			row.expiresOn,
			row.lastValidatedAt,
			row.id,
			orgId
		]
	);
	return wasChanged(result);
}

// the envelope goes in the same write as the state, so no stored token outlives a revoke
export async function revokePlaneConnection(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE plane_connections SET state = 'revoked', credential_envelope = NULL, revoked_at = ?
		 WHERE id = ? AND organization_id = ? AND state <> 'revoked'`,
		[now, id, orgId]
	);
	return wasChanged(result);
}

// live sites (active or suspended) on the account; a tombstoned one no longer runs
export async function liveSiteIdsOnAccount(
	db: CollegeDBClient,
	orgId: string,
	accountId: string
): Promise<string[]> {
	const { results } = await db.all<{ id: string }>(
		orgId,
		`SELECT id FROM sites WHERE organization_id = ? AND plane = 'self-managed' AND account_id = ?
		 AND state IN ('active', 'suspended') ORDER BY id`,
		[orgId, accountId]
	);
	return results.map((row) => row.id);
}
