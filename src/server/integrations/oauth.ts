import { sha256Hex } from '@contracts/common';
import {
	CodeChallengeMethod,
	Google,
	MicrosoftEntraId,
	OAuth2Client,
	decodeIdToken,
	generateCodeVerifier,
	type OAuth2Tokens
} from 'arctic';
import { deleteCookie, setCookie, type H3Event } from 'h3';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
	OAUTH_CONSENT_TEXT,
	OAUTH_PROVIDERS,
	stateFor,
	type OAuthProvider
} from '../../shared/oauth';
import { nowUtc } from '../../shared/utils/time';
import { randomToken, timingSafeEqual } from '../services/crypto';
import type { OnceStore } from '../services/single-use';

// #region providers

export { OAUTH_PROVIDERS, type OAuthProvider };

export function isOAuthProvider(value: unknown): value is OAuthProvider {
	return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderCredentials {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	baseUrl?: string;
	tenant?: string;
}

export type OAuthConfig = Partial<Record<OAuthProvider, ProviderCredentials>>;

export interface ProviderProfile {
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string | null;
}

export interface ProviderTokens {
	accessToken: string;
	idToken: string | null;
	// the scopes the provider says it granted, when it says
	scopes?: readonly string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OAuthClient {
	scopes: readonly string[];
	authorizationUrl(state: string, verifier: string): URL;
	exchange(code: string, verifier: string): Promise<ProviderTokens>;
	profile(tokens: ProviderTokens, fetchFn: FetchLike): Promise<ProviderProfile>;
}

export type OAuthClients = Partial<Record<OAuthProvider, OAuthClient>>;

// name and email only; repository access is a separate grant
export const OAUTH_SCOPES = {
	github: ['user:email'],
	gitlab: ['openid', 'profile', 'email'],
	google: ['openid', 'profile', 'email'],
	microsoft: ['openid', 'profile', 'email']
} as const satisfies Record<OAuthProvider, readonly string[]>;

export { OAUTH_CONSENT_TEXT };

export const signInFailed = () =>
	new ApiError('unauthenticated', 'The sign-in could not be completed');

// #endregion

// #region profiles

const githubUser = z.object({ id: z.number(), name: z.string().nullable().optional() });
const githubEmails = z.array(
	z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() })
);
const oidcUserinfo = z.object({
	sub: z.string().min(1),
	name: z.string().nullish(),
	email: z.string().nullish(),
	email_verified: z.boolean().nullish()
});
const microsoftClaims = z.object({
	sub: z.string().min(1),
	aud: z.union([z.string(), z.array(z.string())]),
	name: z.string().nullish(),
	email: z.string().nullish(),
	xms_edov: z.union([z.boolean(), z.string()]).nullish()
});

async function getJson<T extends z.ZodType>(
	fetchFn: FetchLike,
	url: string,
	token: string,
	schema: T
): Promise<z.infer<T>> {
	const response = await fetchFn(url, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/json',
			'user-agent': 'drupflare'
		}
	});
	if (!response.ok) throw signInFailed();
	return schema.parse(await response.json());
}

// only a verified primary address counts, and only when the user granted the email scope
async function githubProfile(tokens: ProviderTokens, fetchFn: FetchLike): Promise<ProviderProfile> {
	if (tokens.scopes && !tokens.scopes.includes('user:email')) throw signInFailed();
	const user = await getJson(
		fetchFn,
		'https://api.github.com/user',
		tokens.accessToken,
		githubUser
	);
	const emails = await getJson(
		fetchFn,
		'https://api.github.com/user/emails',
		tokens.accessToken,
		githubEmails
	);
	const chosen = emails.find((entry) => entry.primary);
	return {
		subject: String(user.id),
		email: chosen?.email ?? null,
		emailVerified: chosen?.verified === true,
		name: user.name ?? null
	};
}

function userinfoProfile(url: string) {
	return async (tokens: ProviderTokens, fetchFn: FetchLike): Promise<ProviderProfile> => {
		const info = await getJson(fetchFn, url, tokens.accessToken, oidcUserinfo);
		return {
			subject: info.sub,
			email: info.email ?? null,
			emailVerified: info.email_verified === true,
			name: info.name ?? null
		};
	};
}

// the claim arrives as a boolean or as the strings 1 and true; anything else, or nothing, is false
export function edovVerified(claim: boolean | string | null | undefined): boolean {
	return claim === true || claim === '1' || claim === 'true';
}

// the email claim is not proof of ownership on Microsoft; only the domain-owner-verified claim is
function microsoftProfile(clientId: string) {
	return async (tokens: ProviderTokens): Promise<ProviderProfile> => {
		if (tokens.idToken === null) throw signInFailed();
		const claims = microsoftClaims.parse(decodeIdToken(tokens.idToken));
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!audiences.includes(clientId)) throw signInFailed();
		return {
			subject: claims.sub,
			email: claims.email ?? null,
			emailVerified: edovVerified(claims.xms_edov),
			name: claims.name ?? null
		};
	};
}

// #endregion

// #region clients

// github answers with commas and the others with spaces
function tokensOf(tokens: OAuth2Tokens): ProviderTokens {
	const granted = 'scope' in tokens.data ? tokens.data.scope : undefined;
	return {
		accessToken: tokens.accessToken(),
		idToken: 'id_token' in tokens.data ? tokens.idToken() : null,
		...(typeof granted === 'string' ? { scopes: granted.split(/[\s,]+/).filter(Boolean) } : {})
	};
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

// arctic's own GitHub and GitLab classes send no PKCE challenge, so these two use its OAuth2Client
function pkceClient(
	provider: 'github' | 'gitlab',
	creds: ProviderCredentials,
	authorizeUrl: string,
	tokenUrl: string,
	profile: OAuthClient['profile']
): OAuthClient {
	const client = new OAuth2Client(creds.clientId, creds.clientSecret, creds.redirectUri);
	const scopes = OAUTH_SCOPES[provider];
	return {
		scopes,
		authorizationUrl: (state, verifier) =>
			client.createAuthorizationURLWithPKCE(
				authorizeUrl,
				state,
				CodeChallengeMethod.S256,
				verifier,
				[...scopes]
			),
		async exchange(code, verifier) {
			return tokensOf(await client.validateAuthorizationCode(tokenUrl, code, verifier));
		},
		profile
	};
}

export function oauthClient(provider: OAuthProvider, creds: ProviderCredentials): OAuthClient {
	switch (provider) {
		case 'github':
			return pkceClient(
				'github',
				creds,
				'https://github.com/login/oauth/authorize',
				'https://github.com/login/oauth/access_token',
				githubProfile
			);
		case 'gitlab': {
			const base = trimSlash(creds.baseUrl ?? 'https://gitlab.com');
			return pkceClient(
				'gitlab',
				creds,
				`${base}/oauth/authorize`,
				`${base}/oauth/token`,
				userinfoProfile(`${base}/oauth/userinfo`)
			);
		}
		case 'google': {
			const google = new Google(creds.clientId, creds.clientSecret, creds.redirectUri);
			const scopes = OAUTH_SCOPES.google;
			return {
				scopes,
				authorizationUrl: (state, verifier) =>
					google.createAuthorizationURL(state, verifier, [...scopes]),
				async exchange(code, verifier) {
					return tokensOf(await google.validateAuthorizationCode(code, verifier));
				},
				profile: userinfoProfile('https://openidconnect.googleapis.com/v1/userinfo')
			};
		}
		case 'microsoft': {
			const microsoft = new MicrosoftEntraId(
				creds.tenant ?? 'common',
				creds.clientId,
				creds.clientSecret,
				creds.redirectUri
			);
			const scopes = OAUTH_SCOPES.microsoft;
			return {
				scopes,
				authorizationUrl: (state, verifier) =>
					microsoft.createAuthorizationURL(state, verifier, [...scopes]),
				async exchange(code, verifier) {
					return tokensOf(await microsoft.validateAuthorizationCode(code, verifier));
				},
				profile: microsoftProfile(creds.clientId)
			};
		}
	}
}

export function oauthClients(config: OAuthConfig): OAuthClients {
	const clients: OAuthClients = {};
	for (const provider of OAUTH_PROVIDERS) {
		const creds = config[provider];
		if (creds) clients[provider] = oauthClient(provider, creds);
	}
	return clients;
}

// #endregion

// #region state

export const OAUTH_STATE_COOKIE = '__Host-drupflare_oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const stateKey = (hash: string) => `oauth:state:${hash}`;

const stateRecord = z.object({
	provider: z.enum(OAUTH_PROVIDERS),
	verifier: z.string(),
	createdAt: z.number()
});

export interface OAuthDeps {
	once: OnceStore;
	clients: OAuthClients;
	fetch: FetchLike;
}

function clientFor(deps: OAuthDeps, provider: OAuthProvider): OAuthClient {
	const client = deps.clients[provider];
	if (!client) throw new ApiError('not_built', 'This sign-in method is not configured');
	return client;
}

export async function beginOAuth(
	deps: OAuthDeps,
	provider: OAuthProvider
): Promise<{ url: string; state: string }> {
	const client = clientFor(deps, provider);
	const state = stateFor(provider, randomToken());
	const verifier = generateCodeVerifier();
	const now = nowUtc().toMillis();
	const record = { provider, verifier, createdAt: now };
	await deps.once.put(
		stateKey(await sha256Hex(state)),
		JSON.stringify(record),
		now + OAUTH_STATE_TTL_MS
	);
	return { url: client.authorizationUrl(state, verifier).toString(), state };
}

// one atomic take before the code is exchanged, so a state works for one callback only
async function takeState(
	once: OnceStore,
	state: string
): Promise<z.infer<typeof stateRecord> | null> {
	const raw = await once.take(stateKey(await sha256Hex(state)), nowUtc().toMillis());
	if (raw === null) return null;
	try {
		const parsed = stateRecord.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		const age = nowUtc().toMillis() - parsed.data.createdAt;
		return age >= 0 && age < OAUTH_STATE_TTL_MS ? parsed.data : null;
	} catch {
		return null;
	}
}

export interface CallbackInput {
	code?: string;
	state?: string;
	error?: string;
	cookieState?: string;
}

export async function completeOAuth(
	deps: OAuthDeps,
	provider: OAuthProvider,
	input: CallbackInput
): Promise<ProviderProfile> {
	const client = clientFor(deps, provider);
	const { state, cookieState } = input;
	// the cookie ties the callback to the browser that started the flow
	if (!state || !cookieState || !timingSafeEqual(state, cookieState)) throw signInFailed();
	const record = await takeState(deps.once, state);
	if (record === null || record.provider !== provider) throw signInFailed();
	if (input.error) throw signInFailed();
	if (!input.code) throw new ApiError('validation', 'The provider did not return a code');
	try {
		const tokens = await client.exchange(input.code, record.verifier);
		return await client.profile(tokens, deps.fetch);
	} catch {
		throw signInFailed();
	}
}

// a short-lived cookie for the state and the pending link
export function setShortCookie(event: H3Event, name: string, value: string, ttlMs: number): void {
	setCookie(event, name, value, {
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		path: '/',
		maxAge: Math.floor(ttlMs / 1000)
	});
}

export function clearShortCookie(event: H3Event, name: string): void {
	deleteCookie(event, name, { secure: true, path: '/' });
}

// #endregion
