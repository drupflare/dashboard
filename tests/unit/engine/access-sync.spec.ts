import type { D1Database } from '@cloudflare/workers-types';
import { generateSigningKey } from '@contracts/common';
import { signGateAssertion } from '@contracts/gate-assertion';
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_LEASE_MS, type AuthorityState } from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
import { applyTo, readAuthority } from '../../../dispatch/src/authority';
import { encodeAssertion, GATE_PARAM, type GateDeps } from '../../../dispatch/src/gate';
import { serve, type ServeDeps } from '../../../dispatch/src/serve';
import { D1AccessLedger } from '../../../engine/src/adapters/access';
import { authorityOf } from '../../../engine/src/adapters/authority';
import { hostValue } from '../../../engine/src/adapters/hosts';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { AccessDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import {
	planAccessSync,
	runAccessSync,
	type AccessSyncInput
} from '../../../engine/src/workflows/access-sync';
import { accessGates, type AccessRule } from '../../../src/shared/access-presets';
import { makeRig } from '../dispatch/fakes';
import { Killed, makeRunner, makeWorld, type Memo, type World } from './fakes';

const COPY_SITE = `site_${'c'.repeat(26)}`;
const ENV = `env_${'e'.repeat(26)}`;
const PUBLIC_HASH = (await accessGates([], [])).accessRuleHash;

const stateOf = (world: World, siteId = world.siteId) => world.authority.stateOf(siteId);

function initial(siteId: string, patch: Partial<AuthorityState> = {}): AuthorityState {
	return {
		siteId: siteId as AuthorityState['siteId'],
		epoch: 1,
		generation: 1,
		state: 'active',
		risk: 'new-free',
		limits: { cpuMs: 50 },
		accessRuleHash: PUBLIC_HASH as AuthorityState['accessRuleHash'],
		...patch
	};
}

async function syncWorld(options: { copy?: boolean; environment?: boolean } = {}) {
	const world = await makeWorld();
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const deps: AccessDeps = { ...world.deps, access: new D1AccessLedger(db) };
	const applies: number[] = [];
	const inner = deps.authority.apply;
	deps.authority = {
		...deps.authority,
		apply: async (state) => {
			applies.push(state.generation);
			return inner(state);
		}
	};
	await world.deps.authority.apply(initial(world.siteId));
	if (options.copy) await world.deps.authority.apply(initial(COPY_SITE));
	if (options.environment !== false) addEnvironment(world, options.copy ? COPY_SITE : null);
	return { world, deps, applies };
}

function addEnvironment(world: World, copySite: string | null, id = ENV) {
	world.sqlite
		.prepare(
			`INSERT INTO site_environments (id, organization_id, site_id, kind, name, host, status,
			env_site_id, source_backup_id, ttl_at, created_at, deleted_at)
			VALUES (?, ?, ?, 'staging', 'quiet-otter', ?, 'ready', ?, NULL, NULL, 1, NULL)`
		)
		.run(id, world.orgId, world.siteId, `${id}.drupflare.app`, copySite);
}

function addRule(world: World, id: string, environment: string, preset = 'members') {
	world.sqlite
		.prepare(
			`INSERT INTO site_access_rules (id, organization_id, site_id, environment, preset, config,
			created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, '{}', 'usr_x', 1, NULL)`
		)
		.run(id, world.orgId, world.siteId, environment, preset);
}

const inputOf = (world: World, operationId = world.operationId): AccessSyncInput => ({
	operationId,
	orgId: world.orgId,
	siteId: world.siteId,
	accountId: world.accountId
});

async function begin(world: World, input: AccessSyncInput) {
	const frozen = await freezePlan(planAccessSync(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: world.orgId,
		idempotencyKey: `key-${input.operationId}`,
		frozen,
		now: world.clock.now()
	});
	await world.store.begin({ operation, accountId: world.accountId, siteId: input.siteId });
}

async function sync(
	w: { world: World; deps: AccessDeps },
	options: { memo?: Memo; killAfter?: number; killDuring?: number; operationId?: string } = {}
) {
	const input = inputOf(w.world, options.operationId);
	if ((await w.world.store.get(input.operationId)) === null) await begin(w.world, input);
	const { runner, executed } = makeRunner(options.memo ?? new Map(), {
		killAfter: options.killAfter,
		killDuring: options.killDuring
	});
	return { outcome: await runAccessSync(runner, w.deps, input), executed };
}

describe('access sync', () => {
	it('writes the digest of every environment to the site and its copies and reads them back', async () => {
		const w = await syncWorld({ copy: true });
		addRule(w.world, 'rule_1', ENV);
		const rules: AccessRule[] = [
			{ id: 'rule_1', environment: ENV, preset: 'members', config: {} }
		];
		const want = await accessGates([ENV], rules);

		const { outcome, executed } = await sync(w);

		expect(outcome).toEqual({ status: 'succeeded' });
		for (const siteId of [w.world.siteId, COPY_SITE]) {
			expect(stateOf(w.world, siteId)).toMatchObject({
				generation: 2,
				accessRuleHash: want.accessRuleHash,
				gates: want.gates
			});
		}
		expect(executed).toEqual(
			expect.arrayContaining(['lease', 'digests', 'write', 'verify', 'finalize'])
		);
		const operation = (await w.world.store.get(w.world.operationId))!;
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
	});

	it('leaves production public when nothing gates it and gates a bare environment by default', async () => {
		const w = await syncWorld();

		await sync(w);

		const state = stateOf(w.world)!;
		expect(Object.keys(state.gates ?? {})).toEqual([ENV]);
	});

	it('writes no gates and keeps the public digest when the site has no environment and no rule', async () => {
		const w = await syncWorld({ environment: false });

		const { outcome } = await sync(w);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(stateOf(w.world)).toMatchObject({
			generation: 1,
			accessRuleHash: expect.any(String)
		});
		expect(stateOf(w.world)!.gates).toBeUndefined();
		expect(w.applies).toEqual([]);
	});

	it('ignores a revoked rule and a deleted environment', async () => {
		const w = await syncWorld();
		addRule(w.world, 'rule_1', ENV);
		w.world.sqlite.prepare('UPDATE site_access_rules SET revoked_at = 5').run();
		w.world.sqlite.prepare('UPDATE site_environments SET deleted_at = 5').run();

		await sync(w);

		expect(stateOf(w.world)!.gates).toBeUndefined();
	});

	it('rewrites nothing observable when the rules have not changed', async () => {
		const w = await syncWorld({ copy: true });
		addRule(w.world, 'rule_1', ENV);
		await sync(w);
		const first = w.world.authority.snapshot();
		const writes = w.applies.length;

		const again = await sync(w, { operationId: `op_${'q'.repeat(26)}` });

		expect(again.outcome).toEqual({ status: 'succeeded' });
		expect(w.applies).toHaveLength(writes);
		expect(w.world.authority.snapshot()).toEqual(first);
	});

	it('changes the digest when a rule is added and again when it is removed', async () => {
		const w = await syncWorld();
		await sync(w);
		const bare = stateOf(w.world)!.gates![ENV];
		addRule(w.world, 'rule_1', ENV);
		await sync(w, { operationId: `op_${'a'.repeat(26)}` });
		const withRule = stateOf(w.world)!.gates![ENV];
		w.world.sqlite.prepare('UPDATE site_access_rules SET revoked_at = 5').run();
		await sync(w, { operationId: `op_${'b'.repeat(26)}` });

		expect(withRule).not.toBe(bare);
		expect(stateOf(w.world)!.gates![ENV]).toBe(bare);
		expect(stateOf(w.world)!.generation).toBe(4);
	});

	it('is killed after each step and resumes to the same state', async () => {
		const reference = await syncWorld({ copy: true });
		addRule(reference.world, 'rule_1', ENV);
		await sync(reference);
		const want = reference.world.authority.snapshot();

		for (let killAfter = 0; killAfter <= 8; killAfter++) {
			const w = await syncWorld({ copy: true });
			addRule(w.world, 'rule_1', ENV);
			const memo: Memo = new Map();
			try {
				await sync(w, { memo, killAfter });
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
			const resumed = await sync(w, { memo });
			expect(resumed.outcome, `killed after ${killAfter}`).toEqual({ status: 'succeeded' });
			expect(w.world.authority.snapshot(), `killed after ${killAfter}`).toEqual(want);
		}
	});

	it('writes once when killed after the write and before its result was saved', async () => {
		for (let during = 1; during <= 8; during++) {
			const attempt = await syncWorld();
			addRule(attempt.world, 'rule_1', ENV);
			const kept: Memo = new Map();
			try {
				await sync(attempt, { memo: kept, killDuring: during });
			} catch (error) {
				if (!(error instanceof Killed)) throw error;
			}
			await sync(attempt, { memo: kept });
			expect(stateOf(attempt.world)!.generation).toBe(2);
			expect(attempt.applies, `killed during ${during}`).toEqual([2]);
		}
	});

	it('fails the operation when the authority refuses the write', async () => {
		const w = await syncWorld();
		addRule(w.world, 'rule_1', ENV);
		w.deps.authority = {
			...w.deps.authority,
			apply: async () => {
				throw new PermanentError('authority_bad_signature', 'refused');
			}
		};

		const { outcome } = await sync(w);

		expect(outcome.status).toBe('failed');
		const operation = (await w.world.store.get(w.world.operationId))!;
		expect(operation.status).toBe('failed');
		expect(stateOf(w.world)!.generation).toBe(1);
	});

	it('fails when the authority does not hold the digests after the write', async () => {
		const w = await syncWorld();
		addRule(w.world, 'rule_1', ENV);
		w.deps.authority = {
			...w.deps.authority,
			apply: async () => ({ applied: false, generation: 1 })
		};

		const { outcome } = await sync(w);

		expect(outcome.status).toBe('failed');
		expect(outcome.status === 'failed' && outcome.reason).toContain('authority_unchanged');
	});

	it('fails when the site has no authority record', async () => {
		const world = await makeWorld();
		const db = (world.ledger as unknown as { db: D1Database }).db;
		const w = { world, deps: { ...world.deps, access: new D1AccessLedger(db) } };

		const { outcome } = await sync(w);

		expect(outcome.status).toBe('failed');
		expect(outcome.status === 'failed' && outcome.reason).toContain('no_authority');
	});

	it('skips an environment copy that never got an authority record', async () => {
		const w = await syncWorld();
		addEnvironment(w.world, COPY_SITE, `env_${'f'.repeat(26)}`);

		const { outcome } = await sync(w);

		expect(outcome).toEqual({ status: 'succeeded' });
		expect(stateOf(w.world, COPY_SITE)).toBeUndefined();
	});

	it('refuses an operation that names another organisation', async () => {
		const w = await syncWorld();
		const input = { ...inputOf(w.world), orgId: `org_${'x'.repeat(26)}` };
		await begin(w.world, inputOf(w.world));
		const { runner } = makeRunner(new Map());

		const outcome = await runAccessSync(runner, w.deps, input);

		expect(outcome.status).toBe('failed');
		expect(stateOf(w.world)!.generation).toBe(1);
	});
});

describe('the host route', () => {
	it('carries the environment only when there is one', () => {
		const base = { siteId: `site_${'a'.repeat(26)}`, script: 'tenant', epoch: 1 };
		expect(JSON.parse(hostValue(base))).toEqual({ v: 1, ...base });
		expect(JSON.parse(hostValue({ ...base, environment: ENV }))).toEqual({
			v: 1,
			...base,
			environment: ENV
		});
	});
});

describe('a rule saved reaches dispatch within one lease interval', () => {
	const HOST = 'quiet-otter.drupflare.app';

	async function rigWorld() {
		const world = await makeWorld();
		const rig = await makeRig();
		const db = (world.ledger as unknown as { db: D1Database }).db;
		const siteAuth = {
			read: async () => readAuthority(rig.kv) ?? null,
			apply: (message: unknown) =>
				applyTo(rig.kv, message, {
					controlKey: rig.control.publicKey,
					now: rig.clock.now()
				})
		};
		const deps: AccessDeps = {
			...world.deps,
			authority: authorityOf({
				siteAuth: () => siteAuth,
				hosts: {
					put: async () => undefined,
					deleteIfOwned: async () => 'absent'
				},
				controlKey: rig.control.privateKey,
				now: rig.clock.now
			}),
			access: new D1AccessLedger(db)
		};
		await rig.commit(initial(world.siteId, { risk: 'established' }));
		addEnvironment(world, null);
		const gateKey = await generateSigningKey();
		const gate: GateDeps = {
			publicKey: gateKey.publicKey,
			origin: 'https://gate.test',
			seen: new Set()
		};
		const served: string[] = [];
		const route = hostValue({
			siteId: world.siteId,
			script: 'tenant-one',
			epoch: 1,
			environment: ENV
		});
		const serveDeps: ServeDeps = {
			now: rig.clock.now,
			publicKey: rig.lease.publicKey,
			readRoute: async (host) => (host === HOST ? route : null),
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
			waitUntil: () => undefined,
			gate
		};
		const get = (headers: Record<string, string> = {}) =>
			serve(new Request(`https://${HOST}/page`, { headers }), serveDeps);
		const mint = (ruleHash: string) =>
			signGateAssertion(
				{ siteId: world.siteId, environment: ENV, ruleHash, sub: 'visitor' },
				rig.clock.now(),
				gateKey
			);
		const arrive = async (ruleHash: string) =>
			serve(
				new Request(
					`https://${HOST}/page?${GATE_PARAM}=${encodeAssertion(await mint(ruleHash))}`
				),
				serveDeps
			);
		return { world, rig, deps, get, arrive, served };
	}

	it('refuses a cookie minted under the old digest once the lease renews', async () => {
		const w = await rigWorld();
		await sync(w);
		const oldDigest = readAuthority(w.rig.kv)!.gates![ENV]!;
		const arrived = await w.arrive(oldDigest);
		const cookie = arrived.headers.get('set-cookie')!.split(';')[0]!;
		expect((await w.get({ cookie })).status).toBe(200);

		addRule(w.world, 'rule_1', ENV);
		const { outcome } = await sync(w, { operationId: `op_${'n'.repeat(26)}` });
		expect(outcome).toEqual({ status: 'succeeded' });
		const newDigest = readAuthority(w.rig.kv)!.gates![ENV]!;
		expect(newDigest).not.toBe(oldDigest);

		// the held lease still carries the old digest until it is renewed
		expect((await w.get({ cookie })).status).toBe(200);

		w.rig.clock.advance(DEFAULT_LEASE_MS + DEFAULT_CLOCK_SKEW_MS + 1);
		const stale = await w.get({ cookie });
		expect(stale.status).toBe(302);
		expect(stale.headers.get('location')).toContain('https://gate.test');

		const fresh = await w.arrive(newDigest);
		const next = await w.get({ cookie: fresh.headers.get('set-cookie')!.split(';')[0]! });
		expect(next.status).toBe(200);
	});

	it('gates the environment host from the first sync and leaves production public', async () => {
		const w = await rigWorld();
		await sync(w);
		const state = readAuthority(w.rig.kv)!;

		expect(Object.keys(state.gates ?? {})).toEqual([ENV]);
		expect((await w.get()).status).toBe(302);
		expect(w.served).toEqual([]);
	});
});
