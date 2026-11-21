import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, describe, expect, it } from 'vitest';
import savedDelete from '../../../../src/server/api/v1/admin/db/queries/[id].delete';
import savedList from '../../../../src/server/api/v1/admin/db/queries/index.get';
import savedSave from '../../../../src/server/api/v1/admin/db/queries/index.post';
import query from '../../../../src/server/api/v1/admin/db/query.post';
import shards from '../../../../src/server/api/v1/admin/db/shards.get';
import { listPlatformAudit } from '../../../../src/server/db/repos/platform-audit';
import { ROW_CAP } from '../../../../src/server/domain/sql-allow';
import {
	runQuery,
	type ConsoleBackend,
	type ConsoleServices
} from '../../../../src/server/services/db-console';
import { setOrganizationServices } from '../../../../src/server/services/organizations';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { admin, facts, fresh } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const adminFacts =
	(stepUp = true) =>
	() =>
		facts({ ...admin, ...(stepUp ? fresh : {}) });

// the console's real backend runs against these client methods; the fixture answers them from one database
function world() {
	const { raw, client } = sqliteClient();
	const rows = (sql: string) => ({ results: raw.prepare(sql).all() });
	Object.assign(client, {
		async getDatabaseSizesAllShards() {
			return [
				{ shard: 'DB', size: 4096, success: true },
				{ shard: 'DB_2', size: null, success: false }
			];
		},
		async allShard(_shard: string, sql: string) {
			return rows(sql);
		},
		async explain(_key: string, sql: string) {
			return rows(`EXPLAIN QUERY PLAN ${sql}`);
		},
		async explainShard(_shard: string, sql: string) {
			return rows(`EXPLAIN QUERY PLAN ${sql}`);
		},
		async countAllShards(table: string) {
			const n = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
			return { total: n.n, shards: [{ shard: 'DB', count: n.n, success: true }] };
		}
	});
	setOrganizationServices({ getDb: async () => client as CollegeDBClient });
	return { raw, client: client as CollegeDBClient };
}

afterEach(() => {
	resetApiDeps();
	setOrganizationServices(null);
});

const run = (json: unknown) =>
	send(query, '/api/v1/admin/db/query', {
		method: 'POST',
		path: '/api/v1/admin/db/query',
		headers: asUser,
		json
	});

describe('the read-only query route', () => {
	it('returns rows, plan on request, and writes the statement into the platform audit', async () => {
		const w = world();
		addReadySite(w.raw, 'org_1', 'site_a');
		setup({ facts: adminFacts() });
		const reply = await run({ statement: 'SELECT id, name FROM sites;' });
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			results: [
				{
					shard: 'directory',
					columns: ['id', 'name'],
					rows: [{ id: 'site_a', name: 'site_a' }],
					truncated: false,
					explain: false
				}
			]
		});
		const [row] = await listPlatformAudit(w.client);
		expect(row).toMatchObject({
			actor: 'user:user-1',
			action: 'admin.db.read',
			detail: { statement: 'SELECT id, name FROM sites', rows: 1 }
		});
		const plan = await run({ statement: 'SELECT id FROM sites', explain: true });
		expect(
			(plan.json as { results: { explain: boolean; rows: unknown[] }[] }).results[0]
		).toMatchObject({
			explain: true
		});
	});

	it('holds a result to the row cap and says it was cut', async () => {
		const w = world();
		for (let i = 0; i < ROW_CAP + 50; i++) addReadySite(w.raw, 'org_1', `site_${i}`);
		setup({ facts: adminFacts() });
		const reply = await run({ statement: 'SELECT id FROM sites LIMIT 999999999' });
		const result = (reply.json as { results: { rows: unknown[]; truncated: boolean }[] })
			.results[0];
		expect(result?.rows).toHaveLength(ROW_CAP);
		expect(result?.truncated).toBe(true);
	});

	it('refuses a hostile statement with 422 and audits the refusal with its text', async () => {
		const w = world();
		setup({ facts: adminFacts() });
		const reply = await run({ statement: 'SELECT 1; DROP TABLE sites' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'statement_refused' } });
		const [row] = await listPlatformAudit(w.client);
		expect(row).toMatchObject({
			action: 'admin.db.refused',
			detail: {
				statement: 'SELECT 1; DROP TABLE sites',
				reason: 'Only one statement is allowed'
			}
		});
	});

	it('answers 404 for a shard that does not exist and runs once per shard for all', async () => {
		world();
		setup({ facts: adminFacts() });
		expect((await run({ statement: 'SELECT 1', shard: 'DB_9' })).status).toBe(404);
		const all = await run({ statement: 'SELECT 1 AS one', shard: 'all' });
		expect((all.json as { results: { shard: string }[] }).results.map((r) => r.shard)).toEqual([
			'DB',
			'DB_2'
		]);
	});

	it('refuses a person who is no admin, an admin without step-up, one without infrastructure and a key', async () => {
		world();
		const body = { statement: 'SELECT 1' };
		setup({ role: 'owner' });
		expect((await run(body)).status).toBe(403);
		setup({ facts: adminFacts(false) });
		expect((await run(body)).status).toBe(403);
		setup({
			facts: () =>
				facts({
					...fresh,
					platform: { admin: true, access: true, permissions: ['read', 'support'] }
				})
		});
		expect((await run(body)).status).toBe(403);
		setup({ facts: adminFacts() });
		const keyed = await send(query, '/api/v1/admin/db/query', {
			method: 'POST',
			path: '/api/v1/admin/db/query',
			headers: asKey,
			json: body
		});
		expect(keyed.status).toBe(403);
	});
});

describe('the console service', () => {
	const fake = (rows: Record<string, unknown>[], delay = 0): ConsoleServices => {
		const { client } = sqliteClient();
		const backend: ConsoleBackend = {
			shards: async () => [{ shard: 'DB', sizeBytes: 1 }],
			rows: () => new Promise((resolve) => setTimeout(() => resolve(rows), delay)),
			plan: async () => [],
			count: async () => []
		};
		return {
			db: client,
			backend,
			now: () => 5,
			newId: () => 'dbq_1',
			timeoutMs: 20
		};
	};
	const admin = { kind: 'user', userId: 'usr_admin' } as const;

	it('masks a secret column that arrives under its own name', async () => {
		const services = fake([{ id: 'a', key_hash: 'hash-value', Ciphertext: 'sealed' }]);
		const [result] = await runQuery(services, {
			statement: 'SELECT * FROM sites',
			shard: 'directory',
			explain: false,
			principal: admin
		});
		expect(result?.rows).toEqual([{ id: 'a', key_hash: '[masked]', Ciphertext: '[masked]' }]);
	});

	it('stops a query that runs past the time cap', async () => {
		const services = fake([], 200);
		await expect(
			runQuery(services, {
				statement: 'SELECT 1',
				shard: 'directory',
				explain: false,
				principal: admin
			})
		).rejects.toMatchObject({ details: { reason: 'time_cap' } });
	});
});

describe('saved queries', () => {
	const save = (json: unknown) =>
		send(savedSave, '/api/v1/admin/db/queries', {
			method: 'POST',
			path: '/api/v1/admin/db/queries',
			headers: asUser,
			json
		});

	it('saves a statement that passes the check, lists it and deletes it with an audit trail', async () => {
		const w = world();
		setup({ facts: adminFacts() });
		const saved = await save({
			name: 'Active sites',
			statement: "SELECT id FROM sites WHERE state = 'active';"
		});
		expect(saved.status).toBe(201);
		const id = (saved.json as { id: string }).id;
		const list = await send(savedList, '/api/v1/admin/db/queries', {
			path: '/api/v1/admin/db/queries',
			headers: asUser
		});
		expect((list.json as { items: { id: string; statement: string }[] }).items).toEqual([
			expect.objectContaining({
				id,
				statement: "SELECT id FROM sites WHERE state = 'active'"
			})
		]);
		const gone = await send(savedDelete, '/api/v1/admin/db/queries/:id', {
			method: 'DELETE',
			path: `/api/v1/admin/db/queries/${id}`,
			headers: asUser
		});
		expect(gone.status).toBe(204);
		const missing = await send(savedDelete, '/api/v1/admin/db/queries/:id', {
			method: 'DELETE',
			path: `/api/v1/admin/db/queries/${id}`,
			headers: asUser
		});
		expect(missing.status).toBe(404);
		expect((await listPlatformAudit(w.client)).map((r) => r.action)).toEqual([
			'admin.db.delete',
			'admin.db.save'
		]);
	});

	it('refuses to save a statement the console would refuse to run', async () => {
		world();
		setup({ facts: adminFacts() });
		expect((await save({ name: 'Bad', statement: 'DELETE FROM sites' })).status).toBe(422);
		expect((await save({ name: '', statement: 'SELECT 1' })).status).toBe(400);
	});
});

describe('the shard list', () => {
	it('gives each shard its size and a row count when a table is named', async () => {
		const w = world();
		addReadySite(w.raw, 'org_1', 'site_a');
		setup({ facts: adminFacts() });
		const reply = await send(shards, '/api/v1/admin/db/shards', {
			path: '/api/v1/admin/db/shards?table=sites',
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			shards: [
				{ shard: 'DB', sizeBytes: 4096, rows: 1 },
				{ shard: 'DB_2', sizeBytes: null, rows: null }
			]
		});
		const bad = await send(shards, '/api/v1/admin/db/shards', {
			path: '/api/v1/admin/db/shards?table=sites;drop',
			headers: asUser
		});
		expect(bad.status).toBe(422);
	});
});
