import { toBase64Url } from '@contracts/common';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { expect } from 'vitest';
import { DuplicateRowError } from '../../../../src/server/db/collegedb';
import type { OrgSsoRow } from '../../../../src/server/db/repos/org-sso';
import { createJwksCache } from '../../../../src/server/integrations/oidc';
import {
	beginSsoSignIn,
	completeSsoSignIn,
	configureSso,
	testSso,
	type SsoServices
} from '../../../../src/server/services/sso';
import { loadKeyRing } from '../../../../src/shared/custody/envelope';
import {
	ssoConfigBodySchema,
	ssoDomainRecord,
	type SsoConfigBody
} from '../../../../src/shared/sso';
import { memoryDirectory, memoryKv, memoryOnce, type useClock } from './auth-support';
import { memoryStore } from './identities-support';

export const ISSUER = 'https://idp.example.edu';
export const CLIENT_ID = 'drupflare-client';
export const CLIENT_SECRET = 'very-secret-client-value';
export const SLUG = 'example-edu';

export const env = {} as {
	clock: ReturnType<typeof useClock>;
	rsa: { privateKey: CryptoKey; jwk: JWK };
};

export async function makeKey(alg: string, kid: string) {
	const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
	return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } as JWK };
}

export async function makeRsa() {
	env.rsa = await makeKey('RS256', 'k1');
}

// #region fake identity provider

export class FakeIdp {
	keys: JWK[] = [env.rsa.jwk];
	discovery: Record<string, unknown> = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: `${ISSUER}/token`,
		jwks_uri: `${ISSUER}/keys`,
		id_token_signing_alg_values_supported: ['RS256', 'ES256'],
		code_challenge_methods_supported: ['S256']
	};
	discoveryBody: string | null = null;
	idToken = '';
	addresses = ['93.184.216.34'];
	requests: { url: string; method: string; body: string }[] = [];

	fetch = async (url: string, init: RequestInit) => {
		const method = init.method ?? 'GET';
		this.requests.push({ url, method, body: String(init.body ?? '') });
		if (url === `${ISSUER}/.well-known/openid-configuration`) {
			return new Response(this.discoveryBody ?? JSON.stringify(this.discovery));
		}
		if (url === `${ISSUER}/keys`) return new Response(JSON.stringify({ keys: this.keys }));
		if (url === `${ISSUER}/token` && method === 'POST') {
			return new Response(JSON.stringify({ id_token: this.idToken }));
		}
		return new Response('{}', { status: 404 });
	};

	resolve = async () => this.addresses;

	async sign(
		claims: Record<string, unknown>,
		options: { key?: { privateKey: CryptoKey }; alg?: string; kid?: string } = {}
	) {
		const nowSeconds = Math.floor(env.clock.now / 1000);
		const body = {
			sub: 'user-1',
			email: 'ada@example.edu',
			email_verified: true,
			name: 'Ada',
			...claims
		};
		return new SignJWT(body)
			.setProtectedHeader({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'k1' })
			.setIssuer((claims.iss as string | undefined) ?? ISSUER)
			.setAudience((claims.aud as string | undefined) ?? CLIENT_ID)
			.setIssuedAt((claims.iat as number | undefined) ?? nowSeconds)
			.setExpirationTime((claims.exp as number | undefined) ?? nowSeconds + 300)
			.sign((options.key ?? env.rsa).privateKey);
	}
}

// #endregion

export interface Rig {
	idp: FakeIdp;
	services: SsoServices;
	directory: ReturnType<typeof memoryDirectory>;
	kv: ReturnType<typeof memoryKv>;
	once: ReturnType<typeof memoryOnce>;
	identities: ReturnType<typeof memoryStore>;
	rows: Map<string, OrgSsoRow>;
	// TXT answers by record name; the rig proves its own domains up front
	txt: Map<string, string[]>;
	notices: { to: string; summary: string }[];
	orgId: string;
	ownerId: string;
}

export async function rig(): Promise<Rig> {
	const idp = new FakeIdp();
	const directory = memoryDirectory();
	const owner = await directory.createUser('owner@example.edu');
	const { org } = await directory.ensurePersonalOrganization(owner);
	const kv = memoryKv();
	const once = memoryOnce();
	const identities = memoryStore();
	const rows = new Map<string, OrgSsoRow>();
	const notices: Rig['notices'] = [];
	const txt = new Map<string, string[]>();
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(7)) });
	const services: SsoServices = {
		store: {
			async get(orgId) {
				return rows.get(orgId) ?? null;
			},
			async getBySlug(slug) {
				return [...rows.values()].find((row) => row.slug === slug) ?? null;
			},
			async save(row) {
				const clash = [...rows.values()].find(
					(other) =>
						other.slug === row.slug && other.organizationId !== row.organizationId
				);
				if (clash) throw new DuplicateRowError('UNIQUE constraint failed: org_sso.slug');
				rows.set(row.organizationId, row);
			},
			async markVerified(orgId, at) {
				const row = rows.get(orgId);
				if (row) rows.set(orgId, { ...row, lastVerifiedAt: at });
			}
		},
		members: {
			async find(orgId, userId) {
				const member = directory.members.find(
					(item) => item.organizationId === orgId && item.userId === userId
				);
				return member ? { id: member.id, role: member.role } : null;
			},
			async add(orgId, userId, role) {
				directory.members.push({
					id: `member-${directory.members.length + 100}`,
					organizationId: orgId,
					userId,
					role,
					createdAt: env.clock.now,
					updatedAt: env.clock.now
				});
			},
			async setRole(orgId, memberId, role) {
				const member = directory.members.find((item) => item.id === memberId);
				if (member) member.role = role;
			},
			async ownerEmails(orgId) {
				return directory.members
					.filter((item) => item.organizationId === orgId && item.role === 'owner')
					.flatMap((item) => directory.users.filter((user) => user.id === item.userId))
					.map((user) => user.email);
			}
		},
		identities,
		directory,
		kv,
		once,
		ring: async () => ring,
		oidc: {
			fetch: idp.fetch,
			resolve: idp.resolve,
			once,
			cache: createJwksCache(),
			now: () => env.clock.now
		},
		dns: {
			async query(name) {
				return {
					ok: true,
					records: (txt.get(name) ?? []).map((data) => ({ name, type: 'TXT', data }))
				};
			}
		},
		redirectUri: (slug) => `https://app.example.test/api/v1/auth/sso/${slug}/callback`,
		notify: async (to, summary) => {
			notices.push({ to, summary });
		},
		now: () => env.clock.now
	};
	for (const domain of ['example.edu', 'staff.example.edu']) {
		const record = ssoDomainRecord(org.id, domain);
		txt.set(record.name, [`"${record.value}"`]);
	}
	return {
		idp,
		services,
		directory,
		kv,
		once,
		identities,
		rows,
		txt,
		notices,
		orgId: org.id,
		ownerId: owner.id
	};
}

export const body = (over: Partial<SsoConfigBody> = {}): SsoConfigBody =>
	ssoConfigBodySchema.parse({
		slug: SLUG,
		issuer: ISSUER,
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		allowedDomains: ['example.edu'],
		roleMap: [
			{ group: 'web-admins', role: 'admin' },
			{ group: 'web-devs', role: 'developer' }
		],
		...over
	});

// configure, test and turn sign-in on
export async function enable(r: Rig, over: Partial<SsoConfigBody> = {}) {
	await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body(over) });
	expect((await testSso(r.services, { orgId: r.orgId, actorId: r.ownerId })).ok).toBe(true);
	await configureSso(r.services, {
		orgId: r.orgId,
		actorId: r.ownerId,
		body: body({ ...over, clientSecret: undefined, enabled: true })
	});
}

// runs begin and complete against the fake provider with the claims it would sign
export async function signIn(
	r: Rig,
	claims: Record<string, unknown> = {},
	options: Parameters<FakeIdp['sign']>[1] & { mutate?: (token: string) => string } = {}
) {
	const { url, state } = await beginSsoSignIn(r.services, SLUG);
	const nonce = new URL(url).searchParams.get('nonce') ?? '';
	const token = await r.idp.sign({ nonce, ...claims }, options);
	r.idp.idToken = options.mutate ? options.mutate(token) : token;
	return completeSsoSignIn(r.services, SLUG, { code: 'code-1', state, cookieState: state });
}

export async function failure(run: Promise<unknown>) {
	return run.then(
		() => null,
		(error: unknown) => error
	);
}
