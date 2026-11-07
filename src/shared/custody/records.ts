import type { Aad } from './envelope';

// #region owner token

export const OWNER_TOKEN_PURPOSE = 'owner-token';

export function ownerTokenAad(siteId: string): Aad {
	return { siteId, purpose: OWNER_TOKEN_PURPOSE };
}

// the dashboard and the engine run these same statements, so the stored record has one format
export const OWNER_TOKEN_SQL = {
	select: 'SELECT version, current_envelope, previous_envelope FROM owner_tokens WHERE site_id = ?',
	insert: `INSERT INTO owner_tokens (site_id, version, current_envelope, previous_envelope, updated_at)
					 VALUES (?, 1, ?, ?, ?) ON CONFLICT (site_id) DO NOTHING RETURNING version`,
	update: `UPDATE owner_tokens SET version = version + 1, current_envelope = ?,
					 previous_envelope = ?, updated_at = ? WHERE site_id = ? AND version = ?
					 RETURNING version`,
	exists: 'SELECT version FROM owner_tokens WHERE site_id = ?',
	discard: 'DELETE FROM owner_tokens WHERE site_id = ?'
} as const;

// #endregion

// #region pending secrets

export const PENDING_SECRET_KINDS = ['admin-password'] as const;
export type PendingSecretKind = (typeof PENDING_SECRET_KINDS)[number];

export function pendingSecretAad(siteId: string, kind: PendingSecretKind): Aad {
	return { siteId, purpose: `pending-secret:${kind}` };
}

// a row holds one secret until its first read or its expiry, whichever comes first
export const PENDING_SECRET_SQL = {
	seal: `INSERT INTO pending_secrets (site_id, kind, ciphertext, key_version, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (site_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext,
				 key_version = excluded.key_version, created_at = excluded.created_at,
				 expires_at = excluded.expires_at, revealed_at = NULL`,
	select: `SELECT ciphertext, key_version, created_at, expires_at, revealed_at
					 FROM pending_secrets WHERE site_id = ? AND kind = ?`,
	exists: 'SELECT kind FROM pending_secrets WHERE site_id = ?',
	rewrap: `UPDATE pending_secrets SET ciphertext = ?, key_version = ?
					 WHERE site_id = ? AND kind = ? AND revealed_at IS NULL AND ciphertext = ?`,
	reveal: `UPDATE pending_secrets SET revealed_at = ?, ciphertext = ''
					 WHERE site_id = ? AND kind = ? AND revealed_at IS NULL AND expires_at > ?`,
	discard: 'DELETE FROM pending_secrets WHERE site_id = ?'
} as const;

export interface PendingExpiry {
	siteId: string;
	kind: PendingSecretKind;
	expiresAt: number;
}

// the rows a scheduled task may delete: past their expiry, whether or not anyone read them
export function expiredPendingSecrets<T extends PendingExpiry>(
	rows: readonly T[],
	now: number
): T[] {
	return rows.filter((row) => row.expiresAt <= now);
}

export interface PendingState {
	expiresAt: number;
	revealedAt: number | null;
}

// what the owner can still do with a site's first admin password. The purge task deletes a row
// after its expiry, so a missing row on a site that recorded its admin reads as expired; on one
// that did not, the dashboard never saw the first run's answer
export function adminPasswordState(
	row: PendingState | null,
	now: number,
	adminRecorded: boolean
): 'available' | 'revealed' | 'expired' | 'unknown' {
	if (row === null) return adminRecorded ? 'expired' : 'unknown';
	if (row.revealedAt !== null) return 'revealed';
	return row.expiresAt <= now ? 'expired' : 'available';
}

// #endregion

// #region ids

// ids name a sealed record and carry no secret; the first-run step returns these and nothing else
export const ownerTokenIdOf = (siteId: string): string => `owner-token:${siteId}`;

export const pendingSecretIdOf = (siteId: string, kind: PendingSecretKind): string =>
	`pending-secret:${siteId}:${kind}`;

// #endregion
