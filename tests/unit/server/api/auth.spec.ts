import { defineEventHandler, type EventHandler } from 'h3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ROOT, scanRoutes } from '../../../../scripts/gen-openapi';
import codeRequest from '../../../../src/server/api/v1/auth/code/request.post';
import codeVerify from '../../../../src/server/api/v1/auth/code/verify.post';
import logout from '../../../../src/server/api/v1/auth/logout.post';
import stepUpRoute from '../../../../src/server/api/v1/auth/step-up.post';
import me from '../../../../src/server/api/v1/me/index.get';
import sessionsDelete from '../../../../src/server/api/v1/me/sessions.delete';
import sessionsGet from '../../../../src/server/api/v1/me/sessions.get';
import sessionDelete from '../../../../src/server/api/v1/me/sessions/[id].delete';
import { generateApiKey } from '../../../../src/server/services/api-keys';
import { CODE_RESEND_COOLDOWN_MS } from '../../../../src/server/services/email-codes';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE_NAME } from '../../../../src/server/services/sessions';
import {
	createPrincipalResolver,
	ensureLoggedIn,
	kvKeyIndex,
	setAuthServices
} from '../../../../src/server/utils/auth';
import { isApiHandler, resetApiDeps } from '../../../../src/server/utils/define-api';
import { SESSION_HINT_COOKIE } from '../../../../src/shared/session-hint';
import { facts, fresh } from '../../domain/fixtures';
import {
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../fixtures/harness';
import { harness, useClock, type Harness } from '../services/auth-support';

const ROUTES = {
	request: '/api/v1/auth/code/request',
	verify: '/api/v1/auth/code/verify',
	logout: '/api/v1/auth/logout',
	stepUp: '/api/v1/auth/step-up',
	me: '/api/v1/me',
	sessions: '/api/v1/me/sessions',
	session: '/api/v1/me/sessions/:id'
};

const send = (handler: EventHandler, route: string, req: Partial<RequestInit> = {}) =>
	sendRequest(handler, route, { path: route, ...req });

let clock: ReturnType<typeof useClock>;
let h: Harness;

beforeEach(() => {
	clock = useClock();
	h = harness();
	setAuthServices({ ...h, keys: kvKeyIndex(h.kv) });
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
	resetApiDeps();
});

const cookieHeader = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${token}` });

function setCookies(reply: Reply): string[] {
	return reply.headers.getSetCookie();
}

function expectHintCleared(reply: Reply): void {
	const hint = setCookies(reply).find((c) => c.startsWith(`${SESSION_HINT_COOKIE}=`)) as string;
	expect(hint).toMatch(/Max-Age=0/);
	expect(hint).toMatch(/Secure/);
	expect(hint).toMatch(/Path=\//);
}

function tokenFrom(reply: Reply): string {
	const line = setCookies(reply).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
	if (!line) throw new Error('no session cookie was set');
	return line.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0] as string;
}

async function signIn(email = 'ada@example.com') {
	const asked = await send(codeRequest, ROUTES.request, {
		method: 'POST',
		json: { email, turnstileToken: 'tok' }
	});
	expect(asked.status).toBe(202);
	const code = h.mail.lastCode();
	const verified = await send(codeVerify, ROUTES.verify, {
		method: 'POST',
		json: { email, code }
	});
	expect(verified.status).toBe(200);
	clock.advance(CODE_RESEND_COOLDOWN_MS);
	return { token: tokenFrom(verified), reply: verified, code };
}

describe('POST /api/v1/auth/code/request', () => {
	it('answers 202 and never echoes the code', async () => {
		const reply = await send(codeRequest, ROUTES.request, {
			method: 'POST',
			json: { email: 'ada@example.com', turnstileToken: 'tok' }
		});
		expect(reply.status).toBe(202);
		expect(reply.json).toEqual({ sent: true });
		expect(reply.text).not.toContain(h.mail.lastCode());
		expect(h.turnstileCalls[0]?.token).toBe('tok');
	});

	it('passes the Cloudflare address to the bot check', async () => {
		await send(codeRequest, ROUTES.request, {
			method: 'POST',
			headers: { 'cf-connecting-ip': '203.0.113.9' },
			json: { email: 'ada@example.com' }
		});
		expect(h.turnstileCalls[0]?.ip).toBe('203.0.113.9');
	});

	it('rejects a bad address with field paths', async () => {
		const reply = await send(codeRequest, ROUTES.request, {
			method: 'POST',
			json: { email: 'nope' }
		});
		expect(reply.status).toBe(400);
		expect(JSON.stringify(reply.json)).toContain('email');
		expect(h.mail.sent).toEqual([]);
	});

	it('answers 403 and sends nothing when the bot check fails', async () => {
		h.passTurnstile = false;
		const reply = await send(codeRequest, ROUTES.request, {
			method: 'POST',
			json: { email: 'ada@example.com' }
		});
		expect(reply.status).toBe(403);
		expect((reply.json as { details: unknown }).details).toEqual({ requires: 'challenge' });
		expect(h.mail.sent).toEqual([]);
	});

	it('answers 429 with the wait when a code was just sent', async () => {
		const call = () =>
			send(codeRequest, ROUTES.request, {
				method: 'POST',
				json: { email: 'ada@example.com' }
			});
		await call();
		const reply = await call();
		expect(reply.status).toBe(429);
		expect((reply.json as { details: unknown }).details).toEqual({
			retryAfterSeconds: CODE_RESEND_COOLDOWN_MS / 1000
		});
	});
});

describe('POST /api/v1/auth/code/verify', () => {
	it('signs in with a hardened cookie and a body that carries no token', async () => {
		const { reply, token, code } = await signIn();
		const cookie = setCookies(reply).find((c) => c.startsWith(SESSION_COOKIE_NAME)) as string;
		const parts = cookie.split(';').map((p) => p.trim());
		expect(parts[0]).toBe(`${SESSION_COOKIE_NAME}=${token}`);
		expect(parts).toContain('Path=/');
		expect(parts).toContain('Secure');
		expect(parts).toContain('HttpOnly');
		expect(parts).toContain('SameSite=Lax');
		expect(parts).toContain(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`);
		expect(parts.some((p) => /^domain=/i.test(p))).toBe(false);
		expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
		expect(reply.text).not.toContain(token);
		expect(reply.text).not.toContain(code);
		expect(reply.json).toMatchObject({
			user: { email: 'ada@example.com', displayName: null },
			isNew: true
		});
	});

	it('sets a readable signed-in hint beside the session cookie, with the same lifetime', async () => {
		const { reply, token } = await signIn();
		const line = setCookies(reply).find((c) =>
			c.startsWith(`${SESSION_HINT_COOKIE}=`)
		) as string;
		const parts = line.split(';').map((p) => p.trim());
		expect(parts[0]).toBe(`${SESSION_HINT_COOKIE}=1`);
		expect(parts).toContain('Path=/');
		expect(parts).toContain('Secure');
		expect(parts).toContain('SameSite=Lax');
		expect(parts).toContain(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`);
		expect(parts).not.toContain('HttpOnly');
		expect(parts.some((p) => /^domain=/i.test(p))).toBe(false);
		expect(line).not.toContain(token);
	});

	it('answers one 401 for every kind of bad code', async () => {
		await send(codeRequest, ROUTES.request, {
			method: 'POST',
			json: { email: 'ada@example.com' }
		});
		const code = h.mail.lastCode();
		const wrong = code === '123456' ? '654321' : '123456';
		const bodies = [];
		for (const json of [
			{ email: 'ada@example.com', code: wrong },
			{ email: 'someone@else.com', code },
			{ email: 'never@asked.com', code: '123456' }
		]) {
			const reply = await send(codeVerify, ROUTES.verify, { method: 'POST', json });
			expect(reply.status).toBe(401);
			expect(setCookies(reply)).toEqual([]);
			const { requestId: _id, ...rest } = reply.json as Record<string, unknown>;
			bodies.push(rest);
		}
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
		expect(h.directory.users).toEqual([]);
	});

	it('rejects a code that is not six digits before it reaches the service', async () => {
		for (const code of ['12345', '1234567', 'abcdef', '12 456']) {
			const reply = await send(codeVerify, ROUTES.verify, {
				method: 'POST',
				json: { email: 'ada@example.com', code }
			});
			expect(reply.status).toBe(400);
		}
	});

	it('creates one user, one personal organisation and one owner membership', async () => {
		await signIn();
		await signIn();
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.members).toHaveLength(1);
	});
});

describe('GET /api/v1/me', () => {
	it('returns the account for a session cookie', async () => {
		const { token } = await signIn();
		const reply = await send(me, ROUTES.me, { headers: cookieHeader(token) });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			email: 'ada@example.com',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		});
	});

	it('answers 401 with no cookie, a made-up token or a revoked session', async () => {
		const { token } = await signIn();
		expect((await send(me, ROUTES.me, {})).status).toBe(401);
		expect((await send(me, ROUTES.me, { headers: cookieHeader('x'.repeat(43)) })).status).toBe(
			401
		);
		await send(logout, ROUTES.logout, { method: 'POST', headers: cookieHeader(token) });
		expect((await send(me, ROUTES.me, { headers: cookieHeader(token) })).status).toBe(401);
	});

	it('returns the issuer for an API key and refuses a revoked one', async () => {
		await signIn();
		const issuer = h.directory.users[0]!;
		const generated = await generateApiKey({
			scopes: ['account.read'],
			expiry: '30d',
			now: clock.now
		});
		const index = kvKeyIndex(h.kv);
		await index.put(generated.data.lookupId, {
			keyId: 'key-1',
			issuerId: issuer.id,
			orgId: 'org-1',
			keyHash: generated.data.keyHash
		});
		const auth = { authorization: `Bearer ${generated.token}` };
		const reply = await send(me, ROUTES.me, { headers: auth });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ id: issuer.id, via: 'key', stepUpUntil: null });
		await index.put(generated.data.lookupId, {
			keyId: 'key-1',
			issuerId: issuer.id,
			orgId: 'org-1',
			keyHash: generated.data.keyHash,
			revokedAt: clock.now
		});
		expect((await send(me, ROUTES.me, { headers: auth })).status).toBe(401);
	});
});

describe('sessions', () => {
	async function withStepUp(token: string, email = 'ada@example.com'): Promise<string> {
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await send(codeRequest, ROUTES.request, { method: 'POST', json: { email } });
		const reply = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			headers: cookieHeader(token),
			json: { code: h.mail.lastCode() }
		});
		expect(reply.status).toBe(200);
		return tokenFrom(reply);
	}

	it('lists devices newest first and marks the current one', async () => {
		const first = await signIn();
		const second = await signIn();
		const reply = await send(sessionsGet, ROUTES.sessions, {
			headers: { ...cookieHeader(second.token), 'user-agent': 'curl/8' }
		});
		expect(reply.status).toBe(200);
		const { items, nextCursor } = reply.json as {
			items: { id: string; current: boolean; device: string }[];
			nextCursor: null;
		};
		expect(nextCursor).toBeNull();
		expect(items).toHaveLength(2);
		expect(items.map((i) => i.current)).toEqual([true, false]);
		expect(JSON.stringify(reply.json)).not.toContain(first.token);
		expect(JSON.stringify(reply.json)).not.toContain(second.token);
	});

	it('revokes another session and leaves the cookie alone', async () => {
		const first = await signIn();
		const second = await signIn();
		const list = await send(sessionsGet, ROUTES.sessions, {
			headers: cookieHeader(second.token)
		});
		const other = (list.json as { items: { id: string; current: boolean }[] }).items.find(
			(i) => !i.current
		)!;
		const freshToken = await withStepUp(second.token);
		const reply = await send(sessionDelete, ROUTES.session, {
			method: 'DELETE',
			path: `/api/v1/me/sessions/${other.id}`,
			headers: cookieHeader(freshToken)
		});
		expect(reply.status).toBe(204);
		expect(setCookies(reply)).toEqual([]);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(first.token) })).status).toBe(
			401
		);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(freshToken) })).status).toBe(200);
	});

	it('needs a fresh sign-in to revoke another session or sign out other devices', async () => {
		const first = await signIn();
		const second = await signIn();
		const list = await send(sessionsGet, ROUTES.sessions, {
			headers: cookieHeader(second.token)
		});
		const other = (list.json as { items: { id: string; current: boolean }[] }).items.find(
			(i) => !i.current
		)!;
		const one = await send(sessionDelete, ROUTES.session, {
			method: 'DELETE',
			path: `/api/v1/me/sessions/${other.id}`,
			headers: cookieHeader(second.token)
		});
		expect(one.status).toBe(403);
		expect((one.json as { details: { requires: string } }).details.requires).toBe('step-up');
		const all = await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: cookieHeader(second.token)
		});
		expect(all.status).toBe(403);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(first.token) })).status).toBe(
			200
		);
		const freshToken = await withStepUp(second.token);
		clock.advance(11 * 60 * 1000);
		const expired = await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: cookieHeader(freshToken)
		});
		expect(expired.status).toBe(403);
	});

	it('signs out every other device and keeps the one making the request', async () => {
		const first = await signIn();
		const second = await signIn();
		const third = await signIn();
		const freshToken = await withStepUp(second.token);
		const reply = await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: cookieHeader(freshToken)
		});
		expect(reply.status).toBe(204);
		expect(setCookies(reply)).toEqual([]);
		for (const gone of [first, third]) {
			expect((await send(me, ROUTES.me, { headers: cookieHeader(gone.token) })).status).toBe(
				401
			);
		}
		expect((await send(me, ROUTES.me, { headers: cookieHeader(freshToken) })).status).toBe(200);
		const list = await send(sessionsGet, ROUTES.sessions, {
			headers: cookieHeader(freshToken)
		});
		expect((list.json as { items: unknown[] }).items).toHaveLength(1);
	});

	it('leaves another person sessions alone when signing out other devices', async () => {
		const mine = await signIn('ada@example.com');
		const theirs = await signIn('grace@example.com');
		await signIn('ada@example.com');
		await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: cookieHeader(await withStepUp(mine.token))
		});
		expect((await send(me, ROUTES.me, { headers: cookieHeader(theirs.token) })).status).toBe(
			200
		);
	});

	it('succeeds when there are no other devices, and answers 401 with no session', async () => {
		const { token } = await signIn();
		const alone = await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: cookieHeader(await withStepUp(token))
		});
		expect(alone.status).toBe(204);
		expect((await send(sessionsDelete, ROUTES.sessions, { method: 'DELETE' })).status).toBe(
			401
		);
	});

	it('clears the cookie when the session being revoked is the current one', async () => {
		const { token } = await signIn();
		const list = await send(sessionsGet, ROUTES.sessions, { headers: cookieHeader(token) });
		const current = (list.json as { items: { id: string }[] }).items[0]!;
		const reply = await send(sessionDelete, ROUTES.session, {
			method: 'DELETE',
			path: `/api/v1/me/sessions/${current.id}`,
			headers: cookieHeader(token)
		});
		expect(reply.status).toBe(204);
		const cleared = setCookies(reply).find((c) => c.startsWith(SESSION_COOKIE_NAME)) as string;
		expect(cleared).toMatch(/Max-Age=0/);
		expect(cleared).toMatch(/Secure/);
		expect(cleared).toMatch(/Path=\//);
		expectHintCleared(reply);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(token) })).status).toBe(401);
	});

	it('answers 404 for an unknown id and for another user session, and 400 for a malformed id', async () => {
		const mine = await signIn('ada@example.com');
		const theirs = await signIn('grace@example.com');
		const theirList = await send(sessionsGet, ROUTES.sessions, {
			headers: cookieHeader(theirs.token)
		});
		const theirId = (theirList.json as { items: { id: string }[] }).items[0]!.id;
		const mineFresh = await withStepUp(mine.token);
		const del = (id: string) =>
			send(sessionDelete, ROUTES.session, {
				method: 'DELETE',
				path: `/api/v1/me/sessions/${id}`,
				headers: cookieHeader(mineFresh)
			});
		expect((await del(theirId)).status).toBe(404);
		expect((await del('ses_00000000000000000000000000')).status).toBe(404);
		expect((await del('nope')).status).toBe(400);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(theirs.token) })).status).toBe(
			200
		);
	});

	it('refuses an API key on every session route', async () => {
		await signIn();
		const generated = await generateApiKey({
			scopes: ['account.read'],
			expiry: '30d',
			now: clock.now
		});
		await kvKeyIndex(h.kv).put(generated.data.lookupId, {
			keyId: 'key-1',
			issuerId: h.directory.users[0]!.id,
			orgId: 'org-1',
			keyHash: generated.data.keyHash
		});
		const auth = { authorization: `Bearer ${generated.token}` };
		expect((await send(sessionsGet, ROUTES.sessions, { headers: auth })).status).toBe(403);
		expect(
			(
				await send(sessionDelete, ROUTES.session, {
					method: 'DELETE',
					path: '/api/v1/me/sessions/ses_00000000000000000000000000',
					headers: auth
				})
			).status
		).toBe(403);
		expect(
			(
				await send(stepUpRoute, ROUTES.stepUp, {
					method: 'POST',
					headers: auth,
					json: { code: '123456' }
				})
			).status
		).toBe(403);
	});
});

describe('POST /api/v1/auth/logout', () => {
	it('ends the session and clears the cookie', async () => {
		const { token } = await signIn();
		const reply = await send(logout, ROUTES.logout, {
			method: 'POST',
			headers: cookieHeader(token)
		});
		expect(reply.status).toBe(204);
		const cleared = setCookies(reply).find((c) => c.startsWith(SESSION_COOKIE_NAME)) as string;
		expect(cleared).toMatch(/Max-Age=0/);
		expectHintCleared(reply);
		expect(h.kv.keys().filter((k) => k.startsWith('session:'))).toEqual([]);
	});

	it('still answers 204 with no cookie or a dead one', async () => {
		const none = await send(logout, ROUTES.logout, { method: 'POST' });
		expect(none.status).toBe(204);
		expectHintCleared(none);
		const dead = await send(logout, ROUTES.logout, {
			method: 'POST',
			headers: cookieHeader('x'.repeat(43))
		});
		expect(dead.status).toBe(204);
		expectHintCleared(dead);
	});
});

describe('POST /api/v1/auth/step-up', () => {
	async function codeForSession(token: string): Promise<string> {
		await send(codeRequest, ROUTES.request, {
			method: 'POST',
			json: { email: 'ada@example.com' }
		});
		void token;
		return h.mail.lastCode();
	}

	it('takes a fresh code, rotates the cookie and reports when the step-up ends', async () => {
		const { token } = await signIn();
		const code = await codeForSession(token);
		const reply = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			headers: cookieHeader(token),
			json: { code }
		});
		expect(reply.status).toBe(200);
		const next = tokenFrom(reply);
		expect(next).not.toBe(token);
		expect(reply.text).not.toContain(next);
		expect(setCookies(reply).some((c) => c.startsWith(`${SESSION_HINT_COOKIE}=1`))).toBe(true);
		expect((reply.json as { stepUpUntil: string }).stepUpUntil).toBe(
			new Date(clock.now + 10 * 60 * 1000).toISOString()
		);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(token) })).status).toBe(401);
		const profile = await send(me, ROUTES.me, { headers: cookieHeader(next) });
		expect(profile.status).toBe(200);
		expect((profile.json as { stepUpUntil: string }).stepUpUntil).toBe(
			new Date(clock.now + 10 * 60 * 1000).toISOString()
		);
	});

	it('answers 401 for a wrong code and keeps the old cookie working', async () => {
		const { token } = await signIn();
		const code = await codeForSession(token);
		const wrong = code === '123456' ? '654321' : '123456';
		const reply = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			headers: cookieHeader(token),
			json: { code: wrong }
		});
		expect(reply.status).toBe(401);
		expect(setCookies(reply)).toEqual([]);
		expect((await send(me, ROUTES.me, { headers: cookieHeader(token) })).status).toBe(200);
	});

	it('answers 401 with no session', async () => {
		const reply = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			json: { code: '123456' }
		});
		expect(reply.status).toBe(401);
	});
});

describe('ensureLoggedIn', () => {
	const route = defineEventHandler(async (event) => ({
		principal: await ensureLoggedIn(event)
	}));

	it('returns the principal for a live cookie and throws 401 otherwise', async () => {
		const { token } = await signIn();
		const live = await send(route, '/probe', { headers: cookieHeader(token) });
		expect(live.json).toMatchObject({ principal: { kind: 'user' } });
		expect((await send(route, '/probe', {})).status).toBe(401);
		expect(
			(await send(route, '/probe', { headers: { authorization: 'Bearer not-a-key' } })).status
		).toBe(401);
		expect(
			(await send(route, '/probe', { headers: cookieHeader('x'.repeat(43)) })).status
		).toBe(401);
	});

	it('resolves a bearer key the same way the pipeline does', async () => {
		const generated = await generateApiKey({
			scopes: ['site.read'],
			expiry: '30d',
			now: clock.now
		});
		await kvKeyIndex(h.kv).put(generated.data.lookupId, {
			keyId: 'key-1',
			issuerId: 'user-9',
			orgId: 'org-1',
			keyHash: generated.data.keyHash
		});
		const reply = await send(route, '/probe', {
			headers: { authorization: `Bearer ${generated.token}` }
		});
		expect(reply.json).toEqual({
			principal: { kind: 'key', keyId: 'key-1', issuerId: 'user-9' }
		});
	});
});

describe('route scan', () => {
	it('lists every auth and me route, each declared through defineApi', async () => {
		const { routes, problems } = await scanRoutes(API_ROOT);
		expect(problems).toEqual([]);
		const found = Object.fromEntries(
			routes.map((r) => [`${r.method.toUpperCase()} ${r.path}`, r.meta.action])
		);
		expect(found).toMatchObject({
			'POST /api/v1/auth/code/request': 'auth.code.request',
			'POST /api/v1/auth/code/verify': 'auth.code.verify',
			'POST /api/v1/auth/logout': 'auth.logout',
			'POST /api/v1/auth/step-up': 'account.security.manage',
			'GET /api/v1/me': 'account.read',
			'GET /api/v1/me/sessions': 'account.security.manage',
			'DELETE /api/v1/me/sessions/{id}': 'account.security.manage'
		});
		for (const handler of [
			codeRequest,
			codeVerify,
			logout,
			stepUpRoute,
			me,
			sessionsGet,
			sessionDelete
		]) {
			expect(isApiHandler(handler)).toBe(true);
		}
	});
});
