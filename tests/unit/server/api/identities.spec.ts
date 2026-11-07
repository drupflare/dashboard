import type { EventHandler } from 'h3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ROOT, scanRoutes } from '../../../../scripts/gen-openapi';
import oauthCallback from '../../../../src/server/api/v1/auth/oauth/[provider]/callback.get';
import oauthStart from '../../../../src/server/api/v1/auth/oauth/[provider]/start.get';
import oauthProviders from '../../../../src/server/api/v1/auth/oauth/index.get';
import passkeyOptions from '../../../../src/server/api/v1/auth/passkey/options.post';
import passkeyVerify from '../../../../src/server/api/v1/auth/passkey/verify.post';
import identitiesGet from '../../../../src/server/api/v1/me/identities.get';
import identityDelete from '../../../../src/server/api/v1/me/identities/[id].delete';
import identityLink from '../../../../src/server/api/v1/me/identities/link.post';
import me from '../../../../src/server/api/v1/me/index.get';
import passkeysGet from '../../../../src/server/api/v1/me/passkeys.get';
import passkeyDelete from '../../../../src/server/api/v1/me/passkeys/[id].delete';
import passkeyRename from '../../../../src/server/api/v1/me/passkeys/[id].patch';
import passkeyRegister from '../../../../src/server/api/v1/me/passkeys/register.post';
import { OAUTH_STATE_COOKIE } from '../../../../src/server/integrations/oauth';
import { generateApiKey } from '../../../../src/server/services/api-keys';
import { LINK_COOKIE, setIdentityServices } from '../../../../src/server/services/identities';
import { SESSION_COOKIE_NAME, createSession } from '../../../../src/server/services/sessions';
import {
	createPrincipalResolver,
	kvKeyIndex,
	setAuthServices
} from '../../../../src/server/utils/auth';
import { isApiHandler, resetApiDeps } from '../../../../src/server/utils/define-api';
import { STEP_UP_WINDOW_MS } from '../../../../src/shared/permissions';
import { facts, fresh } from '../../domain/fixtures';
import {
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../fixtures/harness';
import { makeAuthenticator } from '../integrations/webauthn-support';
import { useClock } from '../services/auth-support';
import {
	RP,
	identityHarness,
	primeProfile,
	type IdentityHarness
} from '../services/identities-support';

const R = {
	providers: '/api/v1/auth/oauth',
	start: '/api/v1/auth/oauth/:provider/start',
	callback: '/api/v1/auth/oauth/:provider/callback',
	passkeyOptions: '/api/v1/auth/passkey/options',
	passkeyVerify: '/api/v1/auth/passkey/verify',
	me: '/api/v1/me',
	identities: '/api/v1/me/identities',
	link: '/api/v1/me/identities/link',
	identity: '/api/v1/me/identities/:id',
	passkeys: '/api/v1/me/passkeys',
	register: '/api/v1/me/passkeys/register',
	passkey: '/api/v1/me/passkeys/:id'
};

const send = (handler: EventHandler, route: string, req: Partial<RequestInit> = {}) =>
	sendRequest(handler, route, { path: route, ...req });

let clock: ReturnType<typeof useClock>;
let h: IdentityHarness;

function install(options: { emailFloor?: boolean; clients?: IdentityHarness['clients'] } = {}) {
	setIdentityServices({
		store: h.store,
		webauthn: RP,
		clients: options.clients ?? h.clients,
		fetch: h.fetch,
		...(options.emailFloor === undefined ? {} : { emailFloor: options.emailFloor })
	});
}

beforeEach(() => {
	clock = useClock();
	h = identityHarness();
	setAuthServices({ ...h, keys: kvKeyIndex(h.kv) });
	install();
	setup({
		deps: { resolvePrincipal: createPrincipalResolver() },
		facts: (input) =>
			facts({
				...fresh,
				...(input.principal.kind === 'key'
					? { key: { id: input.principal.keyId, scopes: ['account.read'] } }
					: {})
			})
	});
});

afterEach(() => {
	clock.stop();
	setAuthServices(null);
	setIdentityServices(null);
	resetApiDeps();
});

const PROFILE = { subject: '4242', email: 'ada@example.com', emailVerified: true, name: 'Ada' };

const cookies = (reply: Reply) => reply.headers.getSetCookie();

function cookieValue(reply: Reply, name: string): string | undefined {
	const line = cookies(reply).find((c) => c.startsWith(`${name}=`));
	return line?.slice(name.length + 1).split(';')[0];
}

const jar = (values: Record<string, string | undefined>) => ({
	cookie: Object.entries(values)
		.filter(([, value]) => value !== undefined)
		.map(([name, value]) => `${name}=${value}`)
		.join('; ')
});

async function existingUser(email = 'ada@example.com') {
	const user = await h.directory.createUser(email);
	await h.directory.ensurePersonalOrganization(user);
	return user;
}

async function signedInSession(userId: string, stepUp = true) {
	const issued = await createSession(h.kv, {
		userId,
		...(stepUp ? { stepUpAt: clock.now } : {})
	});
	return issued.token;
}

// start, then call back with the browser's cookie, as the callback page does
async function oauthRoundTrip(
	provider: 'github' | 'google' | 'gitlab' | 'microsoft',
	over: { query?: string; cookie?: string | null; profile?: typeof PROFILE } = {}
) {
	h.tokens[provider] = primeProfile(h.fetchLog, provider, over.profile ?? PROFILE);
	const started = await send(oauthStart, R.start, {
		path: `/api/v1/auth/oauth/${provider}/start`
	});
	expect(started.status).toBe(200);
	const state = cookieValue(started, OAUTH_STATE_COOKIE) as string;
	return send(oauthCallback, R.callback, {
		path: `/api/v1/auth/oauth/${provider}/callback?${over.query ?? `code=abc&state=${state}`}`,
		headers: over.cookie === null ? {} : jar({ [OAUTH_STATE_COOKIE]: over.cookie ?? state })
	});
}

describe('GET /auth/oauth', () => {
	it('lists only the providers that have a client, and is never cached', async () => {
		const reply = await send(oauthProviders, R.providers);
		expect(reply.status).toBe(200);
		expect((reply.json as { providers: string[] }).providers.sort()).toEqual(
			Object.keys(h.clients).sort()
		);
		expect(reply.headers.get('cache-control')).toBe('no-store');
	});

	it('lists nothing when no provider is set up', async () => {
		install({ clients: {} });
		const reply = await send(oauthProviders, R.providers);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ providers: [] });
	});

	it('answers 501 before the services are installed', async () => {
		setIdentityServices(null);
		expect((await send(oauthProviders, R.providers)).status).toBe(501);
	});
});

describe('GET /auth/oauth/:provider/start', () => {
	it('returns the provider url and the consent text, and sets a host-bound state cookie', async () => {
		const reply = await send(oauthStart, R.start, { path: '/api/v1/auth/oauth/github/start' });
		expect(reply.status).toBe(200);
		const body = reply.json as { url: string; consent: string };
		const url = new URL(body.url);
		expect(url.host).toBe('github.com');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(body.consent).toContain('name and email');
		const line = cookies(reply).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`)) as string;
		expect(line.slice(OAUTH_STATE_COOKIE.length + 1).split(';')[0]).toBe(
			url.searchParams.get('state')
		);
		expect(line).toMatch(/Max-Age=600/);
		expect(line).toMatch(/HttpOnly/);
		expect(line).toMatch(/Secure/);
		expect(line).toMatch(/SameSite=Lax/);
		expect(line).toMatch(/Path=\//);
		expect(line).not.toMatch(/Domain/);
		expect(reply.headers.get('cache-control')).toBe('no-store');
	});

	it('answers 400 for an unknown provider', async () => {
		const reply = await send(oauthStart, R.start, {
			path: '/api/v1/auth/oauth/facebook/start'
		});
		expect(reply.status).toBe(400);
	});

	it('answers 501 for a provider with no client', async () => {
		install({ clients: {} });
		const reply = await send(oauthStart, R.start, { path: '/api/v1/auth/oauth/github/start' });
		expect(reply.status).toBe(501);
		expect(cookies(reply)).toEqual([]);
	});

	it('answers 501 before the services are installed', async () => {
		setIdentityServices(null);
		const reply = await send(oauthStart, R.start, { path: '/api/v1/auth/oauth/github/start' });
		expect(reply.status).toBe(501);
	});
});

describe('GET /auth/oauth/:provider/callback', () => {
	it.each(['github', 'gitlab', 'google', 'microsoft'] as const)(
		'%s signs a new person in, sets the session cookie and never returns the token',
		async (provider) => {
			const reply = await oauthRoundTrip(provider);
			expect(reply.status).toBe(200);
			expect(reply.json).toMatchObject({
				status: 'signed_in',
				isNew: true,
				user: { email: 'ada@example.com' }
			});
			const token = cookieValue(reply, SESSION_COOKIE_NAME) as string;
			expect(token).toHaveLength(43);
			expect(reply.text).not.toContain(token);
			const line = cookies(reply).find((c) => c.startsWith(SESSION_COOKIE_NAME)) as string;
			expect(line).toMatch(/Secure/);
			expect(line).toMatch(/HttpOnly/);
			const whoami = await send(me, R.me, { headers: jar({ [SESSION_COOKIE_NAME]: token }) });
			expect(whoami.status).toBe(200);
			expect(h.directory.users).toHaveLength(1);
		}
	);

	it('clears the state cookie whether or not the sign-in works', async () => {
		const ok = await oauthRoundTrip('github');
		expect(cookies(ok).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))).toMatch(
			/Max-Age=0/
		);
		const bad = await oauthRoundTrip('github', { cookie: 'someone-elses' });
		expect(cookies(bad).find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))).toMatch(
			/Max-Age=0/
		);
	});

	it('asks for a link and signs nobody in when the email belongs to an account', async () => {
		await existingUser();
		const reply = await oauthRoundTrip('github');
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			status: 'link_required',
			provider: 'github',
			email: 'ada@example.com'
		});
		expect(cookieValue(reply, SESSION_COOKIE_NAME)).toBeUndefined();
		const link = cookies(reply).find((c) => c.startsWith(`${LINK_COOKIE}=`)) as string;
		expect(link).toMatch(/Max-Age=900/);
		expect(link).toMatch(/HttpOnly/);
		expect(link).toMatch(/Secure/);
		expect(h.store.identities).toEqual([]);
		expect(h.directory.users).toHaveLength(1);
	});

	it('answers 401 when the cookie belongs to another browser, and calls nothing', async () => {
		const reply = await oauthRoundTrip('github', { cookie: 'someone-elses' });
		expect(reply.status).toBe(401);
		expect(reply.json).toMatchObject({ code: 'unauthenticated' });
		expect(cookieValue(reply, SESSION_COOKIE_NAME)).toBeUndefined();
		expect(h.exchanges).toEqual([]);
		expect(h.directory.users).toEqual([]);
	});

	it('answers 401 when there is no cookie', async () => {
		const reply = await oauthRoundTrip('github', { cookie: null });
		expect(reply.status).toBe(401);
	});

	it('answers 401 on a replayed callback', async () => {
		h.tokens.github = primeProfile(h.fetchLog, 'github', PROFILE);
		const started = await send(oauthStart, R.start, {
			path: '/api/v1/auth/oauth/github/start'
		});
		const state = cookieValue(started, OAUTH_STATE_COOKIE) as string;
		const call = () =>
			send(oauthCallback, R.callback, {
				path: `/api/v1/auth/oauth/github/callback?code=abc&state=${state}`,
				headers: jar({ [OAUTH_STATE_COOKIE]: state })
			});
		expect((await call()).status).toBe(200);
		expect((await call()).status).toBe(401);
		expect(h.directory.users).toHaveLength(1);
	});

	it('answers 400 for a missing code', async () => {
		const started = await send(oauthStart, R.start, {
			path: '/api/v1/auth/oauth/github/start'
		});
		const state = cookieValue(started, OAUTH_STATE_COOKIE) as string;
		const reply = await send(oauthCallback, R.callback, {
			path: `/api/v1/auth/oauth/github/callback?state=${state}`,
			headers: jar({ [OAUTH_STATE_COOKIE]: state })
		});
		expect(reply.status).toBe(400);
	});

	it('answers 401 when the provider reports an error', async () => {
		const started = await send(oauthStart, R.start, {
			path: '/api/v1/auth/oauth/github/start'
		});
		const state = cookieValue(started, OAUTH_STATE_COOKIE) as string;
		const reply = await send(oauthCallback, R.callback, {
			path: `/api/v1/auth/oauth/github/callback?error=access_denied&state=${state}`,
			headers: jar({ [OAUTH_STATE_COOKIE]: state })
		});
		expect(reply.status).toBe(401);
		expect(h.exchanges).toEqual([]);
	});

	it('answers 403 with the reason for an unverified provider email', async () => {
		const reply = await oauthRoundTrip('google', {
			profile: { ...PROFILE, emailVerified: false }
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'verified-email' } });
		expect(h.directory.users).toEqual([]);
	});

	it('answers 400 for an unknown provider', async () => {
		const reply = await send(oauthCallback, R.callback, {
			path: '/api/v1/auth/oauth/facebook/callback?code=a&state=b'
		});
		expect(reply.status).toBe(400);
	});
});

describe('link confirmation through the routes', () => {
	async function linkRequired() {
		const owner = await existingUser();
		const reply = await oauthRoundTrip('github');
		expect(reply.json).toMatchObject({ status: 'link_required' });
		return { owner, linkToken: cookieValue(reply, LINK_COOKIE) as string };
	}

	it('links the provider, clears the link cookie and lets the provider sign in afterwards', async () => {
		const { owner, linkToken } = await linkRequired();
		const session = await signedInSession(owner.id);
		const reply = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({ [SESSION_COOKIE_NAME]: session, [LINK_COOKIE]: linkToken })
		});
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({ identity: { provider: 'github', verified: true } });
		expect(cookies(reply).find((c) => c.startsWith(`${LINK_COOKIE}=`))).toMatch(/Max-Age=0/);
		const again = await oauthRoundTrip('github');
		expect(again.json).toMatchObject({ status: 'signed_in', isNew: false });
		expect(h.directory.users).toHaveLength(1);
	});

	it('answers 403 with the step-up requirement and keeps the pending link', async () => {
		const { owner, linkToken } = await linkRequired();
		const stale = await signedInSession(owner.id, false);
		const first = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({ [SESSION_COOKIE_NAME]: stale, [LINK_COOKIE]: linkToken })
		});
		expect(first.status).toBe(403);
		expect(first.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(h.store.identities).toEqual([]);
		const fresh = await signedInSession(owner.id);
		const second = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({ [SESSION_COOKIE_NAME]: fresh, [LINK_COOKIE]: linkToken })
		});
		expect(second.status).toBe(201);
	});

	it('answers 403 once the fresh window has passed', async () => {
		const { owner, linkToken } = await linkRequired();
		const session = await signedInSession(owner.id);
		clock.advance(STEP_UP_WINDOW_MS + 1);
		const reply = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({ [SESSION_COOKIE_NAME]: session, [LINK_COOKIE]: linkToken })
		});
		expect(reply.status).toBe(403);
	});

	it('answers 404 with no link cookie', async () => {
		const owner = await existingUser();
		const reply = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({ [SESSION_COOKIE_NAME]: await signedInSession(owner.id) })
		});
		expect(reply.status).toBe(404);
	});

	it('answers 403 when another account confirms', async () => {
		const { linkToken } = await linkRequired();
		const other = await existingUser('grace@example.com');
		const reply = await send(identityLink, R.link, {
			method: 'POST',
			headers: jar({
				[SESSION_COOKIE_NAME]: await signedInSession(other.id),
				[LINK_COOKIE]: linkToken
			})
		});
		expect(reply.status).toBe(403);
		expect(h.store.identities).toEqual([]);
	});

	it('answers 401 with no session', async () => {
		const reply = await send(identityLink, R.link, { method: 'POST' });
		expect(reply.status).toBe(401);
	});

	it('refuses an API key, since the action is session-only', async () => {
		const generated = await generateApiKey({
			scopes: ['account.read'],
			expiry: '30d',
			now: clock.now
		});
		await kvKeyIndex(h.kv).put(generated.data.lookupId, {
			keyId: 'key-1',
			issuerId: 'user-1',
			orgId: 'org-1',
			keyHash: generated.data.keyHash
		});
		const reply = await send(identityLink, R.link, {
			method: 'POST',
			headers: { authorization: `Bearer ${generated.token}` }
		});
		expect(reply.status).toBe(403);
	});
});

describe('identities', () => {
	it('lists linked providers and never the provider subject', async () => {
		const owner = await existingUser();
		await h.store.createIdentity({
			userId: owner.id,
			provider: 'github',
			providerSubject: 'secret-subject',
			email: owner.email,
			verified: true
		});
		const reply = await send(identitiesGet, R.identities, {
			headers: jar({ [SESSION_COOKIE_NAME]: await signedInSession(owner.id, false) })
		});
		expect(reply.status).toBe(200);
		expect((reply.json as { items: unknown[] }).items).toHaveLength(1);
		expect(reply.json).toMatchObject({
			items: [{ provider: 'github', email: 'ada@example.com', verified: true }],
			nextCursor: null
		});
		expect(reply.text).not.toContain('secret-subject');
	});

	it('answers 401 without a session', async () => {
		expect((await send(identitiesGet, R.identities)).status).toBe(401);
	});

	async function linkedIdentity() {
		const owner = await existingUser();
		const identity = await h.store.createIdentity({
			userId: owner.id,
			provider: 'github',
			providerSubject: 'x1',
			email: owner.email,
			verified: true
		});
		return { owner, identity };
	}

	it('unlinks with a fresh session', async () => {
		const { owner, identity } = await linkedIdentity();
		const reply = await send(identityDelete, R.identity, {
			method: 'DELETE',
			path: `/api/v1/me/identities/${identity.id}`,
			headers: jar({ [SESSION_COOKIE_NAME]: await signedInSession(owner.id) })
		});
		expect(reply.status).toBe(204);
		expect(h.store.identities).toEqual([]);
	});

	it('answers 403 for a session that has not stepped up', async () => {
		const { owner, identity } = await linkedIdentity();
		const reply = await send(identityDelete, R.identity, {
			method: 'DELETE',
			path: `/api/v1/me/identities/${identity.id}`,
			headers: jar({ [SESSION_COOKIE_NAME]: await signedInSession(owner.id, false) })
		});
		expect(reply.status).toBe(403);
		expect(h.store.identities).toHaveLength(1);
	});

	it('answers 409 for the last sign-in method', async () => {
		install({ emailFloor: false });
		const { owner, identity } = await linkedIdentity();
		const reply = await send(identityDelete, R.identity, {
			method: 'DELETE',
			path: `/api/v1/me/identities/${identity.id}`,
			headers: jar({ [SESSION_COOKIE_NAME]: await signedInSession(owner.id) })
		});
		expect(reply.status).toBe(409);
		expect(h.store.identities).toHaveLength(1);
	});

	it('answers 404 for another user identity and 400 for a malformed id', async () => {
		const { identity } = await linkedIdentity();
		const other = await existingUser('grace@example.com');
		const headers = jar({ [SESSION_COOKIE_NAME]: await signedInSession(other.id) });
		const del = (id: string) =>
			send(identityDelete, R.identity, {
				method: 'DELETE',
				path: `/api/v1/me/identities/${id}`,
				headers
			});
		expect((await del(identity.id)).status).toBe(404);
		expect((await del('nope')).status).toBe(400);
		expect(h.store.identities).toHaveLength(1);
	});
});

describe('passkeys through the routes', () => {
	let userId: string;
	let session: string;

	beforeEach(async () => {
		userId = (await existingUser()).id;
		session = await signedInSession(userId);
	});

	const asUser = () => jar({ [SESSION_COOKIE_NAME]: session });

	async function registerKey(key: Awaited<ReturnType<typeof makeAuthenticator>>, name?: string) {
		const asked = await send(passkeyRegister, R.register, {
			method: 'POST',
			headers: asUser(),
			json: { phase: 'options' }
		});
		expect(asked.status).toBe(200);
		const options = (asked.json as { options: { challenge: string } }).options;
		return send(passkeyRegister, R.register, {
			method: 'POST',
			headers: asUser(),
			json: { phase: 'verify', response: await key.register(options), name }
		});
	}

	it('registers a passkey and lists it without the key material', async () => {
		const key = await makeAuthenticator(RP);
		const reply = await registerKey(key, 'Work laptop');
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			passkey: { id: key.credentialId, name: 'Work laptop' }
		});
		const list = await send(passkeysGet, R.passkeys, { headers: asUser() });
		expect(list.json).toMatchObject({
			items: [{ id: key.credentialId, name: 'Work laptop', lastUsedAt: null }],
			nextCursor: null
		});
		expect(list.text).not.toContain(h.store.passkeys[0]?.publicKey);
		expect(h.directory.audits.at(-1)?.input.action).toBe('account.passkey.add');
	});

	it('needs a fresh session for the options call', async () => {
		session = await signedInSession(userId, false);
		const reply = await send(passkeyRegister, R.register, {
			method: 'POST',
			headers: asUser(),
			json: { phase: 'options' }
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
	});

	it('answers 400 for a body with no phase and for a verify with no response', async () => {
		for (const json of [{}, { phase: 'verify' }, { phase: 'nope' }]) {
			const reply = await send(passkeyRegister, R.register, {
				method: 'POST',
				headers: asUser(),
				json
			});
			expect(reply.status).toBe(400);
		}
	});

	it('answers 400 for a credential signed for another origin', async () => {
		const evil = await makeAuthenticator({ ...RP, origin: 'https://evil.example.com' });
		const reply = await registerKey(evil);
		expect(reply.status).toBe(400);
		expect(h.store.passkeys).toEqual([]);
	});

	it('answers 401 with no session', async () => {
		const reply = await send(passkeyRegister, R.register, {
			method: 'POST',
			json: { phase: 'options' }
		});
		expect(reply.status).toBe(401);
		expect((await send(passkeysGet, R.passkeys)).status).toBe(401);
	});

	it('renames a passkey without a fresh session and writes an audit row', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key, 'Work laptop');
		session = await signedInSession(userId, false);
		const reply = await send(passkeyRename, R.passkey, {
			method: 'PATCH',
			path: `/api/v1/me/passkeys/${key.credentialId}`,
			headers: asUser(),
			json: { name: 'Phone' }
		});
		expect(reply.status).toBe(204);
		expect(h.store.passkeys[0]?.name).toBe('Phone');
		expect(h.directory.audits.at(-1)?.input.action).toBe('account.passkey.rename');
	});

	it('answers 404 renaming another user passkey and 400 for an empty name', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key, 'Work laptop');
		const other = await existingUser('grace@example.com');
		const headers = jar({ [SESSION_COOKIE_NAME]: await signedInSession(other.id) });
		const rename = (json: unknown, who = headers) =>
			send(passkeyRename, R.passkey, {
				method: 'PATCH',
				path: `/api/v1/me/passkeys/${key.credentialId}`,
				headers: who,
				json
			});
		expect((await rename({ name: 'Mine now' })).status).toBe(404);
		expect((await rename({ name: '' }, asUser())).status).toBe(400);
		expect(h.store.passkeys[0]?.name).toBe('Work laptop');
	});

	it('removes a passkey with a fresh session and refuses a stale one', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key);
		const remove = (headers: ReturnType<typeof jar>) =>
			send(passkeyDelete, R.passkey, {
				method: 'DELETE',
				path: `/api/v1/me/passkeys/${key.credentialId}`,
				headers
			});
		const stale = jar({ [SESSION_COOKIE_NAME]: await signedInSession(userId, false) });
		expect((await remove(stale)).status).toBe(403);
		expect(h.store.passkeys).toHaveLength(1);
		expect((await remove(asUser())).status).toBe(204);
		expect(h.store.passkeys).toEqual([]);
		expect(h.directory.audits.at(-1)?.input.action).toBe('account.passkey.remove');
	});

	it('answers 409 removing the last sign-in method and 404 for another user passkey', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key);
		const remove = (headers: ReturnType<typeof jar>) =>
			send(passkeyDelete, R.passkey, {
				method: 'DELETE',
				path: `/api/v1/me/passkeys/${key.credentialId}`,
				headers
			});
		const other = await existingUser('grace@example.com');
		expect(
			(await remove(jar({ [SESSION_COOKIE_NAME]: await signedInSession(other.id) }))).status
		).toBe(404);
		install({ emailFloor: false });
		expect((await remove(asUser())).status).toBe(409);
		expect(h.store.passkeys).toHaveLength(1);
	});

	it('signs in with the registered passkey and refuses a replay', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key);
		const asked = await send(passkeyOptions, R.passkeyOptions, { method: 'POST' });
		expect(asked.status).toBe(200);
		expect(asked.headers.get('cache-control')).toBe('no-store');
		const options = asked.json as { challenge: string; userVerification: string };
		expect(options.userVerification).toBe('required');
		const assertion = await key.assert(options, userId);
		const verified = await send(passkeyVerify, R.passkeyVerify, {
			method: 'POST',
			json: assertion
		});
		expect(verified.status).toBe(200);
		expect(verified.json).toMatchObject({ isNew: false, user: { id: userId } });
		const token = cookieValue(verified, SESSION_COOKIE_NAME) as string;
		expect(verified.text).not.toContain(token);
		expect(
			(await send(me, R.me, { headers: jar({ [SESSION_COOKIE_NAME]: token }) })).status
		).toBe(200);
		const replay = await send(passkeyVerify, R.passkeyVerify, {
			method: 'POST',
			json: assertion
		});
		expect(replay.status).toBe(401);
		expect(cookieValue(replay, SESSION_COOKIE_NAME)).toBeUndefined();
	});

	it('answers every failed sign-in with the same body', async () => {
		const key = await makeAuthenticator(RP);
		await registerKey(key);
		const asked = (await send(passkeyOptions, R.passkeyOptions, { method: 'POST' })).json as {
			challenge: string;
		};
		const stranger = await makeAuthenticator(RP);
		const bodies = new Set<string>();
		for (const assertion of [
			await stranger.assert(asked, userId),
			await key.assert(asked, userId, { origin: 'https://evil.example.com' }),
			await key.assert({ challenge: 'AAAA' }, userId)
		]) {
			const reply = await send(passkeyVerify, R.passkeyVerify, {
				method: 'POST',
				json: assertion
			});
			expect(reply.status).toBe(401);
			bodies.add(JSON.stringify({ ...(reply.json as object), requestId: 'x' }));
		}
		expect(bodies.size).toBe(1);
	});

	it('answers 400 for a malformed assertion body', async () => {
		const reply = await send(passkeyVerify, R.passkeyVerify, {
			method: 'POST',
			json: { id: 'x' }
		});
		expect(reply.status).toBe(400);
	});

	it('answers 501 before the services are installed', async () => {
		setIdentityServices(null);
		expect((await send(passkeyOptions, R.passkeyOptions, { method: 'POST' })).status).toBe(501);
	});
});

describe('route scan', () => {
	it('lists every provider and passkey route with the expected action, all through defineApi', async () => {
		const { routes, problems } = await scanRoutes(API_ROOT);
		expect(problems).toEqual([]);
		const found = Object.fromEntries(
			routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r.meta.action])
		);
		expect(found).toMatchObject({
			'POST /api/v1/auth/passkey/options': 'auth.passkey.options',
			'POST /api/v1/auth/passkey/verify': 'auth.passkey.verify',
			'GET /api/v1/auth/oauth': 'auth.oauth.providers',
			'GET /api/v1/auth/oauth/{provider}/start': 'auth.oauth.start',
			'GET /api/v1/auth/oauth/{provider}/callback': 'auth.oauth.callback',
			'GET /api/v1/me/identities': 'account.security.manage',
			'POST /api/v1/me/identities/link': 'account.security.manage',
			'DELETE /api/v1/me/identities/{id}': 'account.security.manage',
			'GET /api/v1/me/passkeys': 'account.security.manage',
			'POST /api/v1/me/passkeys/register': 'account.security.manage',
			'PATCH /api/v1/me/passkeys/{id}': 'account.security.manage',
			'DELETE /api/v1/me/passkeys/{id}': 'account.security.manage',
			'DELETE /api/v1/me/sessions': 'account.security.manage'
		});
		for (const handler of [
			passkeyOptions,
			passkeyVerify,
			oauthStart,
			oauthCallback,
			identitiesGet,
			identityLink,
			identityDelete,
			passkeysGet,
			passkeyRegister,
			passkeyRename,
			passkeyDelete
		]) {
			expect(isApiHandler(handler)).toBe(true);
		}
	});
});
