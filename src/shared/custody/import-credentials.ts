import type { Aad } from './envelope';

export const IMPORT_CREDENTIAL_PURPOSE = 'import-credential';

// a key we generated for one import, so it lives for a day at most
export const IMPORT_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const IMPORT_CREDENTIAL_ID = /^imc_[a-z2-7]{26}$/;

export function newImportCredentialId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(26));
	let body = '';
	for (const byte of bytes) body += ID_ALPHABET[byte & 31];
	return `imc_${body}`;
}

// the sealed value is bound to its row, so a copied envelope fails to open on another credential
export function importCredentialAad(credentialId: string): Aad {
	return { siteId: credentialId, purpose: IMPORT_CREDENTIAL_PURPOSE };
}

// the dashboard and the engine run these same statements, so the stored record has one format
export const IMPORT_CREDENTIAL_SQL = {
	insert: `INSERT INTO import_credentials (id, organization_id, user_id, key_envelope, public_key,
					 host, port, username, created_at, expires_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	select: `SELECT id, organization_id, user_id, key_envelope, public_key, host, port, username,
					 host_key_fingerprint, host_key_type, created_at, expires_at, used_at
					 FROM import_credentials WHERE organization_id = ? AND id = ?`,
	confirmHostKey: `UPDATE import_credentials SET host_key_fingerprint = ?, host_key_type = ?
					 WHERE organization_id = ? AND id = ? AND host_key_fingerprint IS NULL`,
	markUsed: `UPDATE import_credentials SET used_at = ? WHERE id = ? AND used_at IS NULL`,
	hostOf: 'SELECT host FROM import_credentials WHERE id = ?',
	discard: 'DELETE FROM import_credentials WHERE id = ?',
	expired: 'SELECT id, organization_id, expires_at FROM import_credentials WHERE expires_at <= ?',
	purge: 'DELETE FROM import_credentials WHERE id = ? AND expires_at <= ?'
} as const;

export interface ImportCredentialExpiry {
	id: string;
	expiresAt: number;
}

// the rows a scheduled task may delete: past their expiry, whether or not the import used them
export function expiredImportCredentials<T extends ImportCredentialExpiry>(
	rows: readonly T[],
	now: number
): T[] {
	return rows.filter((row) => row.expiresAt <= now);
}

// the same plain checks for the route and the engine, so neither opens a key it should refuse
export type CredentialRefusal = 'expired' | 'host_key_unconfirmed';

export function credentialRefusal(
	row: { expiresAt: number; hostKeyFingerprint: string | null },
	now: number
): CredentialRefusal | null {
	if (row.expiresAt <= now) return 'expired';
	if (row.hostKeyFingerprint === null) return 'host_key_unconfirmed';
	return null;
}
