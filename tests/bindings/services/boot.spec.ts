import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import codeRequest from '../../../src/server/api/v1/auth/code/request.post';
import codeVerify from '../../../src/server/api/v1/auth/code/verify.post';
import logout from '../../../src/server/api/v1/auth/logout.post';
import stepUpRoute from '../../../src/server/api/v1/auth/step-up.post';
import me from '../../../src/server/api/v1/me/index.get';
import sessionsDelete from '../../../src/server/api/v1/me/sessions.delete';
import sessionsGet from '../../../src/server/api/v1/me/sessions.get';
import sessionDelete from '../../../src/server/api/v1/me/sessions/[id].delete';
import keyRevoke from '../../../src/server/api/v1/orgs/[orgId]/api-keys/[keyId]/revoke.post';
import keyList from '../../../src/server/api/v1/orgs/[orgId]/api-keys/index.get';
import keyCreate from '../../../src/server/api/v1/orgs/[orgId]/api-keys/index.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { personalOrganizationId } from '../../../src/server/db/repos/accounts';
import { createApiKeyWithLookup } from '../../../src/server/db/repos/api-key-lookup';
import { generateApiKey } from '../../../src/server/services/api-keys';
import { verify } from '../../../src/server/services/audit';
import { authChain } from '../../../src/server/services/auth';
import { buildServices, type BootEnv } from '../../../src/server/services/boot';
import { setIdentityServices } from '../../../src/server/services/identities';
import { setKeyServices } from '../../../src/server/services/key-admin';
import { SESSION_COOKIE_NAME } from '../../../src/server/services/sessions';
import { setAuthServices } from '../../../src/server/utils/auth';
import { resetApiDeps, setApiDeps } from '../../../src/server/utils/define-api';
import {
	send as sendRequest,
	type Request as RequestInit
} from '../../unit/server/fixtures/harness';
import { memoryMail, useClock, type MemoryMail } from '../../unit/server/services/auth-support';
import { openBindings, type Bindings, type OpenBindings } from '../support';

const SECRET = 'boot-test-secret';

const ROUTES = {
	request: '/api/v1/auth/code/request',
	verify: '/api/v1/auth/code/verify',
	logout: '/api/v1/auth/logout',
	stepUp: '/api/v1/auth/step-up',
	me: '/api/v1/me',
	sessions: '/api/v1/me/sessions',
	session: '/api/v1/me/sessions/:id'
};

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;
let mail: MemoryMail;
let clock: ReturnType<typeof useClock>;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => open.close());

// the production stores over the local bindings; only the mail and the bot check are stood in for
beforeEach(() => {
	clock = useClock();
	mail = memoryMail();
	const built = buildServices(env as BootEnv, { dev: false });
	setAuthServices({
		...built.auth,
		mail,
		turnstile: async () => true,
		codeSecret: SECRET
	});
	setIdentityServices(built.identity);
	setKeyServices(built.keys);
	setApiDeps(built.api);
});

afterEach(() => {
	clock.stop();
	setAuthServices(null);
	setIdentityServices(null);
	setKeyServices(null);
	resetApiDeps();
});

const uniqueEmail = () => `person-${crypto.randomUUID()}@example.test`;
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
const send = (
	handler: Parameters<typeof sendRequest>[0],
	route: string,
	req: Partial<RequestInit> = {}
) => sendRequest(handler, route, { path: route, ...req });

function sessionToken(reply: { headers: Headers }): string {
	const header = reply.headers.get('set-cookie') ?? '';
	const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
	if (!match?.[1]) throw new Error(`no session cookie in: ${header}`);
	return match[1];
}

async function signIn(email = uniqueEmail()) {
	const asked = await send(codeRequest, ROUTES.request, { method: 'POST', json: { email } });
	expect(asked.status).toBe(202);
	const reply = await send(codeVerify, ROUTES.verify, {
		method: 'POST',
		json: { email, code: mail.lastCode() }
	});
	expect(reply.status).toBe(200);
	return { email, token: sessionToken(reply), reply };
}

async function rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]> {
	const { results } = await env.DB.prepare(sql)
		.bind(...bindings)
		.all<T>();
	return results;
}

describe('sign-in through the production stores', () => {
	it('signs in by email code, reads the account, rotates the session and signs out', async () => {
		const { email, token, reply } = await signIn();
		expect(JSON.stringify(reply.json)).not.toContain(token);

		const account = await send(me, ROUTES.me, { headers: cookie(token) });
		expect(account.status).toBe(200);
		expect(account.json).toMatchObject({ email, via: 'session', stepUpUntil: null });
		const userId = (account.json as { id: string }).id;

		// the account setup landed in D1 as one organisation, one membership and one audit row
		const [org] = await rows<{ id: string; personal: number }>(
			'SELECT id, personal FROM organizations WHERE created_by = ?',
			userId
		);
		expect(org).toEqual({ id: personalOrganizationId(userId), personal: 1 });
		expect(
			await rows(
				'SELECT role FROM members WHERE organization_id = ? AND user_id = ?',
				org!.id,
				userId
			)
		).toEqual([{ role: 'owner' }]);
		const created = await rows<{ action: string }>(
			'SELECT action FROM audit_log WHERE organization_id = ?',
			org!.id
		);
		expect(created.map((row) => row.action)).toEqual(['account.create']);
		expect(await verify(db, org!.id, buildServices(env as BootEnv).heads)).toBeNull();

		// a fresh code rotates the session: the old cookie stops, the new one works
		clock.advance(61_000);
		await send(codeRequest, ROUTES.request, { method: 'POST', json: { email } });
		const stepped = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			headers: cookie(token),
			json: { code: mail.lastCode() }
		});
		expect(stepped.status).toBe(200);
		const rotated = sessionToken(stepped);
		expect(rotated).not.toBe(token);
		expect((await send(me, ROUTES.me, { headers: cookie(token) })).status).toBe(401);
		const after = await send(me, ROUTES.me, { headers: cookie(rotated) });
		expect(after.status).toBe(200);
		expect((after.json as { stepUpUntil: string | null }).stepUpUntil).not.toBeNull();

		// the session list names this one, and ending it signs the person out
		const list = await send(sessionsGet, ROUTES.sessions, { headers: cookie(rotated) });
		const items = (list.json as { items: { id: string; current: boolean }[] }).items;
		expect(items).toHaveLength(1);
		expect(items[0]!.current).toBe(true);
		const ended = await send(sessionDelete, ROUTES.session, {
			method: 'DELETE',
			path: `/api/v1/me/sessions/${items[0]!.id}`,
			headers: cookie(rotated)
		});
		expect(ended.status).toBe(204);
		expect((await send(me, ROUTES.me, { headers: cookie(rotated) })).status).toBe(401);
	});

	it('signs out through the logout route', async () => {
		const { token } = await signIn();
		const out = await send(logout, ROUTES.logout, { method: 'POST', headers: cookie(token) });
		expect(out.status).toBe(204);
		expect((await send(me, ROUTES.me, { headers: cookie(token) })).status).toBe(401);
	});

	it('refuses a guessed code and writes one audit row that holds neither code nor address', async () => {
		const email = uniqueEmail();
		await send(codeRequest, ROUTES.request, { method: 'POST', json: { email } });
		const real = mail.lastCode();
		const wrong = String((Number(real) + 1) % 1_000_000).padStart(6, '0');
		const reply = await send(codeVerify, ROUTES.verify, {
			method: 'POST',
			headers: { 'cf-connecting-ip': '203.0.113.77' },
			json: { email, code: wrong }
		});
		expect(reply.status).toBe(401);
		const chain = await authChain(email);
		const written = await rows<{ action: string; actor: string; detail: string }>(
			'SELECT action, actor, detail FROM audit_log WHERE organization_id = ?',
			chain
		);
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({ action: 'auth.code.denied', actor: 'anonymous' });
		const text = JSON.stringify(written);
		for (const secret of [wrong, real, email, SECRET, '203.0.113.77']) {
			expect(text).not.toContain(secret);
		}
		expect(JSON.parse(written[0]!.detail)).toEqual({
			network: '203.0.113.0/24',
			reason: 'invalid_code'
		});
	});

	it('heals a user whose organisation was never made, in one batch', async () => {
		const email = uniqueEmail();
		const userId = crypto.randomUUID();
		await env.DB.prepare(
			'INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, NULL, 1, 1)'
		)
			.bind(userId, email)
			.run();
		await signIn(email);
		expect(
			await rows(
				'SELECT user_id, role FROM members WHERE organization_id = ?',
				personalOrganizationId(userId)
			)
		).toEqual([{ user_id: userId, role: 'owner' }]);
		const actions = await rows<{ action: string }>(
			'SELECT action FROM audit_log WHERE organization_id = ? ORDER BY seq',
			personalOrganizationId(userId)
		);
		expect(actions.map((row) => row.action)).toEqual(['account.repair']);
		clock.advance(61_000);
		await signIn(email);
		const again = await rows(
			'SELECT seq FROM audit_log WHERE organization_id = ?',
			personalOrganizationId(userId)
		);
		expect(again).toHaveLength(1);
	});
});

describe('API keys through the production stores', () => {
	async function issueKey(userId: string, scopes: string[]) {
		const generated = await generateApiKey({ scopes, expiry: '30d', now: clock.now });
		await createApiKeyWithLookup(db, personalOrganizationId(userId), {
			lookupId: generated.data.lookupId,
			name: 'test key',
			keyHash: generated.data.keyHash,
			scopes,
			createdBy: userId,
			expiresAt: generated.data.expiresAt
		});
		return generated.token;
	}

	it('resolves a bearer key by its lookup row and reads the issuer account', async () => {
		const { token } = await signIn();
		const userId = (
			(await send(me, ROUTES.me, { headers: cookie(token) })).json as { id: string }
		).id;
		const key = await issueKey(userId, ['account.read']);
		const reply = await send(me, ROUTES.me, { headers: { authorization: `Bearer ${key}` } });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ id: userId, via: 'key' });
	});

	it('refuses a key on a session route and writes the denial to the issuer chain', async () => {
		const { token } = await signIn();
		const userId = (
			(await send(me, ROUTES.me, { headers: cookie(token) })).json as { id: string }
		).id;
		const key = await issueKey(userId, ['account.read']);
		const reply = await send(sessionsDelete, ROUTES.sessions, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${key}` }
		});
		expect(reply.status).toBe(403);
		const denied = await rows<{ action: string; actor: string; detail: string }>(
			`SELECT action, actor, detail FROM audit_log WHERE organization_id = ?
			 AND action LIKE '%.denied'`,
			personalOrganizationId(userId)
		);
		expect(denied).toHaveLength(1);
		expect(denied[0]).toMatchObject({ action: 'account.security.manage.denied' });
		expect(JSON.parse(denied[0]!.detail)).toMatchObject({
			reason: 'session_only',
			method: 'DELETE'
		});
		expect(JSON.stringify(denied)).not.toContain(key);
	});

	it('stops resolving the key once its row is revoked', async () => {
		const { token } = await signIn();
		const userId = (
			(await send(me, ROUTES.me, { headers: cookie(token) })).json as { id: string }
		).id;
		const key = await issueKey(userId, ['account.read']);
		const headers = { authorization: `Bearer ${key}` };
		expect((await send(me, ROUTES.me, { headers })).status).toBe(200);
		await env.DB.prepare('UPDATE api_keys SET revoked_at = 1 WHERE created_by = ?')
			.bind(userId)
			.run();
		expect((await send(me, ROUTES.me, { headers })).status).toBe(401);
	});

	it('issues a key from a fresh session, accepts it, and refuses it the moment it is revoked', async () => {
		const { email, token } = await signIn();
		const userId = (
			(await send(me, ROUTES.me, { headers: cookie(token) })).json as { id: string }
		).id;
		const orgId = personalOrganizationId(userId);
		const collection = `/api/v1/orgs/${orgId}/api-keys`;
		const route = '/api/v1/orgs/:orgId/api-keys';

		clock.advance(61_000);
		await send(codeRequest, ROUTES.request, { method: 'POST', json: { email } });
		const stepped = await send(stepUpRoute, ROUTES.stepUp, {
			method: 'POST',
			headers: cookie(token),
			json: { code: mail.lastCode() }
		});
		const session = cookie(sessionToken(stepped));

		const made = await send(keyCreate, route, {
			method: 'POST',
			path: collection,
			headers: session,
			json: { name: 'ci', scopes: ['key.read'], expiry: '30d' }
		});
		expect(made.status).toBe(201);
		const created = made.json as { id: string; token: string; prefix: string };
		const asKey = { authorization: `Bearer ${created.token}` };

		const stored = await rows<{
			key_hash: string;
			scopes: string;
			last_used_at: number | null;
		}>('SELECT key_hash, scopes, last_used_at FROM api_keys WHERE id = ?', created.id);
		expect(stored[0]!.scopes).toBe('["key.read"]');
		expect(stored[0]!.last_used_at).toBeNull();
		expect(JSON.stringify(stored)).not.toContain(created.token);

		const listed = await send(keyList, route, { path: collection, headers: asKey });
		expect(listed.status).toBe(200);
		expect(listed.text).not.toContain(created.token);
		expect(listed.json).toMatchObject({
			items: [{ id: created.id, name: 'ci', prefix: created.prefix, revokedAt: null }]
		});
		const used = await rows<{ last_used_at: number | null }>(
			'SELECT last_used_at FROM api_keys WHERE id = ?',
			created.id
		);
		expect(used[0]!.last_used_at).toBeGreaterThan(0);

		const refused = await send(keyCreate, route, {
			method: 'POST',
			path: collection,
			headers: asKey,
			json: { name: 'child', scopes: ['key.read'], expiry: '30d' }
		});
		expect(refused.status).toBe(403);

		const revoked = await send(keyRevoke, `${route}/:keyId/revoke`, {
			method: 'POST',
			path: `${collection}/${created.id}/revoke`,
			headers: session,
			json: {}
		});
		expect(revoked.status).toBe(200);
		expect((await send(keyList, route, { path: collection, headers: asKey })).status).toBe(401);

		const trail = await rows<{ action: string; target: string }>(
			'SELECT action, target FROM audit_log WHERE organization_id = ? AND action LIKE ? ORDER BY seq',
			orgId,
			'key.%'
		);
		expect(trail.map((row) => row.action)).toEqual([
			'key.create',
			'key.issued',
			'key.create.denied',
			'key.revoke'
		]);
		expect(trail[1]!.target).toBe(created.id);
		expect(await verify(db, orgId, buildServices(env as BootEnv).heads)).toBeNull();
	});
});
