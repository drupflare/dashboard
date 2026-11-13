import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import keyRevoke from '../../../../src/server/api/v1/orgs/[orgId]/api-keys/[keyId]/revoke.post';
import keyList from '../../../../src/server/api/v1/orgs/[orgId]/api-keys/index.get';
import keyCreate from '../../../../src/server/api/v1/orgs/[orgId]/api-keys/index.post';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import { hashApiKey } from '../../../../src/server/services/api-keys';
import {
	ACTIVE_KEY_BOUND,
	setKeyServices,
	type KeyServices
} from '../../../../src/server/services/key-admin';
import {
	collegeKeyIndex,
	createPrincipalResolver,
	keyFactsOf,
	LAST_USED_WRITE_INTERVAL_MS,
	type AuthServices
} from '../../../../src/server/utils/auth';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import type { OrgRole } from '../../../../src/shared/permissions';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup, USER_A } from '../fixtures/harness';

const COLLECTION = `/api/v1/orgs/${ORG}/api-keys`;
const LIST = '/api/v1/orgs/:orgId/api-keys';
const REVOKE = '/api/v1/orgs/:orgId/api-keys/:keyId/revoke';
const DAY = 24 * 60 * 60 * 1000;

function world() {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) if (/api_key/.test(statement)) sql.exec(statement);
	const db = {
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	const trail: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
	const state = { auditFails: false };
	const services: KeyServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			if (state.auditFails) throw new Error('audit is down');
			trail.push({ orgId, ...input });
		},
		now: Date.now
	};
	setKeyServices(services);
	return { sql, db, trail, state };
}

type World = ReturnType<typeof world>;

const rows = (w: World, text: string, ...bindings: unknown[]) =>
	w.sql.prepare(text).all(...(bindings as never[])) as Record<string, unknown>[];

function insertKey(w: World, id: string, createdAt: number, over: Record<string, unknown> = {}) {
	w.sql
		.prepare(
			`INSERT INTO api_keys (id, organization_id, name, key_hash, scopes, created_by,
			 expires_at, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			(over.org as string) ?? ORG,
			`key ${id}`,
			`hash-${id}`,
			'["org.read"]',
			'user-1',
			null,
			null,
			createdAt,
			null
		);
	w.sql
		.prepare('INSERT INTO api_key_lookup (lookup_id, organization_id, key_id) VALUES (?, ?, ?)')
		.run(`lookup${id}`, (over.org as string) ?? ORG, id);
}

const create = (body: unknown, headers: Record<string, string> = asUser) =>
	send(keyCreate, LIST, { method: 'POST', path: COLLECTION, headers, json: body });
const good = { name: 'ci', scopes: ['org.read', 'site.read'], expiry: '90d' };

afterEach(() => {
	setKeyServices(null);
	resetApiDeps();
});

describe('POST /api/v1/orgs/:orgId/api-keys', () => {
	it('returns the token once and stores only its hash, with a lookup row and an audit row', async () => {
		const w = world();
		setup();
		const reply = await create(good);
		expect(reply.status).toBe(201);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		const view = reply.json as { id: string; token: string; prefix: string; expiresAt: string };
		expect(view.token).toMatch(/^dfk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
		expect(view.token.startsWith(`${view.prefix}_`)).toBe(true);
		const stored = rows(w, 'SELECT * FROM api_keys');
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({
			id: view.id,
			organization_id: ORG,
			name: 'ci',
			created_by: 'user-1',
			scopes: JSON.stringify(['org.read', 'site.read']),
			key_hash: await hashApiKey(view.token),
			revoked_at: null,
			last_used_at: null
		});
		const lifetime = (stored[0]!.expires_at as number) - (stored[0]!.created_at as number);
		expect(Math.abs(lifetime - 90 * DAY)).toBeLessThan(1000);
		expect(JSON.stringify(stored)).not.toContain(view.token);
		expect(rows(w, 'SELECT * FROM api_key_lookup')).toEqual([
			{ lookup_id: view.prefix.slice(4), organization_id: ORG, key_id: view.id }
		]);
		expect(w.trail).toEqual([
			{
				orgId: ORG,
				actor: 'user:user-1',
				action: 'key.issued',
				target: view.id,
				detail: { prefix: view.prefix, scopes: ['org.read', 'site.read'] }
			}
		]);
		expect(JSON.stringify(w.trail)).not.toContain(view.token);
	});

	it('names the request in the audit trail the pipeline writes', async () => {
		world();
		const { audits } = setup();
		await create(good);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ action: 'key.create', method: 'POST', path: COLLECTION });
	});

	it('refuses an API key, even one that holds every permission', async () => {
		const w = world();
		setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: ['key.create', 'org.read'] }
			})
		});
		const reply = await create(good, asKey);
		expect(reply.status).toBe(403);
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
	});

	it('refuses a signed-in user without a fresh sign-in', async () => {
		const w = world();
		setup({ facts: () => facts({ ...member('owner') }) });
		const reply = await create(good);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
	});

	it('refuses a role that cannot create keys', async () => {
		const w = world();
		setup({ role: 'viewer' });
		expect((await create(good)).status).toBe(403);
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
	});

	it('refuses a permission above the issuer own, and stores nothing', async () => {
		const w = world();
		setup({ role: 'developer' });
		const reply = await create({ ...good, scopes: ['org.read', 'member.invite'] });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			details: { reason: 'exceeds_issuer', scope: 'member.invite' }
		});
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
		expect(w.trail).toEqual([]);
	});

	it.each([
		['admin.capacity.read', 'session_only'],
		['admin.break-glass.start', 'session_only'],
		['key.create', 'session_only'],
		['key.revoke', 'session_only'],
		['node.revoke', 'step_up_only'],
		['not.an.action', 'unknown_scope']
	])('refuses %s as %s', async (scope, reason) => {
		const w = world();
		setup();
		const reply = await create({ ...good, scopes: ['org.read', scope] });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ details: { reason, scope } });
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
	});

	it.each([
		['no permissions', { ...good, scopes: [] }],
		['an empty name', { ...good, name: '   ' }],
		['an expiry outside the presets', { ...good, expiry: '7d' }],
		['an unknown field', { ...good, orgIds: [ORG] }]
	])('refuses %s', async (_label, body) => {
		const w = world();
		setup();
		expect((await create(body)).status).toBe(400);
		expect(rows(w, 'SELECT id FROM api_keys')).toEqual([]);
	});

	it('refuses an Idempotency-Key, which would store the token', async () => {
		world();
		setup();
		const reply = await create(good, { ...asUser, 'idempotency-key': 'abcdefgh12345678' });
		expect(reply.status).toBe(400);
	});

	it('refuses past the bound on active keys, and counts neither revoked nor expired ones', async () => {
		const w = world();
		setup();
		for (let i = 0; i < ACTIVE_KEY_BOUND; i++) insertKey(w, `k${i}`, 1000 + i);
		const full = await create(good);
		expect(full.status).toBe(409);
		expect(full.json).toMatchObject({ details: { reason: 'key_bound' } });
		w.sql.prepare('UPDATE api_keys SET revoked_at = 1 WHERE id = ?').run('k0');
		w.sql.prepare('UPDATE api_keys SET expires_at = 1 WHERE id = ?').run('k1');
		expect((await create(good)).status).toBe(201);
		expect((await create(good)).status).toBe(201);
		expect((await create(good)).status).toBe(409);
	});

	it('revokes the new key when its audit row cannot be written', async () => {
		const w = world();
		w.state.auditFails = true;
		const { errors } = setup();
		const reply = await create(good);
		expect(reply.status).toBe(500);
		expect(errors).toHaveLength(1);
		const stored = rows(w, 'SELECT revoked_at FROM api_keys');
		expect(stored).toHaveLength(1);
		expect(stored[0]!.revoked_at).not.toBeNull();
	});
});

describe('GET /api/v1/orgs/:orgId/api-keys', () => {
	const list = (query = '', headers: Record<string, string> = asUser) =>
		send(keyList, LIST, { path: `${COLLECTION}${query}`, headers });

	it('lists newest first with the prefix, and never the secret or its hash', async () => {
		const w = world();
		setup();
		insertKey(w, 'a', 1000);
		insertKey(w, 'b', 3000);
		insertKey(w, 'c', 2000);
		insertKey(w, 'other', 9000, { org: OTHER_ORG });
		const reply = await list();
		expect(reply.status).toBe(200);
		const page = reply.json as { items: Record<string, unknown>[]; nextCursor: string | null };
		expect(page.items.map((item) => item.id)).toEqual(['b', 'c', 'a']);
		expect(page.nextCursor).toBeNull();
		expect(page.items[0]).toEqual({
			id: 'b',
			name: 'key b',
			prefix: 'dfk_lookupb',
			scopes: ['org.read'],
			createdAt: new Date(3000).toISOString(),
			lastUsedAt: null,
			expiresAt: null,
			revokedAt: null
		});
		expect(reply.text).not.toContain('hash-');
		expect(reply.text).not.toContain('key_hash');
	});

	it('pages with a cursor and refuses a malformed one', async () => {
		const w = world();
		setup();
		for (let i = 0; i < 3; i++) insertKey(w, `k${i}`, 1000 + i);
		const first = await list('?limit=2');
		const one = first.json as { items: { id: string }[]; nextCursor: string };
		expect(one.items.map((item) => item.id)).toEqual(['k2', 'k1']);
		const second = await list(`?limit=2&cursor=${one.nextCursor}`);
		const two = second.json as { items: { id: string }[]; nextCursor: string | null };
		expect(two.items.map((item) => item.id)).toEqual(['k0']);
		expect(two.nextCursor).toBeNull();
		expect((await list('?cursor=not-a-cursor')).status).toBe(400);
	});

	it('shows a key whose lookup row is missing with no prefix', async () => {
		const w = world();
		setup();
		insertKey(w, 'a', 1000);
		w.sql.prepare('DELETE FROM api_key_lookup').run();
		const page = (await list()).json as { items: { prefix: string | null }[] };
		expect(page.items[0]!.prefix).toBeNull();
	});

	it('is empty for an organisation with no keys', async () => {
		world();
		setup();
		expect((await list()).json).toEqual({ items: [], nextCursor: null });
	});

	it('refuses a role that cannot read keys', async () => {
		world();
		setup({ role: 'billing' });
		expect((await list()).status).toBe(403);
	});
});

describe('POST /api/v1/orgs/:orgId/api-keys/:keyId/revoke', () => {
	const revoke = (id: string, headers: Record<string, string> = asUser, orgId = ORG) =>
		send(keyRevoke, REVOKE, {
			method: 'POST',
			path: `/api/v1/orgs/${orgId}/api-keys/${id}/revoke`,
			headers,
			json: {}
		});

	it('revokes the key, changes nothing the second time, and is audited', async () => {
		const w = world();
		const { audits } = setup();
		insertKey(w, 'a', 1000);
		const first = await revoke('a');
		expect(first.status).toBe(200);
		const revokedAt = (first.json as { revokedAt: string }).revokedAt;
		expect(Date.parse(revokedAt)).toBeGreaterThan(0);
		const again = await revoke('a');
		expect(again.status).toBe(200);
		expect((again.json as { revokedAt: string }).revokedAt).toBe(revokedAt);
		expect(audits.map((record) => [record.action, record.method, record.path])).toEqual([
			['key.revoke', 'POST', `${COLLECTION}/a/revoke`],
			['key.revoke', 'POST', `${COLLECTION}/a/revoke`]
		]);
	});

	it('answers not found for an unknown key and for a key of another organisation', async () => {
		const w = world();
		setup();
		insertKey(w, 'theirs', 1000, { org: OTHER_ORG });
		expect((await revoke('missing')).status).toBe(404);
		expect((await revoke('theirs')).status).toBe(404);
		expect(rows(w, 'SELECT revoked_at FROM api_keys')).toEqual([{ revoked_at: null }]);
	});

	it('refuses an API key', async () => {
		const w = world();
		setup({
			facts: () => ({
				...facts({ ...member('owner') }),
				key: { id: 'key-1', scopes: ['key.revoke'] }
			})
		});
		insertKey(w, 'a', 1000);
		expect((await revoke('a', asKey)).status).toBe(403);
		expect(rows(w, 'SELECT revoked_at FROM api_keys')).toEqual([{ revoked_at: null }]);
	});
});

describe('a key made through the routes', () => {
	function lifecycle(initialRole: OrgRole = 'owner') {
		const w = world();
		const state = { role: initialRole };
		const resolve = createPrincipalResolver(
			() => ({ keys: collegeKeyIndex(async () => w.db) }) as unknown as AuthServices
		);
		const setupWorld = setup({
			facts: ({ principal }) => {
				const key = keyFactsOf(principal);
				return {
					...facts({ ...member(state.role), ...fresh }),
					...(key ? { key } : {})
				};
			},
			deps: {
				resolvePrincipal: async (credential) =>
					credential.kind === 'bearer' ? resolve(credential) : USER_A
			}
		});
		return { w, state, ...setupWorld };
	}

	const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
	const useKey = (token: string) =>
		send(keyList, LIST, { path: COLLECTION, headers: bearer(token) });

	it('works, stops working the moment it is revoked, and says when it was last used', async () => {
		const { w } = lifecycle();
		const made = (await create({ ...good, scopes: ['key.read'] })).json as {
			id: string;
			token: string;
		};
		expect((await useKey(made.token)).status).toBe(200);
		expect(rows(w, 'SELECT last_used_at FROM api_keys')[0]!.last_used_at).toBeGreaterThan(0);

		const seen = (
			(await send(keyList, LIST, { path: COLLECTION, headers: asUser })).json as {
				items: { lastUsedAt: string | null }[];
			}
		).items[0]!.lastUsedAt;
		expect(seen).not.toBeNull();

		const revoked = await send(keyRevoke, REVOKE, {
			method: 'POST',
			path: `${COLLECTION}/${made.id}/revoke`,
			headers: asUser,
			json: {}
		});
		expect(revoked.status).toBe(200);
		expect((await useKey(made.token)).status).toBe(401);
	});

	it('writes the last-used mark at most once per interval', async () => {
		const { w } = lifecycle();
		const made = (await create({ ...good, scopes: ['key.read'] })).json as { token: string };
		await useKey(made.token);
		const marked = rows(w, 'SELECT last_used_at FROM api_keys')[0]!.last_used_at as number;
		await useKey(made.token);
		expect(rows(w, 'SELECT last_used_at FROM api_keys')[0]!.last_used_at).toBe(marked);
		w.sql
			.prepare('UPDATE api_keys SET last_used_at = ?')
			.run(marked - LAST_USED_WRITE_INTERVAL_MS - 1);
		await useKey(made.token);
		expect(
			rows(w, 'SELECT last_used_at FROM api_keys')[0]!.last_used_at
		).toBeGreaterThanOrEqual(marked);
	});

	it('refuses a permission it was not given', async () => {
		lifecycle();
		const made = (await create({ ...good, scopes: ['org.read'] })).json as { token: string };
		expect((await useKey(made.token)).status).toBe(403);
	});

	it('loses a permission when the issuer loses it', async () => {
		const { state } = lifecycle();
		const made = (await create({ ...good, scopes: ['key.read'] })).json as { token: string };
		expect((await useKey(made.token)).status).toBe(200);
		state.role = 'viewer';
		expect((await useKey(made.token)).status).toBe(403);
	});

	it('is refused once it has expired', async () => {
		const { w } = lifecycle();
		const made = (await create({ ...good, scopes: ['key.read'] })).json as { token: string };
		w.sql.prepare('UPDATE api_keys SET expires_at = 1').run();
		expect((await useKey(made.token)).status).toBe(401);
	});
});
