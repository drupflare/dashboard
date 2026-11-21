import { z } from 'zod';
import { SSO_CLAIM_ROLES, type SsoRole, type SsoRoleMap } from '../../shared/sso';

export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256', 'EdDSA'] as const;

export const CLOCK_SKEW_SECONDS = 60;

export class SsoError extends Error {
	readonly code: SsoErrorCode;

	constructor(code: SsoErrorCode, message: string) {
		super(message);
		this.name = 'SsoError';
		this.code = code;
	}
}

export type SsoErrorCode =
	| 'discovery'
	| 'jwks'
	| 'token'
	| 'claims'
	| 'domain'
	| 'unverified'
	| 'state'
	| 'not_configured';

// #region discovery

const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'must be https');

const discoverySchema = z.object({
	issuer: z.string(),
	authorization_endpoint: httpsUrl,
	token_endpoint: httpsUrl,
	jwks_uri: httpsUrl,
	id_token_signing_alg_values_supported: z.array(z.string()).optional(),
	code_challenge_methods_supported: z.array(z.string()).optional(),
	token_endpoint_auth_methods_supported: z.array(z.string()).optional()
});

export interface Discovery {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	algorithms: string[];
	authMethod: 'post' | 'basic';
}

export const trimIssuer = (issuer: string) => issuer.replace(/\/+$/, '');

// the issuer in the document must equal the address it was fetched for, or a different
// server could pose as the configured one
export function validateDiscovery(document: unknown, issuer: string): Discovery {
	const parsed = discoverySchema.safeParse(document);
	if (!parsed.success) throw new SsoError('discovery', 'The discovery document is not valid');
	const doc = parsed.data;
	if (trimIssuer(doc.issuer) !== trimIssuer(issuer)) {
		throw new SsoError('discovery', 'The discovery document names a different issuer');
	}
	const offered = doc.id_token_signing_alg_values_supported;
	const algorithms = offered
		? ID_TOKEN_ALGORITHMS.filter((alg) => offered.includes(alg))
		: [...ID_TOKEN_ALGORITHMS];
	if (algorithms.length === 0) {
		throw new SsoError('discovery', 'The provider signs tokens with no algorithm we accept');
	}
	const challenge = doc.code_challenge_methods_supported;
	if (challenge && !challenge.includes('S256')) {
		throw new SsoError('discovery', 'The provider does not support PKCE with S256');
	}
	const methods = doc.token_endpoint_auth_methods_supported;
	const authMethod =
		methods &&
		!methods.includes('client_secret_post') &&
		methods.includes('client_secret_basic')
			? 'basic'
			: 'post';
	return {
		issuer: doc.issuer,
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
		jwksUri: doc.jwks_uri,
		algorithms,
		authMethod
	};
}

// #endregion

// #region claims

const claimsSchema = z.object({
	sub: z.string().min(1).max(256),
	email: z.string().min(3).max(320).optional(),
	email_verified: z.unknown().optional(),
	name: z.string().max(256).nullish(),
	nonce: z.string().optional(),
	iat: z.number().optional(),
	azp: z.string().optional(),
	aud: z.union([z.string(), z.array(z.string())]).optional()
});

export interface SsoProfile {
	subject: string;
	email: string;
	name: string | null;
}

// signature, issuer, audience and expiry are the verifier's; these are the checks it does not do
export function checkClaims(
	claims: Record<string, unknown>,
	expect: { nonce: string; clientId: string; nowSeconds: number }
): SsoProfile {
	const parsed = claimsSchema.safeParse(claims);
	if (!parsed.success) throw new SsoError('claims', 'The sign-in token is missing a claim');
	const c = parsed.data;
	if (c.nonce !== expect.nonce) throw new SsoError('claims', 'The sign-in token does not match');
	if (c.iat === undefined || c.iat > expect.nowSeconds + CLOCK_SKEW_SECONDS) {
		throw new SsoError('claims', 'The sign-in token was issued in the future');
	}
	if (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== expect.clientId) {
		throw new SsoError('claims', 'The sign-in token was issued to another client');
	}
	if (c.email === undefined) throw new SsoError('unverified', 'The provider sent no email');
	// lower-casing folds some letters (the Kelvin sign) into ASCII, so a look-alike address would
	// become a real one; only plain ASCII addresses pass
	if (!/^[\x21-\x7e]+$/.test(c.email.trim())) {
		throw new SsoError('unverified', 'The provider sent an email address we cannot accept');
	}
	if (c.email_verified !== true) {
		throw new SsoError('unverified', 'The provider has not verified the email address');
	}
	return { subject: c.sub, email: c.email.trim().toLowerCase(), name: c.name ?? null };
}

// exact match on the part after the last @; a subdomain is a different domain
export function emailDomainAllowed(email: string, domains: readonly string[]): boolean {
	if (!/^[\x21-\x7e]+$/.test(email)) return false;
	const at = email.lastIndexOf('@');
	if (at <= 0 || email.indexOf('@') !== at) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return domains.some((allowed) => allowed.toLowerCase() === domain);
}

// #endregion

// #region roles

const RANK = new Map<SsoRole, number>(SSO_CLAIM_ROLES.map((role, index) => [role, index]));

export function groupsOf(claims: Record<string, unknown>, claimName: string): string[] {
	const value = claims[claimName];
	if (typeof value === 'string') return [value];
	return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

// the highest mapped role wins; a stored role outside the allowed set (an owner entry written
// by hand) is skipped, so a claim can never produce owner
export function mapRole(
	groups: readonly string[],
	roleMap: SsoRoleMap,
	defaultRole: SsoRole
): SsoRole {
	let best: SsoRole | null = null;
	for (const entry of roleMap) {
		if (!groups.includes(entry.group)) continue;
		const rank = RANK.get(entry.role);
		if (rank === undefined) continue;
		if (best === null || rank > (RANK.get(best) ?? -1)) best = entry.role;
	}
	return best ?? (RANK.has(defaultRole) ? defaultRole : 'viewer');
}

// #endregion
