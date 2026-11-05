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
import { nowUtc } from '../../shared/utils/time';
import { ensureCollegeDB, type CollegeDBEnv } from '../db/collegedb';
import type { Principal } from '../domain/authorize';
import { parseApiKey, verifyApiKey } from '../services/api-keys';
import { collegeDirectory, type AuthDeps, type TurnstileCheck } from '../services/auth';
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

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

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

// the boot plugin installs this once; mail stays closed until the email sending binding lands
export function productionServices(
	env: CollegeDBEnv,
	secrets: { codeSecret?: string; turnstileSecret?: string }
): AuthServices {
	return {
		kv: env.KV,
		directory: collegeDirectory(() => ensureCollegeDB(env)),
		mail: { send: notBuilt('Mail') },
		turnstile: siteverifyTurnstile(secrets.turnstileSecret),
		codeSecret: secrets.codeSecret ?? '',
		keys: kvKeyIndex(env.KV)
	};
}

// #endregion

// #region resolver

async function resolveKey(services: AuthServices, token: string): Promise<Principal | null> {
	const parsed = parseApiKey(token);
	if (!parsed) return null;
	const record = await services.keys.find(parsed.lookupId);
	if (!record) return null;
	const checked = await verifyApiKey(token, record, nowUtc().toMillis());
	return checked.ok ? { kind: 'key', keyId: record.keyId, issuerId: record.issuerId } : null;
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

export function setSessionCookie(event: H3Event, token: string, session: SessionRecord): void {
	setCookie(event, SESSION_COOKIE_NAME, token, sessionCookieOptions(session));
}

export function clearSessionCookie(event: H3Event): void {
	deleteCookie(event, SESSION_COOKIE_NAME, { secure: true, path: '/' });
}

export function sessionTokenOf(event: H3Event): string | undefined {
	return getCookie(event, SESSION_COOKIE_NAME);
}

// #endregion
