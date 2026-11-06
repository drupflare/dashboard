import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY, uniqueOrDuplicate } from '../collegedb';
import { createApiKey, type ApiKey } from './organization';

export interface ApiKeyLookupRecord {
	keyId: string;
	issuerId: string;
	orgId: string;
	keyHash: string;
	scopes: string[];
	expiresAt: number | null;
	revokedAt: number | null;
}

interface KeyRow {
	id: string;
	created_by: string;
	key_hash: string;
	scopes: string;
	expires_at: number | null;
	revoked_at: number | null;
}

// a token names its key and not its organisation, and keys live on the organisation's shard, so the
// directory shard holds a row that maps the public lookup id to both
export async function putApiKeyLookup(
	db: CollegeDBClient,
	lookupId: string,
	organizationId: string,
	keyId: string
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			'INSERT INTO api_key_lookup (lookup_id, organization_id, key_id) VALUES (?, ?, ?)',
			[lookupId, organizationId, keyId]
		)
	);
}

// the key row is written first, so a failure between the two writes leaves a key nobody can present
export async function createApiKeyWithLookup(
	db: CollegeDBClient,
	organizationId: string,
	input: Parameters<typeof createApiKey>[2] & { lookupId: string }
): Promise<ApiKey> {
	const { lookupId, ...rest } = input;
	const key = await createApiKey(db, organizationId, rest);
	await putApiKeyLookup(db, lookupId, organizationId, key.id);
	return key;
}

function parseScopes(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

// two keyed reads, never a scan: the lookup row, then the key row on its own shard. Revocation and
// expiry come from the key row, so there is no second copy to fall out of step
export async function findApiKeyByLookup(
	db: CollegeDBClient,
	lookupId: string
): Promise<ApiKeyLookupRecord | null> {
	const link = await db.first<{ organization_id: string; key_id: string }>(
		DIRECTORY_KEY,
		'SELECT organization_id, key_id FROM api_key_lookup WHERE lookup_id = ?',
		[lookupId]
	);
	if (!link) return null;
	const row = await db.first<KeyRow>(
		link.organization_id,
		`SELECT id, created_by, key_hash, scopes, expires_at, revoked_at FROM api_keys
		 WHERE organization_id = ? AND id = ?`,
		[link.organization_id, link.key_id]
	);
	if (!row) return null;
	return {
		keyId: row.id,
		issuerId: row.created_by,
		orgId: link.organization_id,
		keyHash: row.key_hash,
		scopes: parseScopes(row.scopes),
		expiresAt: row.expires_at,
		revokedAt: row.revoked_at
	};
}
