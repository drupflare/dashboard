import { ApiError } from '../../shared/errors';

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type IdempotencyRecord = { fingerprint: string; status: number; body: unknown };

export type IdempotencyStore = {
	get(key: string): Promise<IdempotencyRecord | null>;
	put(key: string, record: IdempotencyRecord): Promise<void>;
};

export type IdempotencyDecision =
	{ kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown };

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
	const record = await store.get(key);
	if (record === null) return { kind: 'proceed' };
	if (record.fingerprint !== fingerprint) {
		throw new ApiError(
			'unprocessable',
			'Idempotency-Key was already used for a different request'
		);
	}
	return { kind: 'replay', status: record.status, body: record.body };
}

export function createMemoryStore(): IdempotencyStore {
	const records = new Map<string, IdempotencyRecord>();
	return {
		async get(key) {
			return records.get(key) ?? null;
		},
		async put(key, record) {
			records.set(key, record);
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
