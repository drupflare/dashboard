import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	deleteCookie,
	getCookie,
	getRequestHeader,
	parseCookies,
	setCookie,
	type H3Event
} from 'h3';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { SESSION_HINT_COOKIE } from '../../shared/session-hint';
import { nowUtc } from '../../shared/utils/time';
import { findApiKeyByLookup } from '../db/repos/api-key-lookup';
import type { Principal } from '../domain/authorize';
import type { ApiKeyFacts } from '../domain/scopes';
import { parseApiKey, verifyApiKey } from '../services/api-keys';
import type { AuthDeps, TurnstileCheck } from '../services/auth';
import {
	SESSION_COOKIE_NAME,
	getSession,
	sessionCookieOptions,
	type KvStore,
	type SessionRecord
} from '../services/sessions';
import type { Credential } from './define-api';

// #region principal

export type UserPrincipal = Extract<Principal, { kind: 'user' }> & {
	sessionId: string;
	stepUpAt?: number;
};

export function stepUpAtOf(principal: Principal): number | undefined {
	return principal.kind === 'user' ? (principal as UserPrincipal).stepUpAt : undefined;
}

// #endregion

// #region key index

const keyRecordSchema = z.object({
	keyId: z.string(),
	issuerId: z.string(),
	orgId: z.string(),
	keyHash: z.string(),
	scopes: z.array(z.string()).optional(),
	expiresAt: z.number().optional(),
	revokedAt: z.number().optional()
});

export type KeyIndexRecord = z.infer<typeof keyRecordSchema>;

// a dfk_ token carries a lookup id and no organisation, so keys are found through this index
export interface KeyIndex {
	find(lookupId: string): Promise<KeyIndexRecord | null>;
}

const keyIndexName = (lookupId: string) => `apikey:${lookupId}`;

export function kvKeyIndex(kv: KvStore) {
	return {
		async find(lookupId: string): Promise<KeyIndexRecord | null> {
			const raw = await kv.get(keyIndexName(lookupId));
			if (raw === null) return null;
			try {
				const parsed = keyRecordSchema.safeParse(JSON.parse(raw));
				return parsed.success ? parsed.data : null;
			} catch {
				return null;
			}
		},
		async put(lookupId: string, record: KeyIndexRecord): Promise<void> {
			await kv.put(keyIndexName(lookupId), JSON.stringify(record));
		},
		async remove(lookupId: string): Promise<void> {
			await kv.delete(keyIndexName(lookupId));
		}
	};
}

// the production index: the lookup row and the key row on D1, so a key stops working the moment
// the key row is revoked
export function collegeKeyIndex(getDb: () => Promise<CollegeDBClient>): KeyIndex {
	return {
		async find(lookupId) {
			const record = await findApiKeyByLookup(await getDb(), lookupId);
			if (!record) return null;
			return {
				keyId: record.keyId,
				issuerId: record.issuerId,
				orgId: record.orgId,
				keyHash: record.keyHash,
				scopes: record.scopes,
				...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt }),
				...(record.revokedAt === null ? {} : { revokedAt: record.revokedAt })
			};
		}
	};
}

// #endregion

// #region services

export interface AuthServices extends AuthDeps {
	keys: KeyIndex;
}

let installed: AuthServices | null = null;

export function setAuthServices(services: AuthServices | null): void {
	installed = services;
}

export function authServices(): AuthServices {
	if (installed === null) throw new ApiError('not_built', 'Sign-in is not available yet');
	return installed;
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function siteverifyTurnstile(
	secret: string | undefined,
	fetchFn: typeof fetch = fetch
): TurnstileCheck {
	return async (token, ip) => {
		if (!secret) throw new ApiError('not_built', 'The bot check is not configured');
		if (!token) return false;
		const form = new URLSearchParams({ secret, response: token });
		if (ip) form.set('remoteip', ip);
		const response = await fetchFn(SITEVERIFY, { method: 'POST', body: form });
		if (!response.ok) return false;
		const body = (await response.json()) as { success?: boolean };
		return body.success === true;
	};
}

// #endregion

// #region resolver

// what the key's own record says about it, kept beside the principal for the facts loader
const keyFacts = new WeakMap<object, ApiKeyFacts>();

export function keyFactsOf(principal: Principal): ApiKeyFacts | undefined {
	return principal.kind === 'key' ? keyFacts.get(principal) : undefined;
}

async function resolveKey(services: AuthServices, token: string): Promise<Principal | null> {
	const parsed = parseApiKey(token);
	if (!parsed) return null;
	const record = await services.keys.find(parsed.lookupId);
	if (!record) return null;
	const checked = await verifyApiKey(token, record, nowUtc().toMillis());
	if (!checked.ok) return null;
	const principal: Principal = { kind: 'key', keyId: record.keyId, issuerId: record.issuerId };
	keyFacts.set(principal, {
		id: record.keyId,
		scopes: record.scopes ?? [],
		...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
		...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt })
	});
	return principal;
}

async function resolveSession(services: AuthServices, token: string): Promise<Principal | null> {
	const session = await getSession(services.kv, token);
	if (!session) return null;
	const principal: UserPrincipal = {
		kind: 'user',
		userId: session.userId,
		sessionId: session.id
	};
	if (session.stepUpAt !== undefined) principal.stepUpAt = session.stepUpAt;
	return principal;
}

// a revoked or expired session or key gives null; a key never carries a step-up fact
export function resolveCredential(
	services: AuthServices,
	credential: Credential
): Promise<Principal | null> {
	if (credential.kind === 'bearer') return resolveKey(services, credential.token);
	const token = credential.cookies[SESSION_COOKIE_NAME];
	return token ? resolveSession(services, token) : Promise.resolve(null);
}

export function createPrincipalResolver(
	services: () => AuthServices = authServices
): (credential: Credential) => Promise<Principal | null> {
	return async (credential) => resolveCredential(services(), credential);
}

export function credentialFromEvent(event: H3Event): Credential | null {
	const header = getRequestHeader(event, 'authorization');
	if (header === undefined) return { kind: 'cookies', cookies: parseCookies(event) };
	const match = /^Bearer (dfk_\S+)$/i.exec(header);
	return match?.[1] ? { kind: 'bearer', token: match[1] } : null;
}

export async function ensureLoggedIn(event: H3Event): Promise<Principal> {
	const credential = credentialFromEvent(event);
	const principal = credential ? await resolveCredential(authServices(), credential) : null;
	if (!principal) throw new ApiError('unauthenticated', 'Authentication is required');
	return principal;
}

// #endregion

// #region cookie

// the hint is readable by script so the first paint can pick a nav; it holds no secret and the
// server never reads it
export function setSessionCookie(event: H3Event, token: string, session: SessionRecord): void {
	const options = sessionCookieOptions(session);
	setCookie(event, SESSION_COOKIE_NAME, token, options);
	setCookie(event, SESSION_HINT_COOKIE, '1', { ...options, httpOnly: false });
}

export function clearSessionCookie(event: H3Event): void {
	deleteCookie(event, SESSION_COOKIE_NAME, { secure: true, path: '/' });
	deleteCookie(event, SESSION_HINT_COOKIE, { secure: true, path: '/' });
}

export function sessionTokenOf(event: H3Event): string | undefined {
	return getCookie(event, SESSION_COOKIE_NAME);
}

// #endregion
