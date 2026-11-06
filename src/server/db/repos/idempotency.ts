import type { CollegeDBClient } from '@earth-app/collegedb';

interface Slot {
	organizationId: string;
	idempotencyKey: string;
}

export interface HeldKey {
	fingerprint: string;
	status: number | null;
	body: string | null;
}

// one insert takes a free key, or an expired one; null means this caller holds it. Otherwise the
// holder is read back, and 'released' means it went away before the read
export async function claimIdempotency(
	db: CollegeDBClient,
	input: Slot & { fingerprint: string; now: number; claimTtlMs: number }
): Promise<HeldKey | 'released' | null> {
	const taken = await db.first<{ request_hash: string }>(
		input.organizationId,
		`INSERT INTO idempotency_keys (organization_id, idempotency_key, route, request_hash,
		 response_status, response_body, created_at, expires_at) VALUES (?, ?, '', ?, NULL, NULL, ?, ?)
		 ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET
		 request_hash = excluded.request_hash, response_status = NULL, response_body = NULL,
		 created_at = excluded.created_at, expires_at = excluded.expires_at
		 WHERE idempotency_keys.expires_at <= ?
		 RETURNING request_hash`,
		[
			input.organizationId,
			input.idempotencyKey,
			input.fingerprint,
			input.now,
			input.now + input.claimTtlMs,
			input.now
		]
	);
	if (taken) return null;
	const row = await db.first<{
		request_hash: string;
		response_status: number | null;
		response_body: string | null;
	}>(
		input.organizationId,
		`SELECT request_hash, response_status, response_body FROM idempotency_keys
		 WHERE organization_id = ? AND idempotency_key = ?`,
		[input.organizationId, input.idempotencyKey]
	);
	if (!row) return 'released';
	return { fingerprint: row.request_hash, status: row.response_status, body: row.response_body };
}

export async function completeIdempotency(
	db: CollegeDBClient,
	input: Slot & { fingerprint: string; status: number; body: string; expiresAt: number }
): Promise<void> {
	await db.run(
		input.organizationId,
		`UPDATE idempotency_keys SET response_status = ?, response_body = ?, expires_at = ?
		 WHERE organization_id = ? AND idempotency_key = ? AND request_hash = ?`,
		[
			input.status,
			input.body,
			input.expiresAt,
			input.organizationId,
			input.idempotencyKey,
			input.fingerprint
		]
	);
}

export async function releaseIdempotency(db: CollegeDBClient, input: Slot): Promise<void> {
	await db.run(
		input.organizationId,
		`DELETE FROM idempotency_keys
		 WHERE organization_id = ? AND idempotency_key = ? AND response_status IS NULL`,
		[input.organizationId, input.idempotencyKey]
	);
}
