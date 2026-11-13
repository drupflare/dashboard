import type { CollegeDBClient } from '@earth-app/collegedb';
import { IMPORT_CREDENTIAL_SQL } from '../../../shared/custody/import-credentials';
import { wasChanged } from '../collegedb';

export interface ImportCredentialRow {
	id: string;
	organizationId: string;
	userId: string;
	keyEnvelope: string;
	publicKey: string;
	host: string;
	port: number;
	username: string;
	hostKeyFingerprint: string | null;
	hostKeyType: string | null;
	createdAt: number;
	expiresAt: number;
	usedAt: number | null;
}

interface Row {
	id: string;
	organization_id: string;
	user_id: string;
	key_envelope: string;
	public_key: string;
	host: string;
	port: number;
	username: string;
	host_key_fingerprint: string | null;
	host_key_type: string | null;
	created_at: number;
	expires_at: number;
	used_at: number | null;
}

export async function insertImportCredential(
	db: CollegeDBClient,
	row: Omit<ImportCredentialRow, 'hostKeyFingerprint' | 'hostKeyType' | 'usedAt'>
): Promise<void> {
	await db.run(row.organizationId, IMPORT_CREDENTIAL_SQL.insert, [
		row.id,
		row.organizationId,
		row.userId,
		row.keyEnvelope,
		row.publicKey,
		row.host,
		row.port,
		row.username,
		row.createdAt,
		row.expiresAt
	]);
}

export async function getImportCredential(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<ImportCredentialRow | null> {
	const row = await db.first<Row>(organizationId, IMPORT_CREDENTIAL_SQL.select, [
		organizationId,
		id
	]);
	if (!row) return null;
	return {
		id: row.id,
		organizationId: row.organization_id,
		userId: row.user_id,
		keyEnvelope: row.key_envelope,
		publicKey: row.public_key,
		host: row.host,
		port: row.port,
		username: row.username,
		hostKeyFingerprint: row.host_key_fingerprint,
		hostKeyType: row.host_key_type,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		usedAt: row.used_at
	};
}

// the fingerprint is set once; a second confirmation never replaces it
export async function confirmImportHostKey(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	hostKey: { fingerprint: string; type: string }
): Promise<boolean> {
	const result = await db.run(organizationId, IMPORT_CREDENTIAL_SQL.confirmHostKey, [
		hostKey.fingerprint,
		hostKey.type,
		organizationId,
		id
	]);
	return wasChanged(result);
}

export async function deleteImportCredential(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<boolean> {
	return wasChanged(await db.run(organizationId, IMPORT_CREDENTIAL_SQL.discard, [id]));
}
