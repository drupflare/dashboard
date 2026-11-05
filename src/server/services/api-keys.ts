import { randomBytes, randomToken, sha256Hex, timingSafeEqual, toHex } from './crypto';

export const API_KEY_PREFIX = 'dfk_';

const LOOKUP_BYTES = 6;
const KEY_PATTERN = /^dfk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPIRY_PRESETS = {
	'30d': 30 * DAY_MS,
	'90d': 90 * DAY_MS,
	'180d': 180 * DAY_MS,
	'365d': 365 * DAY_MS
} as const;

export type ExpiryPreset = keyof typeof EXPIRY_PRESETS;

export interface NewApiKeyInput {
	scopes: readonly string[];
	expiry: ExpiryPreset;
	orgIds?: readonly string[];
	siteIds?: readonly string[];
	now: number;
}

export interface ApiKeyData {
	lookupId: string;
	displayPrefix: string;
	keyHash: string;
	scopes: string[];
	expiresAt: number;
	orgIds?: string[];
	siteIds?: string[];
}

// the token is shown once; only keyHash and the public fields are stored
export interface GeneratedApiKey {
	token: string;
	data: ApiKeyData;
}

export function hashApiKey(token: string): Promise<string> {
	return sha256Hex(token);
}

export async function generateApiKey(input: NewApiKeyInput): Promise<GeneratedApiKey> {
	const lookupId = toHex(randomBytes(LOOKUP_BYTES));
	const displayPrefix = `${API_KEY_PREFIX}${lookupId}`;
	const token = `${displayPrefix}_${randomToken()}`;
	const data: ApiKeyData = {
		lookupId,
		displayPrefix,
		keyHash: await hashApiKey(token),
		scopes: [...input.scopes],
		expiresAt: input.now + EXPIRY_PRESETS[input.expiry]
	};
	if (input.orgIds) data.orgIds = [...input.orgIds];
	if (input.siteIds) data.siteIds = [...input.siteIds];
	return { token, data };
}

// the public part, safe to log and to use as a lookup key; null when the token is not a dfk_ key
export function parseApiKey(token: string): { lookupId: string; displayPrefix: string } | null {
	const match = KEY_PATTERN.exec(token);
	if (!match) return null;
	const lookupId = match[1]!;
	return { lookupId, displayPrefix: `${API_KEY_PREFIX}${lookupId}` };
}

export type ApiKeyRefusal = 'malformed' | 'mismatch' | 'revoked' | 'expired';

export interface StoredApiKey {
	keyHash: string;
	expiresAt?: number | null;
	revokedAt?: number | null;
}

// the secret check runs first, so an attacker without the secret learns nothing about state
export async function verifyApiKey(
	token: string,
	stored: StoredApiKey,
	now: number
): Promise<{ ok: true } | { ok: false; reason: ApiKeyRefusal }> {
	if (!parseApiKey(token)) return { ok: false, reason: 'malformed' };
	if (!timingSafeEqual(await hashApiKey(token), stored.keyHash)) {
		return { ok: false, reason: 'mismatch' };
	}
	if (stored.revokedAt != null && stored.revokedAt <= now)
		return { ok: false, reason: 'revoked' };
	if (stored.expiresAt != null && stored.expiresAt <= now)
		return { ok: false, reason: 'expired' };
	return { ok: true };
}
