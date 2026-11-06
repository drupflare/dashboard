import type { CollegeDBClient } from '@earth-app/collegedb';
import { PENDING_SECRET_SQL, type PendingSecretKind } from '../../../shared/custody/records';
import { wasChanged } from '../collegedb';

export interface PendingSecretRow {
	ciphertext: string;
	keyVersion: number;
	createdAt: number;
	expiresAt: number;
	revealedAt: number | null;
}

interface Row {
	ciphertext: string;
	key_version: number;
	created_at: number;
	expires_at: number;
	revealed_at: number | null;
}

// rows shard by site id, as the owner token does, so the engine's write and this read agree
export async function getPendingSecret(
	db: CollegeDBClient,
	siteId: string,
	kind: PendingSecretKind
): Promise<PendingSecretRow | null> {
	const row = await db.first<Row>(siteId, PENDING_SECRET_SQL.select, [siteId, kind]);
	if (!row) return null;
	return {
		ciphertext: row.ciphertext,
		keyVersion: row.key_version,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		revealedAt: row.revealed_at
	};
}

// one conditional update decides the single reader; false means it was read, expired or never there
export async function markPendingSecretRevealed(
	db: CollegeDBClient,
	siteId: string,
	kind: PendingSecretKind,
	now: number
): Promise<boolean> {
	const result = await db.run(siteId, PENDING_SECRET_SQL.reveal, [now, siteId, kind, now]);
	return wasChanged(result);
}

// replaces the envelope only while the row still holds the one that was read
export async function replacePendingCiphertext(
	db: CollegeDBClient,
	siteId: string,
	kind: PendingSecretKind,
	change: { from: string; to: string; keyVersion: number }
): Promise<boolean> {
	const result = await db.run(siteId, PENDING_SECRET_SQL.rewrap, [
		change.to,
		change.keyVersion,
		siteId,
		kind,
		change.from
	]);
	return wasChanged(result);
}

// sites shard by organisation, so this asks the organisation's shard
export async function siteInOrganization(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<boolean> {
	const row = await db.first<{ id: string }>(
		organizationId,
		'SELECT id FROM sites WHERE organization_id = ? AND id = ?',
		[organizationId, siteId]
	);
	return Boolean(row);
}
