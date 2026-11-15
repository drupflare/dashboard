import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { rollbackFactsOf } from '../../../engine/src/adapters/rollback';
import { D1RolloutStore, ringObserverOf, siteMoverOf } from '../../../engine/src/adapters/rollout';
import type { StoredRollout } from '../../../engine/src/ports';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import { RING_METRICS } from '../../../src/server/domain/rings';
import { beginCreate, makeRunner, makeWorld } from './fakes';

const stored = (over: Partial<StoredRollout> = {}): StoredRollout => ({
	id: 'op_1',
	releaseId: 'rel-a',
	state: {
		releaseId: 'rel-a',
		order: ['R0', 'R1'],
		current: 0,
		received: ['R0'],
		status: 'rolling',
		reasons: []
	},
	progress: {},
	previous: {},
	firstRingAt: null,
	lastRingAt: null,
	...over
});

describe('the rollout row', () => {
	async function row() {
		const world = await makeWorld();
		world.sqlite
			.prepare(
				`INSERT INTO release_rollouts (id, release_id, operation_id, status, state, progress,
					previous, stop_requested, created_at, updated_at)
				 VALUES ('op_1', 'rel-a', 'op_1', 'rolling', '{}', '{}', '{}', 0, 1, 1)`
			)
			.run();
		const db = (world.deps.store as unknown as { db: D1Database }).db;
		return { world, store: new D1RolloutStore(db, () => 7) };
	}

	it('gives null for a rollout nobody created', async () => {
		const { store } = await row();
		expect(await store.load('op_none')).toBeNull();
		expect(await store.stopRequested('op_none')).toBe(false);
	});

	it('saves and loads the state, progress and times, and leaves the stop flag alone', async () => {
		const { world, store } = await row();
		world.sqlite.prepare(`UPDATE release_rollouts SET stop_requested = 1`).run();
		const next = stored({
			progress: { R0: { upgraded: ['site_1'], failed: [], reverted: [], stuck: [] } },
			previous: { site_1: 'rel-old' },
			firstRingAt: 5,
			lastRingAt: 6
		});
		await store.save(next);
		expect(await store.load('op_1')).toEqual(next);
		expect(await store.stopRequested('op_1')).toBe(true);
		const status = world.sqlite
			.prepare('SELECT status, updated_at FROM release_rollouts')
			.get();
		expect(status).toMatchObject({ status: 'rolling', updated_at: 7 });
	});
});

describe('starting a site update or rollback', () => {
	async function ready() {
		const world = await makeWorld();
		await beginCreate(world);
		await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
		world.sqlite
			.prepare(
				`UPDATE sites SET account_id = 'acct_1', primary_hostname = 'site.example.test'`
			)
			.run();
		const started: {
			kind: string;
			id: string;
			params: { releaseId: string; currentRelease: string | null };
		}[] = [];
		const starter = (kind: string, failWith?: Error) => ({
			async create(options: { id: string; params: never }) {
				if (failWith) throw failWith;
				started.push({ kind, ...(options as object) } as never);
			}
		});
		const db = (world.deps.store as unknown as { db: D1Database }).db;
		const mover = (failWith?: Error) =>
			siteMoverOf({
				db,
				store: world.deps.store,
				upgrade: starter('upgrade', failWith),
				rollback: starter('rollback'),
				now: world.clock.now
			});
		return { world, started, mover };
	}

	it('reads the release a site runs now', async () => {
		const { world, mover } = await ready();
		expect(await mover().current(world.siteId)).toBe('v1.0.4');
	});

	it('records an operation and starts the workflow once for a key, however often it is asked', async () => {
		const { world, started, mover } = await ready();
		const site = { id: world.siteId, plan: 'free' };
		const first = await mover().upgrade(site, 'v1.0.5', 'roll-1:upgrade:site');
		const again = await mover().upgrade(site, 'v1.0.5', 'roll-1:upgrade:site');
		expect(again).toBe(first);
		expect(first).toMatch(/^op_[0-9a-f]{26}$/);
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			kind: 'upgrade',
			params: { releaseId: 'v1.0.5', currentRelease: 'v1.0.4' }
		});
		expect(await world.deps.store.get(first)).toMatchObject({ type: 'site.upgrade' });
	});

	it('starts a rollback as its own operation type', async () => {
		const { world, started, mover } = await ready();
		const id = await mover().rollback(
			{ id: world.siteId, plan: 'free' },
			'v1.0.3',
			'roll-1:rollback:site'
		);
		expect(started[0]).toMatchObject({ kind: 'rollback', params: { releaseId: 'v1.0.3' } });
		expect(await world.deps.store.get(id)).toMatchObject({ type: 'site.rollback' });
	});

	it('maps an operation to running, succeeded or failed, and an unknown one to failed', async () => {
		const { world, mover } = await ready();
		const id = await mover().upgrade(
			{ id: world.siteId, plan: 'free' },
			'v1.0.5',
			'roll-2:upgrade:site'
		);
		expect(await mover().status(id)).toBe('running');
		expect(await mover().status('op_missing')).toBe('failed');
		for (const [status, expected] of [
			['succeeded', 'succeeded'],
			['failed', 'failed'],
			['rolled-back', 'failed'],
			['cancelled', 'failed']
		] as const) {
			world.sqlite.prepare('UPDATE operations SET status = ? WHERE id = ?').run(status, id);
			expect(await mover().status(id)).toBe(expected);
		}
	});

	it('treats a workflow instance that already exists as started, and any other failure as a failure', async () => {
		const { world, mover } = await ready();
		const site = { id: world.siteId, plan: 'free' };
		await expect(
			mover(new Error('instance.already_exists')).upgrade(
				site,
				'v1.0.5',
				'roll-3:upgrade:site'
			)
		).resolves.toMatch(/^op_/);
		await expect(
			mover(new Error('network down')).upgrade(site, 'v1.0.6', 'roll-4:upgrade:site')
		).rejects.toThrow('network down');
	});

	it('refuses a site row that is missing or not live', async () => {
		const { world, mover } = await ready();
		await expect(mover().current('site_none')).rejects.toThrow('no site row');
		world.sqlite.prepare('UPDATE sites SET primary_hostname = NULL').run();
		await expect(
			mover().upgrade({ id: world.siteId, plan: 'free' }, 'v1.0.5', 'roll-5:upgrade:site')
		).rejects.toThrow('not live');
	});
});

describe('what the ring reports', () => {
	function observer(
		options: { down?: string[]; findings?: Record<string, number>; probe?: number } = {}
	) {
		const probed: string[] = [];
		return {
			probed,
			observe: ringObserverOf({
				backups: {
					async site(id) {
						return id === 'site_gone'
							? null
							: ({ primaryHostname: `${id}.example.test` } as never);
					}
				},
				custody: {
					async sealed(id: string) {
						return {
							ownerTokenId: id === 'site_nokey' ? null : `tok_${id}`,
							pendingSecretId: null
						};
					},
					async withOwnerToken(
						id: string,
						_token: string,
						use: (bearer: string) => Promise<unknown>
					) {
						if (options.down?.includes(id)) throw new Error('refused');
						return use('bearer');
					}
				} as never,
				repair: {
					async observe(hostname: string) {
						const id = hostname.split('.')[0] as string;
						return { findings: Array(options.findings?.[id] ?? 0).fill('x') } as never;
					},
					async call() {
						throw new Error('unused');
					}
				},
				site: {
					async probe(hostname: string) {
						probed.push(hostname);
						return { status: options.probe ?? 200 };
					}
				} as never
			})
		};
	}

	const probe = (siteIds: string[], syntheticIds: string[] = []) => ({
		ring: 'R0' as const,
		releaseId: 'rel-a',
		siteIds,
		syntheticIds
	});

	it('counts findings and sites that answered, and leaves every other metric missing', async () => {
		const { observe } = observer({ findings: { site_a: 2, site_b: 1 } });
		const seen = await observe(probe(['site_a', 'site_b']));
		expect(seen).toMatchObject({
			ring: 'R0',
			metrics: { repairFindings: 3 },
			observedSites: 2,
			expectedSites: 2
		});
		const missing = RING_METRICS.filter((metric) => seen.metrics[metric] === undefined);
		expect(missing).toEqual([
			'failureRate',
			'resets',
			'memoryTrend',
			'coldBoots',
			'writeFailures'
		]);
		expect(seen.syntheticHealthy).toBeUndefined();
	});

	it('does not count a site that is gone, has no key or refused the token', async () => {
		const { observe } = observer({ down: ['site_down'] });
		const seen = await observe(probe(['site_a', 'site_gone', 'site_nokey', 'site_down']));
		expect(seen).toMatchObject({ observedSites: 1, expectedSites: 4 });
	});

	it('reads the synthetic site by probing its front page', async () => {
		const ok = observer();
		expect(
			(await ok.observe(probe(['site_a', 'site_syn'], ['site_syn']))).syntheticHealthy
		).toBe(true);
		expect(ok.probed).toEqual(['site_syn.example.test']);
		const broken = observer({ probe: 500 });
		expect((await broken.observe(probe(['site_syn'], ['site_syn']))).syntheticHealthy).toBe(
			false
		);
		const silent = observer({ down: ['site_syn'] });
		expect((await silent.observe(probe(['site_syn'], ['site_syn']))).syntheticHealthy).toBe(
			false
		);
	});
});

describe('the facts a rollback is judged on', () => {
	it('reads the site data version and the target release, and null for what is not there', async () => {
		const world = await makeWorld();
		await beginCreate(world);
		await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
		world.sqlite
			.prepare(
				`INSERT INTO releases (id, kind, version, manifest_digest, schema_version, accepts_schema,
					published_at, created_at) VALUES ('rel-a', 'worker', '1', 'd', 3, 2, 1, 1)`
			)
			.run();
		world.sqlite.prepare('UPDATE sites SET data_schema_version = 3').run();
		const db = (world.deps.store as unknown as { db: D1Database }).db;
		const facts = rollbackFactsOf(db);
		expect(await facts(world.siteId, 'rel-a')).toEqual({
			dataSchemaVersion: 3,
			target: { schemaVersion: 3, acceptsSchema: 2 }
		});
		expect(await facts('site_none', 'rel-none')).toEqual({
			dataSchemaVersion: null,
			target: null
		});
	});
});
