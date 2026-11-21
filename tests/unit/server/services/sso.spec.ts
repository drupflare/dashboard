import { toBase64Url } from '@contracts/common';
import { SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	SsoError,
	checkClaims,
	emailDomainAllowed,
	mapRole,
	validateDiscovery
} from '../../../../src/server/domain/sso';
import { JWKS_REFETCH_MS } from '../../../../src/server/integrations/oidc';
import { LINK_COOKIE } from '../../../../src/server/services/identities';
import { getSession } from '../../../../src/server/services/sessions';
import {
	beginSsoSignIn,
	completeSsoSignIn,
	configureSso,
	getSso,
	testSso
} from '../../../../src/server/services/sso';
import { ApiError } from '../../../../src/shared/errors';
import { SSO_SESSION_MAX_MS } from '../../../../src/shared/sso';
import { T0, useClock } from './auth-support';
import {
	CLIENT_ID,
	CLIENT_SECRET,
	ISSUER,
	SLUG,
	body,
	enable,
	env,
	failure,
	makeKey,
	makeRsa,
	rig,
	signIn
} from './sso-support';

let clock: ReturnType<typeof useClock>;

beforeAll(makeRsa);

beforeEach(() => {
	clock = useClock();
	env.clock = clock;
});

afterEach(() => clock.stop());

describe('organisation sign-in', () => {
	it('signs in a verified address, creates the account and a viewer membership, and caps the session', async () => {
		const r = await rig();
		await enable(r);
		const result = await signIn(r);
		expect(result.status).toBe('signed_in');
		if (result.status !== 'signed_in') return;
		expect(result.isNew).toBe(true);
		expect(result.user.email).toBe('ada@example.edu');
		expect(
			r.directory.members.find(
				(m) => m.userId === result.user.id && m.organizationId === r.orgId
			)?.role
		).toBe('viewer');
		expect(result.session.maxAgeMs).toBe(SSO_SESSION_MAX_MS);
		const actions = r.directory.audits
			.filter((a) => a.organizationId === r.orgId)
			.map((a) => a.input.action);
		expect(actions).toEqual(
			expect.arrayContaining([
				'org.sso.provision',
				'org.sso.sign-in',
				'org.sso.configure',
				'org.sso.test',
				'org.sso.enable'
			])
		);
		clock.advance(SSO_SESSION_MAX_MS - 1000);
		expect(await getSession(r.kv, result.token)).not.toBeNull();
		clock.advance(2000);
		expect(await getSession(r.kv, result.token)).toBeNull();
	});

	it('sends the authorization request with state, nonce and an S256 challenge', async () => {
		const r = await rig();
		await enable(r);
		const { url } = await beginSsoSignIn(r.services, SLUG);
		const params = new URL(url).searchParams;
		expect(url.startsWith(`${ISSUER}/authorize`)).toBe(true);
		expect(params.get('code_challenge_method')).toBe('S256');
		expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(params.get('state')).toBeTruthy();
		expect(params.get('nonce')).toBeTruthy();
		expect(params.get('client_id')).toBe(CLIENT_ID);
	});

	it('maps a group to a role, takes the highest, and drops it at the next sign-in', async () => {
		const r = await rig();
		await enable(r);
		const first = await signIn(r, { groups: ['web-devs', 'web-admins'] });
		if (first.status !== 'signed_in') throw new Error('expected a sign-in');
		const member = () =>
			r.directory.members.find(
				(m) => m.userId === first.user.id && m.organizationId === r.orgId
			);
		expect(member()?.role).toBe('admin');
		await signIn(r, { groups: [] });
		expect(member()?.role).toBe('viewer');
		expect(r.directory.audits.some((a) => a.input.action === 'org.sso.role-change')).toBe(true);
	});

	it('never grants owner from a claim and never demotes an owner', async () => {
		const r = await rig();
		await enable(r);
		const stored = r.rows.get(r.orgId);
		if (!stored) throw new Error('missing row');
		r.rows.set(r.orgId, {
			...stored,
			roleMap: [{ group: 'everyone', role: 'owner' as never }]
		});
		const result = await signIn(r, { groups: ['everyone', 'owner'] });
		if (result.status !== 'signed_in') throw new Error('expected a sign-in');
		expect(
			r.directory.members.find(
				(m) => m.userId === result.user.id && m.organizationId === r.orgId
			)?.role
		).toBe('viewer');
		expect(mapRole(['owner'], [], 'viewer')).toBe('viewer');

		// an owner who signs in through the organisation keeps the role
		r.directory.members.find(
			(m) => m.userId === result.user.id && m.organizationId === r.orgId
		)!.role = 'owner';
		await signIn(r, { groups: [] });
		expect(
			r.directory.members.find(
				(m) => m.userId === result.user.id && m.organizationId === r.orgId
			)?.role
		).toBe('owner');
	});

	it.each([
		['the wrong issuer', { iss: 'https://evil.example.edu' }],
		['the wrong audience', { aud: 'someone-else' }],
		[
			'an expired token',
			{ exp: Math.floor(T0 / 1000) - 3600, iat: Math.floor(T0 / 1000) - 7200 }
		],
		[
			'an issue time in the future',
			{ iat: Math.floor(T0 / 1000) + 3600, exp: Math.floor(T0 / 1000) + 7200 }
		],
		['a different nonce', { nonce: 'not-the-nonce' }],
		['an unverified address', { email_verified: false }],
		['a verified flag sent as text', { email_verified: 'true' }],
		['no email', { email: undefined }]
	])('refuses %s', async (_name, claims) => {
		const r = await rig();
		await enable(r);
		const result = await failure(signIn(r, claims));
		expect(result).toBeInstanceOf(SsoError);
		expect(r.identities.identities).toHaveLength(0);
	});

	it('refuses a replayed state', async () => {
		const r = await rig();
		await enable(r);
		const { url, state } = await beginSsoSignIn(r.services, SLUG);
		const nonce = new URL(url).searchParams.get('nonce') ?? '';
		r.idp.idToken = await r.idp.sign({ nonce });
		const input = { code: 'c', state, cookieState: state };
		expect((await completeSsoSignIn(r.services, SLUG, input)).status).toBe('signed_in');
		expect(await failure(completeSsoSignIn(r.services, SLUG, input))).toBeInstanceOf(SsoError);
	});

	it('refuses a callback whose cookie does not match the state', async () => {
		const r = await rig();
		await enable(r);
		const { state } = await beginSsoSignIn(r.services, SLUG);
		const error = await failure(
			completeSsoSignIn(r.services, SLUG, { code: 'c', state, cookieState: 'other' })
		);
		expect(error).toBeInstanceOf(SsoError);
	});

	it('refuses alg none and an HS256 token keyed with the public key', async () => {
		const r = await rig();
		await enable(r);
		const none = await failure(
			signIn(
				r,
				{},
				{
					mutate: (token) => {
						const [, payload] = token.split('.');
						const header = toBase64Url(
							new TextEncoder().encode(JSON.stringify({ alg: 'none', kid: 'k1' }))
						);
						return `${header}.${payload}.`;
					}
				}
			)
		);
		expect(none).toBeInstanceOf(SsoError);

		const secret = new TextEncoder().encode(JSON.stringify(env.rsa.jwk));
		const { url, state } = await beginSsoSignIn(r.services, SLUG);
		const nonce = new URL(url).searchParams.get('nonce') ?? '';
		const now = Math.floor(clock.now / 1000);
		r.idp.idToken = await new SignJWT({
			sub: 'u',
			email: 'ada@example.edu',
			email_verified: true,
			nonce
		})
			.setProtectedHeader({ alg: 'HS256', kid: 'k1' })
			.setIssuer(ISSUER)
			.setAudience(CLIENT_ID)
			.setIssuedAt(now)
			.setExpirationTime(now + 300)
			.sign(secret);
		const hs = await failure(
			completeSsoSignIn(r.services, SLUG, { code: 'c', state, cookieState: state })
		);
		expect(hs).toBeInstanceOf(SsoError);
		expect(r.identities.identities).toHaveLength(0);
	});

	it('refetches the key set for an unknown key id, but not more often than once a minute', async () => {
		const r = await rig();
		await enable(r);
		await signIn(r);
		const rotated = await makeKey('ES256', 'k2');
		r.idp.keys = [rotated.jwk];
		const early = await failure(
			signIn(r, { sub: 'user-2' }, { key: rotated, alg: 'ES256', kid: 'k2' })
		);
		expect(early).toBeInstanceOf(SsoError);
		clock.advance(JWKS_REFETCH_MS + 1000);
		const later = await signIn(
			r,
			{ sub: 'user-2', email: 'grace@example.edu' },
			{ key: rotated, alg: 'ES256', kid: 'k2' }
		);
		expect(later.status).toBe('signed_in');
	});

	it('refuses an address outside the allowed domains, including a subdomain', async () => {
		const r = await rig();
		await enable(r);
		for (const email of [
			'ada@gmail.com',
			'ada@mail.example.edu',
			'ada@example.edu.evil.test'
		]) {
			const error = await failure(signIn(r, { email }));
			expect(error).toBeInstanceOf(SsoError);
			expect((error as SsoError).code).toBe('domain');
		}
		expect(r.identities.identities).toHaveLength(0);
	});

	it('does not merge into an existing account with the same address', async () => {
		const r = await rig();
		const existing = await r.directory.createUser('ada@example.edu');
		await r.directory.ensurePersonalOrganization(existing);
		await enable(r);
		const result = await signIn(r);
		expect(result.status).toBe('link_required');
		if (result.status !== 'link_required') return;
		expect(result.email).toBe('ada@example.edu');
		expect(r.identities.identities).toHaveLength(0);
		expect(
			r.directory.members.some(
				(m) => m.userId === existing.id && m.organizationId === r.orgId
			)
		).toBe(false);
		expect(Object.keys(r.once.dump()).some((key) => key.startsWith('link:pending:'))).toBe(
			true
		);
		expect(LINK_COOKIE).toContain('link');
	});

	it('signs in the same person again through the stored identity', async () => {
		const r = await rig();
		await enable(r);
		const first = await signIn(r);
		const second = await signIn(r);
		if (first.status !== 'signed_in' || second.status !== 'signed_in')
			throw new Error('expected sign-ins');
		expect(second.isNew).toBe(false);
		expect(second.user.id).toBe(first.user.id);
		expect(r.directory.users.filter((u) => u.email === 'ada@example.edu')).toHaveLength(1);
	});

	it('refuses to start when sign-in is off or the name is unknown', async () => {
		const r = await rig();
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		const off = await failure(beginSsoSignIn(r.services, SLUG));
		expect((off as ApiError).details).toMatchObject({ reason: 'disabled' });
		const unknown = await failure(beginSsoSignIn(r.services, 'nobody-here'));
		expect((unknown as ApiError).details).toMatchObject({ reason: 'unknown' });
	});
});

describe('organisation sign-in settings', () => {
	it('never returns or stores the client secret in the clear', async () => {
		const r = await rig();
		const saved = await configureSso(r.services, {
			orgId: r.orgId,
			actorId: r.ownerId,
			body: body()
		});
		const view = await getSso(r.services, r.orgId);
		for (const answer of [saved, view]) {
			expect(JSON.stringify(answer)).not.toContain(CLIENT_SECRET);
			expect(answer.secretSet).toBe(true);
		}
		expect(JSON.stringify([...r.rows.values()])).not.toContain(CLIENT_SECRET);
		expect(JSON.stringify(r.directory.audits)).not.toContain(CLIENT_SECRET);
	});

	it('keeps the stored secret when an update leaves it out', async () => {
		const r = await rig();
		await enable(r);
		const sealed = r.rows.get(r.orgId)?.clientSecretEnvelope;
		await configureSso(r.services, {
			orgId: r.orgId,
			actorId: r.ownerId,
			body: body({ clientSecret: undefined, enabled: true, roleMap: [] })
		});
		expect(r.rows.get(r.orgId)?.clientSecretEnvelope).toBe(sealed);
		expect(r.rows.get(r.orgId)?.enabled).toBe(true);
	});

	it('wants a passing test before it turns on, and again after the provider settings change', async () => {
		const r = await rig();
		const first = await failure(
			configureSso(r.services, {
				orgId: r.orgId,
				actorId: r.ownerId,
				body: body({ enabled: true })
			})
		);
		expect((first as ApiError).details).toMatchObject({ reason: 'untested' });
		await enable(r);
		const changed = await failure(
			configureSso(r.services, {
				orgId: r.orgId,
				actorId: r.ownerId,
				body: body({ clientSecret: undefined, clientId: 'another-client', enabled: true })
			})
		);
		expect((changed as ApiError).details).toMatchObject({ reason: 'untested' });
	});

	it('mails the owners and audits when sign-in is turned on and off', async () => {
		const r = await rig();
		await enable(r);
		expect(r.notices).toEqual([
			{ to: 'owner@example.edu', summary: expect.stringContaining('turned on') }
		]);
		await configureSso(r.services, {
			orgId: r.orgId,
			actorId: r.ownerId,
			body: body({ clientSecret: undefined, enabled: false })
		});
		expect(r.notices).toHaveLength(2);
		expect(r.notices[1]?.summary).toContain('turned off');
		const actions = r.directory.audits.map((a) => a.input.action);
		expect(actions).toEqual(expect.arrayContaining(['org.sso.enable', 'org.sso.disable']));
	});

	it('refuses a sign-in name another organisation holds', async () => {
		const r = await rig();
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		const error = await failure(
			configureSso(r.services, { orgId: 'org-other', actorId: r.ownerId, body: body() })
		);
		expect((error as ApiError).code).toBe('conflict');
	});

	it('reports a provider that resolves to a private address and does not fetch it', async () => {
		const r = await rig();
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		r.idp.addresses = ['10.0.0.5'];
		const result = await testSso(r.services, { orgId: r.orgId, actorId: r.ownerId });
		expect(result.ok).toBe(false);
		expect(r.idp.requests).toHaveLength(0);
		expect(r.rows.get(r.orgId)?.lastVerifiedAt).toBeNull();
	});

	it('reports a discovery document over the size cap', async () => {
		const r = await rig();
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		r.idp.discoveryBody = JSON.stringify({ padding: 'x'.repeat(70_000) });
		const result = await testSso(r.services, { orgId: r.orgId, actorId: r.ownerId });
		expect(result.ok).toBe(false);
	});

	it('refuses an issuer that is not https', async () => {
		const r = await rig();
		const error = await failure(
			configureSso(r.services, {
				orgId: r.orgId,
				actorId: r.ownerId,
				body: body({ issuer: 'http://idp.example.edu' })
			})
		);
		expect((error as ApiError).code).toBe('validation');
	});

	it('rejects owner in a role mapping at the schema', () => {
		expect(() => body({ roleMap: [{ group: 'x', role: 'owner' as never }] })).toThrow();
	});
});

describe('sign-in checks', () => {
	const doc = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/a`,
		token_endpoint: `${ISSUER}/t`,
		jwks_uri: `${ISSUER}/k`
	};

	it('reads a good discovery document and refuses a different issuer, plain http and a provider without S256', () => {
		expect(validateDiscovery(doc, `${ISSUER}/`).algorithms).toEqual([
			'RS256',
			'ES256',
			'EdDSA'
		]);
		expect(() =>
			validateDiscovery({ ...doc, issuer: 'https://other.example.edu' }, ISSUER)
		).toThrow(SsoError);
		expect(() =>
			validateDiscovery({ ...doc, token_endpoint: 'http://idp.example.edu/t' }, ISSUER)
		).toThrow(SsoError);
		expect(() =>
			validateDiscovery({ ...doc, code_challenge_methods_supported: ['plain'] }, ISSUER)
		).toThrow(SsoError);
		expect(() =>
			validateDiscovery(
				{ ...doc, id_token_signing_alg_values_supported: ['HS256', 'none'] },
				ISSUER
			)
		).toThrow(SsoError);
	});

	it('matches an email domain exactly', () => {
		expect(emailDomainAllowed('a@Example.edu', ['example.edu'])).toBe(true);
		expect(emailDomainAllowed('a@b@example.edu', ['example.edu'])).toBe(false);
		expect(emailDomainAllowed('example.edu', ['example.edu'])).toBe(false);
	});

	it('checks nonce, issue time, client and verified address', () => {
		const good = {
			sub: 's',
			email: 'A@Example.edu',
			email_verified: true,
			nonce: 'n',
			iat: 100
		};
		const expectation = { nonce: 'n', clientId: CLIENT_ID, nowSeconds: 100 };
		expect(checkClaims(good, expectation).email).toBe('a@example.edu');
		expect(() => checkClaims({ ...good, aud: ['a', 'b'] }, expectation)).toThrow(SsoError);
		expect(
			checkClaims({ ...good, aud: ['a', CLIENT_ID], azp: CLIENT_ID }, expectation).subject
		).toBe('s');
	});
});

describe('organisation sign-in: domain proof', () => {
	it('does not mark the connection tested while an allowed domain has no TXT record', async () => {
		const r = await rig();
		r.txt.clear();
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		const result = await testSso(r.services, { orgId: r.orgId, actorId: r.ownerId });
		expect(result.ok).toBe(false);
		expect(result.message).toContain(`_drupflare-sso.example.edu`);
		expect(result.message).toContain(`drupflare-sso=${r.orgId}`);
		expect(r.rows.get(r.orgId)?.lastVerifiedAt).toBeNull();
	});

	it('refuses a record that names another organisation', async () => {
		const r = await rig();
		r.txt.set('_drupflare-sso.example.edu', ['"drupflare-sso=org-someone-else"']);
		await configureSso(r.services, { orgId: r.orgId, actorId: r.ownerId, body: body() });
		expect((await testSso(r.services, { orgId: r.orgId, actorId: r.ownerId })).ok).toBe(false);
	});

	it('cannot turn sign-in on without a passing test, so an unproven domain never signs anyone in', async () => {
		const r = await rig();
		r.txt.clear();
		const error = await failure(
			configureSso(r.services, {
				orgId: r.orgId,
				actorId: r.ownerId,
				body: body({ enabled: true })
			})
		);
		expect((error as ApiError).code).toBe('conflict');
	});

	it('asks for another test when a domain is added, and keeps the test when one is removed', async () => {
		const r = await rig();
		await enable(r);
		const keep = { orgId: r.orgId, actorId: r.ownerId };
		const fewer = await configureSso(r.services, {
			...keep,
			body: body({ clientSecret: undefined, enabled: true, allowedDomains: ['example.edu'] })
		});
		expect(fewer.lastVerifiedAt).not.toBeNull();
		const error = await failure(
			configureSso(r.services, {
				...keep,
				body: body({
					clientSecret: undefined,
					enabled: true,
					allowedDomains: ['example.edu', 'other.example']
				})
			})
		);
		expect((error as ApiError).code).toBe('conflict');
	});
});

describe('organisation sign-in: address spelling', () => {
	it('does not let the Kelvin sign pass for a k in an allowed domain', () => {
		expect(emailDomainAllowed('x@Kent.edu', ['kent.edu'])).toBe(false);
		const claims = {
			sub: 's',
			email: 'x@Kent.edu',
			email_verified: true,
			nonce: 'n',
			iat: 100
		};
		expect(() =>
			checkClaims(claims, { nonce: 'n', clientId: CLIENT_ID, nowSeconds: 100 })
		).toThrow(SsoError);
	});
});
