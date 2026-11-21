import { sha256Hex } from '@contracts/common';
import { generateCodeVerifier } from 'arctic';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import { nowUtc } from '../../shared/utils/time';
import {
	CLOCK_SKEW_SECONDS,
	SsoError,
	checkClaims,
	trimIssuer,
	validateDiscovery,
	type Discovery,
	type SsoProfile
} from '../domain/sso';
import { randomToken, sha256Base64Url, timingSafeEqual } from '../services/crypto';
import type { OnceStore } from '../services/single-use';
import {
	UrlGuardError,
	guardedFetch,
	type FetchLike,
	type FetchLimits,
	type GuardDeps,
	type Resolver
} from './url-guard';

export const SSO_STATE_TTL_MS = 10 * 60 * 1000;
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;
export const JWKS_TTL_MS = 60 * 60 * 1000;
// an unknown key id refetches the key set, but never more often than this
export const JWKS_REFETCH_MS = 60 * 1000;

const DISCOVERY_LIMITS: FetchLimits = { maxRedirects: 2, maxBytes: 64 * 1024, timeoutMs: 5000 };
const JWKS_LIMITS: FetchLimits = { maxRedirects: 2, maxBytes: 256 * 1024, timeoutMs: 5000 };
const TOKEN_LIMITS: FetchLimits = { maxRedirects: 0, maxBytes: 64 * 1024, timeoutMs: 8000 };

export interface JwksCache {
	discovery: Map<string, { doc: Discovery; at: number }>;
	jwks: Map<string, { keys: JWK[]; at: number }>;
}

export const createJwksCache = (): JwksCache => ({ discovery: new Map(), jwks: new Map() });

export interface OidcDeps {
	fetch: FetchLike;
	resolve: Resolver;
	once: OnceStore;
	cache: JwksCache;
	now: () => number;
}

export interface OidcClient {
	issuer: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

// #region fetching

function guardOf(deps: OidcDeps, init?: RequestInit): GuardDeps {
	return {
		resolve: deps.resolve,
		fetch: (url, base) => deps.fetch(url, { ...base, ...init })
	};
}

async function getJson(
	deps: OidcDeps,
	url: string,
	limits: FetchLimits,
	failure: 'discovery' | 'jwks'
): Promise<unknown> {
	try {
		const response = await guardedFetch(url, guardOf(deps, { method: 'GET' }), limits);
		if (response.status !== 200) throw new SsoError(failure, 'The provider did not answer');
		return JSON.parse(new TextDecoder().decode(response.body));
	} catch (error) {
		if (error instanceof SsoError) throw error;
		if (error instanceof UrlGuardError) {
			throw new SsoError(failure, `The provider address was refused (${error.code})`);
		}
		throw new SsoError(failure, 'The provider answer could not be read');
	}
}

export async function discover(deps: OidcDeps, issuer: string): Promise<Discovery> {
	const key = trimIssuer(issuer);
	const cached = deps.cache.discovery.get(key);
	if (cached && deps.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
	if (!key.startsWith('https://')) throw new SsoError('discovery', 'The issuer must use https');
	const document = await getJson(
		deps,
		`${key}/.well-known/openid-configuration`,
		DISCOVERY_LIMITS,
		'discovery'
	);
	const doc = validateDiscovery(document, issuer);
	deps.cache.discovery.set(key, { doc, at: deps.now() });
	return doc;
}

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).max(50) });

async function loadJwks(deps: OidcDeps, uri: string): Promise<JWK[]> {
	const body = jwksSchema.safeParse(await getJson(deps, uri, JWKS_LIMITS, 'jwks'));
	if (!body.success) throw new SsoError('jwks', 'The key set is not valid');
	const keys = body.data.keys as JWK[];
	deps.cache.jwks.set(uri, { keys, at: deps.now() });
	return keys;
}

const pick = (keys: JWK[], kid: string | undefined): JWK | undefined => {
	const usable = keys.filter((key) => key.use !== 'enc');
	if (kid !== undefined) return usable.find((key) => key.kid === kid);
	return usable.length === 1 ? usable[0] : undefined;
};

async function keyFor(deps: OidcDeps, uri: string, kid: string | undefined): Promise<JWK> {
	const now = deps.now();
	const cached = deps.cache.jwks.get(uri);
	let keys = cached && now - cached.at < JWKS_TTL_MS ? cached.keys : await loadJwks(deps, uri);
	let found = pick(keys, kid);
	if (found) return found;
	const fetchedAt = deps.cache.jwks.get(uri)?.at ?? 0;
	if (now - fetchedAt >= JWKS_REFETCH_MS) {
		keys = await loadJwks(deps, uri);
		found = pick(keys, kid);
		if (found) return found;
	}
	throw new SsoError('token', 'The sign-in token was signed with an unknown key');
}

// discovery and one key set read; nothing signs in
export async function checkProvider(deps: OidcDeps, issuer: string): Promise<Discovery> {
	const doc = await discover(deps, issuer);
	await loadJwks(deps, doc.jwksUri);
	return doc;
}

// #endregion

// #region begin and complete

const stateKey = (hash: string) => `sso:state:${hash}`;

const stateRecord = z.object({
	orgId: z.string(),
	slug: z.string(),
	verifier: z.string(),
	nonce: z.string(),
	createdAt: z.number()
});

export type SsoState = z.infer<typeof stateRecord>;

export async function beginOidc(
	deps: OidcDeps,
	client: OidcClient,
	target: { orgId: string; slug: string }
): Promise<{ url: string; state: string }> {
	const doc = await discover(deps, client.issuer);
	const state = randomToken();
	const nonce = randomToken();
	const verifier = generateCodeVerifier();
	const now = deps.now();
	const record: SsoState = { ...target, verifier, nonce, createdAt: now };
	await deps.once.put(
		stateKey(await sha256Hex(state)),
		JSON.stringify(record),
		now + SSO_STATE_TTL_MS
	);
	const url = new URL(doc.authorizationEndpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', client.clientId);
	url.searchParams.set('redirect_uri', client.redirectUri);
	url.searchParams.set('scope', 'openid profile email');
	url.searchParams.set('state', state);
	url.searchParams.set('nonce', nonce);
	url.searchParams.set('code_challenge', await sha256Base64Url(verifier));
	url.searchParams.set('code_challenge_method', 'S256');
	return { url: url.toString(), state };
}

// one atomic take, so a state finishes one callback only
async function takeState(deps: OidcDeps, state: string): Promise<SsoState | null> {
	const raw = await deps.once.take(stateKey(await sha256Hex(state)), nowUtc().toMillis());
	if (raw === null) return null;
	try {
		const parsed = stateRecord.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		const age = deps.now() - parsed.data.createdAt;
		return age >= 0 && age < SSO_STATE_TTL_MS ? parsed.data : null;
	} catch {
		return null;
	}
}

const tokenReply = z.object({ id_token: z.string().min(1) });

async function exchange(
	deps: OidcDeps,
	doc: Discovery,
	client: OidcClient,
	code: string,
	verifier: string
): Promise<string> {
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		redirect_uri: client.redirectUri,
		code_verifier: verifier
	});
	const headers: Record<string, string> = {
		'content-type': 'application/x-www-form-urlencoded',
		accept: 'application/json'
	};
	if (doc.authMethod === 'basic') {
		const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
		headers.authorization = `Basic ${btoa(pair)}`;
	} else {
		form.set('client_id', client.clientId);
		form.set('client_secret', client.clientSecret);
	}
	try {
		const response = await guardedFetch(
			doc.tokenEndpoint,
			guardOf(deps, { method: 'POST', headers, body: form.toString() }),
			TOKEN_LIMITS
		);
		if (response.status !== 200) throw new SsoError('token', 'The provider refused the code');
		return tokenReply.parse(JSON.parse(new TextDecoder().decode(response.body))).id_token;
	} catch (error) {
		if (error instanceof SsoError) throw error;
		throw new SsoError('token', 'The provider did not return a sign-in token');
	}
}

export interface VerifiedSignIn {
	profile: SsoProfile;
	claims: Record<string, unknown>;
	state: SsoState;
}

export async function verifyIdToken(
	deps: OidcDeps,
	doc: Discovery,
	client: OidcClient,
	idToken: string,
	nonce: string
): Promise<{ profile: SsoProfile; claims: Record<string, unknown> }> {
	let header;
	try {
		header = decodeProtectedHeader(idToken);
	} catch {
		throw new SsoError('token', 'The sign-in token is not valid');
	}
	if (typeof header.alg !== 'string' || !doc.algorithms.includes(header.alg)) {
		throw new SsoError('token', 'The sign-in token uses an algorithm we do not accept');
	}
	const jwk = await keyFor(deps, doc.jwksUri, header.kid);
	try {
		const key = await importJWK(jwk, header.alg);
		const { payload } = await jwtVerify(idToken, key, {
			issuer: doc.issuer,
			audience: client.clientId,
			algorithms: doc.algorithms,
			currentDate: new Date(deps.now()),
			clockTolerance: CLOCK_SKEW_SECONDS,
			requiredClaims: ['exp', 'iat', 'sub']
		});
		const profile = checkClaims(payload as Record<string, unknown>, {
			nonce,
			clientId: client.clientId,
			nowSeconds: Math.floor(deps.now() / 1000)
		});
		return { profile, claims: payload as Record<string, unknown> };
	} catch (error) {
		if (error instanceof SsoError) throw error;
		throw new SsoError('token', 'The sign-in token did not pass the checks');
	}
}

export async function completeOidc(
	deps: OidcDeps,
	client: OidcClient,
	expect: { slug: string },
	input: { code?: string; state?: string; error?: string; cookieState?: string }
): Promise<VerifiedSignIn> {
	const { state, cookieState } = input;
	if (!state || !cookieState || !timingSafeEqual(state, cookieState)) {
		throw new SsoError('state', 'The sign-in did not start in this browser');
	}
	const record = await takeState(deps, state);
	if (record === null || record.slug !== expect.slug) {
		throw new SsoError('state', 'The sign-in link has expired or was already used');
	}
	if (input.error || !input.code) throw new SsoError('token', 'The provider did not sign you in');
	const doc = await discover(deps, client.issuer);
	const idToken = await exchange(deps, doc, client, input.code, record.verifier);
	const verified = await verifyIdToken(deps, doc, client, idToken, record.nonce);
	return { ...verified, state: record };
}

// #endregion
