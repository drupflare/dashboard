import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { claimIdempotency, completeIdempotency, releaseIdempotency } from '../db/repos/idempotency';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// a request that never finishes frees its key after this long, so a crash cannot block a key forever
export const IDEMPOTENCY_CLAIM_TTL_MS = 2 * 60_000;
export const IDEMPOTENCY_RECORD_TTL_MS = 24 * 60 * 60_000;

export type IdempotencyRecord = { fingerprint: string; status: number; body: unknown };

export type IdempotencyClaim =
	| { kind: 'claimed' }
	| { kind: 'stored'; record: IdempotencyRecord }
	| { kind: 'pending'; fingerprint: string };

// claim checks the key and takes it in one atomic step; put completes the claim with the response and
// release drops a claim whose request failed
export type IdempotencyStore = {
	claim(key: string, fingerprint: string): Promise<IdempotencyClaim>;
	put(key: string, record: IdempotencyRecord): Promise<void>;
	release(key: string): Promise<void>;
};

export type IdempotencyDecision =
	{ kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown } | { kind: 'pending' };

export function parseIdempotencyKey(header?: string | null): string | undefined {
	if (header === undefined || header === null) return undefined;
	if (!KEY_PATTERN.test(header)) {
		throw new ApiError(
			'validation',
			'Idempotency-Key must be 8 to 128 characters of letters, digits, _ or -'
		);
	}
	return header;
}

export async function requestFingerprint(
	method: string,
	path: string,
	body: string
): Promise<string> {
	const canonical = `${method} ${path}\n${canonicalBody(body)}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
	return hex.join('');
}

export async function checkIdempotency(
	store: IdempotencyStore,
	key: string,
	fingerprint: string
): Promise<IdempotencyDecision> {
	const claim = await store.claim(key, fingerprint);
	if (claim.kind === 'claimed') return { kind: 'proceed' };
	const held = claim.kind === 'stored' ? claim.record.fingerprint : claim.fingerprint;
	if (held !== fingerprint) {
		throw new ApiError(
			'unprocessable',
			'Idempotency-Key was already used for a different request'
		);
	}
	if (claim.kind === 'pending') return { kind: 'pending' };
	return { kind: 'replay', status: claim.record.status, body: claim.record.body };
}

type MemoryEntry = { fingerprint: string; expiresAt: number; record: IdempotencyRecord | null };

export function createMemoryStore(): IdempotencyStore {
	const entries = new Map<string, MemoryEntry>();
	return {
		// no await between the lookup and the write, so two callers cannot both take a key
		async claim(key, fingerprint) {
			const now = nowUtc().toMillis();
			const held = entries.get(key);
			if (held && held.expiresAt > now) {
				if (held.record) return { kind: 'stored', record: held.record };
				return { kind: 'pending', fingerprint: held.fingerprint };
			}
			entries.set(key, {
				fingerprint,
				expiresAt: now + IDEMPOTENCY_CLAIM_TTL_MS,
				record: null
			});
			return { kind: 'claimed' };
		},
		async put(key, record) {
			const now = nowUtc().toMillis();
			entries.set(key, {
				fingerprint: record.fingerprint,
				expiresAt: now + IDEMPOTENCY_RECORD_TTL_MS,
				record
			});
		},
		async release(key) {
			if (entries.get(key)?.record === null) entries.delete(key);
		}
	};
}

// the key is caller|organisation|client key; the table keeps the organisation as its own column
function splitStoreKey(key: string): { organizationId: string; idempotencyKey: string } {
	const parts = key.split('|');
	const clientKey = parts.pop() ?? '';
	const organizationId = parts.pop() ?? '-';
	return { organizationId, idempotencyKey: [...parts, clientKey].join('|') };
}

const CLAIM_TRIES = 3;

export function collegeIdempotencyStore(getDb: () => Promise<CollegeDBClient>): IdempotencyStore {
	return {
		async claim(key, fingerprint) {
			const db = await getDb();
			const row = splitStoreKey(key);
			for (let attempt = 0; attempt < CLAIM_TRIES; attempt++) {
				const held = await claimIdempotency(db, {
					...row,
					fingerprint,
					now: nowUtc().toMillis(),
					claimTtlMs: IDEMPOTENCY_CLAIM_TTL_MS
				});
				if (held === null) return { kind: 'claimed' };
				// the holder can release between our refused claim and this read
				if (held === 'released') continue;
				if (held.status === null) return { kind: 'pending', fingerprint: held.fingerprint };
				return {
					kind: 'stored',
					record: {
						fingerprint: held.fingerprint,
						status: held.status,
						body: held.body === null ? null : JSON.parse(held.body)
					}
				};
			}
			throw new ApiError('conflict', 'Idempotency-Key is being claimed by another request');
		},
		async put(key, record) {
			const row = splitStoreKey(key);
			await completeIdempotency(await getDb(), {
				...row,
				fingerprint: record.fingerprint,
				status: record.status,
				body: JSON.stringify(record.body),
				expiresAt: nowUtc().toMillis() + IDEMPOTENCY_RECORD_TTL_MS
			});
		},
		async release(key) {
			await releaseIdempotency(await getDb(), splitStoreKey(key));
		}
	};
}

function canonicalBody(body: string): string {
	if (body === '') return '';
	try {
		return JSON.stringify(sortKeys(JSON.parse(body)));
	} catch {
		return body;
	}
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== 'object') return value;
	const source = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(source)
			.sort()
			.map((key) => [key, sortKeys(source[key])])
	);
}
