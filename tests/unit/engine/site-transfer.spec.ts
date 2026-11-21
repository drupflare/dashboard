import { decideRenewal, type AuthorityState } from '@contracts/site-auth';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyTo, readAuthority } from '../../../dispatch/src/authority';
import { serve, type ServeDeps } from '../../../dispatch/src/serve';
import { authorityOf } from '../../../engine/src/adapters/authority';
import { hostValue } from '../../../engine/src/adapters/hosts';
import {
	MOVED_TABLES,
	shardDbOf,
	siteMovesOf,
	type ShardDb
} from '../../../engine/src/adapters/site-moves';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import {
	planSiteTransfer,
	runSiteTransfer,
	type SiteTransferInput,
	type TransferDeps
} from '../../../engine/src/workflows/site-transfer';
import { SCHEMA_STATEMENTS, SCHEMA_TRIGGERS } from '../../../src/server/db/schema';
import { makeRig } from '../dispatch/fakes';
import { Killed, makeRunner, makeWorld, type Memo, type World } from './fakes';

const ORG_B = `org_${'b'.repeat(26)}`;
const TRANSFER = 'transfer-0001';
const HOST = 'quiet-otter.drupflare.app';
const CUSTOM = 'www.example.org';
const HASH = `sha256:${'0'.repeat(64)}`;

function schemaed(): DatabaseSync {
	const sqlite = new DatabaseSync(':memory:');
	for (const statement of [...SCHEMA_STATEMENTS, ...SCHEMA_TRIGGERS]) sqlite.exec(statement);
	return sqlite;
}

function shardsOf(map: Record<string, DatabaseSync>): ShardDb {
	return {
		async all(org, sql, params = []) {
			return map[org]!.prepare(sql).all(...(params as never[])) as never;
		},
		async batch(org, statements) {
			const sqlite = map[org]!;
			sqlite.exec('BEGIN');
			try {
				for (const statement of statements) {
					sqlite.prepare(statement.sql).run(...(statement.params as never[]));
				}
				sqlite.exec('COMMIT');
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		}
	};
}

function seed(world: World, source: DatabaseSync, target: DatabaseSync) {
	const site = world.siteId;
	const org = world.orgId;
	const run = (sql: string, ...values: unknown[]) =>
		source.prepare(sql).run(...(values as never[]));
	run(
		`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, department_id,
		technical_owner, business_owner, cost_center_id, created_at, updated_at)
		VALUES (?, ?, 'Quiet Otter', 'managed', 'suspended', ?, 'dept_1', 'usr_a', 'usr_b', 'cc_1', 1, 1)`,
		site,
		org,
		HOST
	);
	run(
		`INSERT INTO site_resources (id, site_id, account_id, kind, binding, name, provider_id,
		created_by_operation, created_at) VALUES ('res_1', ?, ?, 'script', 'SCRIPT', 'one', NULL, 'op_x', 1)`,
		site,
		world.accountId
	);
	run(
		`INSERT INTO site_environments (id, organization_id, site_id, kind, name, host, status,
		env_site_id, source_backup_id, ttl_at, created_at, deleted_at)
		VALUES ('env_1', ?, ?, 'staging', 'otter', 'env-1.drupflare.app', 'ready', NULL, NULL, NULL, 1, NULL)`,
		org,
		site
	);
	run(
		`INSERT INTO site_access_rules (id, organization_id, site_id, environment, preset, config,
		created_by, created_at, revoked_at) VALUES ('rule_1', ?, ?, 'env_1', 'members', '{}', 'usr_a', 1, NULL)`,
		org,
		site
	);
	for (const id of ['bk_1', 'bk_2']) {
		run(
			`INSERT INTO backups (id, site_id, organization_id, operation_id, bytes, sha256, parts,
			restorable, verified, label, created_at, deleted_at) VALUES (?, ?, ?, ?, 10, 'abc', 1, 1, 0, NULL, 1, NULL)`,
			id,
			site,
			org,
			`op_${id}`
		);
	}
	run(
		`INSERT INTO site_config_changes (id, organization_id, site_id, operation_id, key, before, after,
		actor, status, created_at, reverted_by) VALUES ('cc_1', ?, ?, 'op_x', 'k', 'a', 'b', 'usr_a', 'applied', 1, NULL)`,
		org,
		site
	);
	run(
		`INSERT INTO site_discovery (site_id, document, etag, fetched_at) VALUES (?, '{}', NULL, 1)`,
		site
	);
	run(
		`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
		provider_id, ownership_epoch, created_at, updated_at) VALUES (?, ?, ?, 'op_x', 1, 'routed', NULL, NULL, 1, 1)`,
		CUSTOM,
		org,
		site
	);
	run(
		`INSERT INTO usage_intervals (organization_id, site_id, hour_start, issued, acked, accounting,
		settlement, invoice_ref, closed_at) VALUES (?, ?, '2026-11-01T00', 5, 5, 'exact', 'open', NULL, NULL)`,
		org,
		site
	);
	run(
		`INSERT INTO budget_states (site_id, state, reason, mode, block_at_views, written_at)
		VALUES (?, 'ok', NULL, 'shadow', NULL, 1)`,
		site
	);
	for (const [id, user] of [
		['grant_in', 'usr_in'],
		['grant_out', 'usr_out']
	]) {
		run(
			`INSERT INTO site_grants (id, organization_id, site_id, user_id, role, created_by, created_at,
			expires_at, revoked_at) VALUES (?, ?, ?, ?, 'viewer', 'usr_a', 1, NULL, NULL)`,
			id,
			org,
			site,
			user
		);
	}
	run(
		`INSERT INTO site_transfers (id, organization_id, to_organization_id, site_id, state,
		keep_delegation_id, proposed_by, proposed_at, expires_at, decided_by, decided_at, completed_at)
		VALUES (?, ?, ?, ?, 'accepted', NULL, 'usr_a', 1, 99, 'usr_b', 2, NULL)`,
		TRANSFER,
		org,
		ORG_B,
		site
	);
	target
		.prepare(
			`INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at)
			VALUES ('mem_1', ?, 'usr_in', 'viewer', 1, 1)`
		)
		.run(ORG_B);
}

function initial(siteId: string, patch: Partial<AuthorityState> = {}): AuthorityState {
	return {
		siteId: siteId as AuthorityState['siteId'],
		epoch: 1,
		generation: 1,
		state: 'active',
		risk: 'new-free',
		limits: { cpuMs: 50 },
		accessRuleHash: HASH as AuthorityState['accessRuleHash'],
		...patch
	};
}

async function transferWorld(options: { sameShard?: boolean } = {}) {
	const world = await makeWorld();
	const source = world.sqlite;
	const target = options.sameShard ? source : schemaed();
	const shards = shardsOf({ [world.orgId]: source, [ORG_B]: target });
	const deps: TransferDeps = { ...world.deps, moves: siteMovesOf(shards) };
	seed(world, source, target);
	await world.deps.authority.apply(initial(world.siteId));
	const input: SiteTransferInput = {
		operationId: world.operationId,
		transferId: TRANSFER,
		siteId: world.siteId,
		fromOrgId: world.orgId,
		toOrgId: ORG_B,
		accountId: world.accountId
	};
	return { world, deps, source, target, input, shards };
}

type W = Awaited<ReturnType<typeof transferWorld>>;

async function begin(w: W) {
	const frozen = await freezePlan(planSiteTransfer(w.input));
	const operation = newOperation({
		id: w.input.operationId,
		orgId: w.world.orgId,
		idempotencyKey: `key-${w.input.operationId}`,
		frozen,
		now: w.world.clock.now()
	});
	await w.world.store.begin({
		operation,
		accountId: w.world.accountId,
		siteId: w.input.siteId
	});
}

async function transfer(
	w: W,
	options: { memo?: Memo; killAfter?: number; killDuring?: number } = {}
) {
	if ((await w.world.store.get(w.input.operationId)) === null) await begin(w);
	const { runner, executed } = makeRunner(options.memo ?? new Map(), {
		killAfter: options.killAfter,
		killDuring: options.killDuring
	});
	return { outcome: await runSiteTransfer(runner, w.deps, w.input), executed };
}

const TABLES = [...MOVED_TABLES.map((spec) => spec.table), 'site_moves', 'site_transfers'];

function dump(sqlite: DatabaseSync) {
	return Object.fromEntries(
		TABLES.map((table) => [
			table,
			sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
		])
	);
}

const snapshot = (w: W) => ({
	source: dump(w.source),
	target: w.target === w.source ? 'same' : dump(w.target),
	authority: w.world.authority.snapshot()
});

const count = (sqlite: DatabaseSync, table: string, where = '1 = 1') =>
	Number(
		(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number })
			.n
	);

describe('a site transfer between two shards', () => {
	it('copies the records, hands the site over and removes the source rows', async () => {
		const w = await transferWorld();
		const { outcome, executed } = await transfer(w);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(executed).toEqual(
			expect.arrayContaining(['lease', 'copy', 'flip', 'retire', 'verify', 'finalize'])
		);
		const site = w.target
			.prepare('SELECT * FROM sites WHERE id = ?')
			.get(w.input.siteId) as Record<string, unknown>;
		expect(site).toMatchObject({
			organization_id: ORG_B,
			state: 'suspended',
			primary_hostname: HOST,
			department_id: null,
			technical_owner: null,
			business_owner: null,
			cost_center_id: null
		});
		for (const spec of MOVED_TABLES) {
			expect(count(w.source, spec.table), `${spec.table} left in the source`).toBe(0);
		}
		expect(count(w.target, 'site_resources')).toBe(1);
		expect(count(w.target, 'backups', `organization_id = '${ORG_B}'`)).toBe(2);
		expect(count(w.target, 'site_environments', `organization_id = '${ORG_B}'`)).toBe(1);
		expect(count(w.target, 'site_access_rules', `organization_id = '${ORG_B}'`)).toBe(1);
		expect(count(w.target, 'site_config_changes', `organization_id = '${ORG_B}'`)).toBe(1);
		expect(count(w.target, 'site_discovery')).toBe(1);
		expect(count(w.target, 'usage_intervals', `organization_id = '${ORG_B}'`)).toBe(1);
		expect(count(w.target, 'budget_states')).toBe(1);
		expect(count(w.target, 'custom_domains', `organization_id = '${ORG_B}'`)).toBe(1);
	});

	it('keeps only the grants of people who belong to the receiving organisation', async () => {
		const w = await transferWorld();
		await transfer(w);

		const grants = w.target.prepare('SELECT id, organization_id FROM site_grants').all();
		expect(grants).toEqual([{ id: 'grant_in', organization_id: ORG_B }]);
	});

	it('leaves a tombstone with the transfer id in the source shard and marks the transfer done', async () => {
		const w = await transferWorld();
		await transfer(w);

		expect(w.source.prepare(`SELECT * FROM site_moves`).all()).toEqual([
			expect.objectContaining({
				transfer_id: TRANSFER,
				role: 'tombstone',
				organization_id: w.world.orgId,
				site_id: w.input.siteId,
				to_organization_id: ORG_B
			})
		]);
		expect(w.target.prepare(`SELECT role, epoch_before FROM site_moves`).all()).toEqual([
			{ role: 'incoming', epoch_before: 1 }
		]);
		expect(
			w.source.prepare('SELECT state, completed_at FROM site_transfers').get()
		).toMatchObject({ state: 'completed', completed_at: w.world.clock.now() });
		const operation = (await w.world.store.get(w.input.operationId))!;
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
	});

	it('raises the routing epoch once and writes every route with it', async () => {
		const w = await transferWorld();
		await transfer(w);

		expect(w.world.authority.stateOf(w.input.siteId)).toMatchObject({
			epoch: 2,
			generation: 2
		});
		const { hosts } = w.world.authority.snapshot();
		expect(hosts.map(([host, route]) => [host, route.epoch])).toEqual([
			[HOST, 2],
			[CUSTOM, 2]
		]);
	});

	it('is killed after each step and resumes to the state of an unbroken run', async () => {
		const reference = await transferWorld();
		await transfer(reference);
		const want = snapshot(reference);

		for (let killAfter = 0; killAfter <= 8; killAfter++) {
			const w = await transferWorld();
			const memo: Memo = new Map();
			try {
				await transfer(w, { memo, killAfter });
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
			const resumed = await transfer(w, { memo });
			expect(resumed.outcome, `killed after ${killAfter}`).toEqual({ status: 'succeeded' });
			expect(snapshot(w), `killed after ${killAfter}`).toEqual(want);
		}
	});

	it('changes nothing when a step ran its effect and died before its result was saved', async () => {
		const reference = await transferWorld();
		await transfer(reference);
		const want = snapshot(reference);

		for (let during = 1; during <= 8; during++) {
			const w = await transferWorld();
			const memo: Memo = new Map();
			try {
				await transfer(w, { memo, killDuring: during });
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
			await transfer(w, { memo });
			expect(snapshot(w), `killed during ${during}`).toEqual(want);
			expect(
				w.world.authority.stateOf(w.input.siteId)!.epoch,
				`killed during ${during}`
			).toBe(2);
		}
	});

	it('refuses to delete the source rows when the copy does not match', async () => {
		const w = await transferWorld();
		const memo: Memo = new Map();
		// the lease, copy and flip steps ran; the read back is next
		await transfer(w, { memo, killAfter: 4 }).catch((error) => {
			if (!(error instanceof Killed)) throw error;
		});
		w.target.prepare(`UPDATE backups SET bytes = 999 WHERE id = 'bk_1'`).run();

		const { outcome } = await transfer(w, { memo });

		expect(outcome.status).toBe('failed');
		expect(JSON.stringify(outcome)).toContain('read_back_mismatch');
		expect(count(w.source, 'sites')).toBe(1);
		expect(count(w.source, 'backups')).toBe(2);
		expect(count(w.source, 'site_moves')).toBe(0);
		expect((await w.world.store.get(w.input.operationId))!.status).toBe('failed');
	});

	it('refuses to delete the source rows when a copied row is missing', async () => {
		const w = await transferWorld();
		const memo: Memo = new Map();
		await transfer(w, { memo, killAfter: 4 }).catch((error) => {
			if (!(error instanceof Killed)) throw error;
		});
		w.target.prepare(`DELETE FROM site_environments`).run();

		const { outcome } = await transfer(w, { memo });

		expect(JSON.stringify(outcome)).toContain('read_back_mismatch');
		expect(count(w.source, 'site_environments')).toBe(1);
		expect(count(w.source, 'site_moves')).toBe(0);
	});

	it('refuses a hostname the receiving organisation already holds for another site', async () => {
		const w = await transferWorld();
		w.target
			.prepare(
				`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
				provider_id, ownership_epoch, created_at, updated_at)
				VALUES (?, ?, 'site_other', 'op_y', 1, 'routed', NULL, NULL, 1, 1)`
			)
			.run(CUSTOM, ORG_B);

		const { outcome } = await transfer(w);

		expect(JSON.stringify(outcome)).toContain('hostname_collision');
		expect(count(w.target, 'sites')).toBe(0);
		expect(count(w.source, 'sites')).toBe(1);
		expect(w.world.authority.stateOf(w.input.siteId)!.epoch).toBe(1);
	});

	it('does nothing for a transfer that was not accepted', async () => {
		const w = await transferWorld();
		w.source.prepare(`UPDATE site_transfers SET state = 'proposed'`).run();

		const { outcome } = await transfer(w);

		expect(JSON.stringify(outcome)).toContain('transfer_not_accepted');
		expect(count(w.target, 'site_moves')).toBe(0);
		expect(count(w.source, 'sites')).toBe(1);
		expect(w.world.authority.stateOf(w.input.siteId)!.epoch).toBe(1);
	});

	it('refuses an operation that belongs to another site', async () => {
		const w = await transferWorld();
		await begin(w);
		w.source.prepare(`UPDATE operations SET target_ids = '["site_other"]'`).run();

		const { outcome } = await transfer(w);

		expect(JSON.stringify(outcome)).toContain('operation_mismatch');
		expect(count(w.target, 'sites')).toBe(0);
	});

	it('holds the site writer lease for the whole move', async () => {
		const w = await transferWorld();
		await w.world.leases.leases.acquire(w.input.siteId, {
			holder: 'op_someone_else',
			purpose: 'site.upgrade',
			ttlMs: 120_000
		});

		const { outcome } = await transfer(w);

		expect(JSON.stringify(outcome)).toContain('site_busy');
		expect(count(w.target, 'site_moves')).toBe(0);
	});
});

describe('a site transfer inside one database', () => {
	it('flips ownership in place, keeps the rows and leaves a tombstone', async () => {
		const w = await transferWorld({ sameShard: true });

		const { outcome } = await transfer(w);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(count(w.source, 'sites', `organization_id = '${ORG_B}'`)).toBe(1);
		expect(count(w.source, 'sites')).toBe(1);
		expect(count(w.source, 'site_resources')).toBe(1);
		expect(count(w.source, 'backups', `organization_id = '${ORG_B}'`)).toBe(2);
		expect(count(w.source, 'site_moves', `role = 'tombstone'`)).toBe(1);
		expect(w.world.authority.stateOf(w.input.siteId)!.epoch).toBe(2);
	});

	it('is killed after each step and resumes to the state of an unbroken run', async () => {
		const reference = await transferWorld({ sameShard: true });
		await transfer(reference);
		const want = snapshot(reference);

		for (let killAfter = 0; killAfter <= 8; killAfter++) {
			const w = await transferWorld({ sameShard: true });
			const memo: Memo = new Map();
			try {
				await transfer(w, { memo, killAfter });
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
			await transfer(w, { memo });
			expect(snapshot(w), `killed after ${killAfter}`).toEqual(want);
		}
	});

	it('never deletes the live rows, whatever step is called', async () => {
		const w = await transferWorld({ sameShard: true });
		await transfer(w);

		const refused = await w.deps.moves
			.retire(
				{
					transferId: TRANSFER,
					siteId: w.input.siteId,
					fromOrgId: w.world.orgId,
					toOrgId: ORG_B
				},
				1
			)
			.catch((error) => error);

		expect(refused).toMatchObject({ code: 'same_shard' });
		expect(count(w.source, 'sites')).toBe(1);
	});
});

describe('the shard adapter over the router', () => {
	it('runs the statements of a batch on the one key and fails when a group fails', async () => {
		const seen: unknown[] = [];
		const db = shardDbOf({
			all: async (key: string, sql: string, params: unknown[]) => {
				seen.push([key, sql, params]);
				return { results: [{ a: 1 }] };
			},
			batch: async (statements: { key: string; sql: string; bindings: unknown[] }[]) =>
				statements.length > 1
					? [{ shard: 'DB', error: 'boom' }]
					: [{ shard: 'DB', results: [] }]
		} as never);

		expect(await db.all('org_x', 'SELECT 1', [2])).toEqual([{ a: 1 }]);
		expect(seen).toEqual([['org_x', 'SELECT 1', [2]]]);
		await db.batch('org_x', [{ sql: 'A', params: [] }]);
		await expect(
			db.batch('org_x', [
				{ sql: 'A', params: [] },
				{ sql: 'B', params: [] }
			])
		).rejects.toThrow('boom');
	});
});

describe('an old lease after the move', () => {
	async function rigWorld() {
		const w = await transferWorld();
		const rig = await makeRig();
		const routes = new Map<string, string>();
		const siteAuth = {
			read: async () => readAuthority(rig.kv) ?? null,
			apply: (message: unknown) =>
				applyTo(rig.kv, message, {
					controlKey: rig.control.publicKey,
					now: rig.clock.now()
				})
		};
		w.deps.authority = authorityOf({
			siteAuth: () => siteAuth,
			hosts: {
				put: async (host, route) => void routes.set(host, hostValue(route)),
				deleteIfOwned: async () => 'absent'
			},
			controlKey: rig.control.privateKey,
			now: rig.clock.now
		});
		await rig.commit(initial(w.input.siteId, { risk: 'established' }));
		const served: string[] = [];
		const oldRoute = hostValue({ siteId: w.input.siteId, script: 'tenant-one', epoch: 1 });
		const serveDeps = (route: (host: string) => string | null): ServeDeps => ({
			now: rig.clock.now,
			publicKey: rig.lease.publicKey,
			readRoute: async (host) => route(host),
			siteAuth: () => rig.client,
			tenant: () => ({
				fetch: async (request) => {
					served.push(new URL(request.url).pathname);
					return new Response('tenant');
				}
			}),
			cache: new Map(),
			inflight: new Map(),
			revoked: new Set(),
			waitUntil: () => undefined
		});
		return { w, rig, routes, oldRoute, serveDeps, served };
	}

	it('serves before the move, refuses a route that names the old epoch after it, and serves the new route', async () => {
		const { w, routes, oldRoute, serveDeps, served } = await rigWorld();
		const get = (route: (host: string) => string | null) =>
			serve(new Request(`https://${HOST}/page`), serveDeps(route));

		expect((await get(() => oldRoute)).status).toBe(200);

		const { outcome } = await transfer(w);
		expect(outcome).toEqual({ status: 'succeeded' });

		expect((await get(() => oldRoute)).status).toBe(404);
		const fresh = routes.get(HOST)!;
		expect(JSON.parse(fresh)).toMatchObject({ epoch: 2, siteId: w.input.siteId });
		expect((await get(() => fresh)).status).toBe(200);
		expect(served).toEqual(['/page', '/page']);
	});

	it('is refused at the authority by a renewal that names the old epoch', async () => {
		const w = await transferWorld();
		await transfer(w);
		const state = w.world.authority.stateOf(w.input.siteId)!;
		const stale = decideRenewal({ siteId: w.input.siteId, epoch: 1 } as never, state);

		expect(stale).toEqual({ ok: false, code: 'wrong_epoch' });
		expect(decideRenewal({ siteId: w.input.siteId, epoch: 2 } as never, state)).toEqual({
			ok: true
		});
	});
});
