import { describe, expect, it, vi } from 'vitest';
import { sweep, sweepAndLog } from '../../../engine/src/sweep';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import { beginCreate, makeRunner, makeWorld, type World } from './fakes';

const MIN = 60 * 1000;
const SCOPE = { accountId: 'a'.repeat(32) };

// the dashboard writes this row when it accepts the request; it stays hidden until the create ends
async function start() {
	const world = await makeWorld();
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, kind, category, plane, config, state,
			primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, 'Quiet Otter', 'drupal', 'cms', 'managed', 'managed', 'active', ?, NULL, 1, 1)`
		)
		.run(world.siteId, world.orgId, world.input.hostname);
	await beginCreate(world);
	return world;
}

// the create runs slowly enough that its lease lapses and a repair takes the site, so its
// rollback is refused and what it made stays behind
async function strand(world: World) {
	const real = world.deps.cloudflare;
	world.deps.cloudflare = {
		...real,
		createResource: async (kind, name) => {
			world.clock.advance(world.deps.config.leaseTtlMs + 1);
			await world.deps.leases.acquire(world.siteId, {
				holder: 'op_repair00000000',
				purpose: 'repair.run',
				ttlMs: 60_000
			});
			return real.createResource(kind, name);
		}
	};
	const outcome = await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
	world.deps.cloudflare = real;
	return outcome;
}

async function expectRecovered(world: World) {
	const account = world.cf.snapshot();
	expect(account.kv).toEqual([]);
	expect(account.r2).toEqual([]);
	expect(account.scripts).toEqual([]);
	expect(await world.ledger.live(world.siteId)).toEqual([]);
	expect(await world.store.siteState(world.siteId)).toBe('deleted');
	expect(world.names.isFree(world.input.subdomain)).toBe(true);
	expect((await world.store.get(world.operationId))?.status).toBe('rolled-back');
	expect(world.leases.stateOf(world.siteId).holder).toBeNull();
}

describe('the recovery sweep', () => {
	it('finishes the rollback of a create that failed with its lease lost, once the site is free', async () => {
		const world = await start();
		const outcome = await strand(world);
		expect(outcome.status).toBe('failed');
		expect(await world.store.siteState(world.siteId)).toBe('active');
		expect(world.cf.snapshot().kv).toHaveLength(1);

		world.clock.advance(61_000);
		const report = await sweep(world.deps, SCOPE);
		expect(report.recovered).toEqual([]);

		world.clock.advance(30 * MIN);
		const swept = await sweep(world.deps, SCOPE);
		expect(swept.recovered).toEqual([
			{ siteId: world.siteId, operationId: world.operationId, outcome: 'rolled-back' }
		]);
		await expectRecovered(world);
	});

	it('leaves the site alone while another holder has it, and takes it up on a later sweep', async () => {
		const world = await start();
		await strand(world);
		world.clock.advance(30 * MIN);
		await world.deps.leases.acquire(world.siteId, {
			holder: 'op_repair00000000',
			purpose: 'repair.run',
			ttlMs: 60 * MIN
		});
		const busy = await sweep(world.deps, SCOPE);
		expect(busy.recovered[0]?.outcome).toBe('failed');
		expect(world.cf.snapshot().kv).toHaveLength(1);
		expect(world.leases.stateOf(world.siteId).holder?.id).toBe('op_repair00000000');

		world.clock.advance(61 * MIN);
		const free = await sweep(world.deps, SCOPE);
		expect(free.recovered[0]?.outcome).toBe('rolled-back');
		await expectRecovered(world);
	});

	it('does nothing to a create that failed too recently, a finished site or a second sweep', async () => {
		const world = await start();
		await strand(world);
		expect(
			(await sweep(world.deps, { ...SCOPE, minFailedAgeMs: 24 * 60 * MIN })).recovered
		).toEqual([]);
		world.clock.advance(30 * MIN);
		await sweep(world.deps, SCOPE);
		expect((await sweep(world.deps, SCOPE)).recovered).toEqual([]);

		const done = await start();
		expect(
			(await runSiteCreate(makeRunner(new Map()).runner, done.deps, done.input)).status
		).toBe('succeeded');
		done.clock.advance(30 * MIN);
		expect((await sweep(done.deps, SCOPE)).recovered).toEqual([]);
		expect(done.cf.snapshot().kv).toHaveLength(2);
		expect(await done.store.siteState(done.siteId)).toBe('active');
	});

	it('reports an account resource that carries our name and no ledger row, and deletes nothing', async () => {
		const world = await start();
		await world.cf.cloudflare.createResource('kv', 's-abcdefgh1234-config');
		const report = await sweep(world.deps, SCOPE);
		expect(report.leaks?.leaks.map((leak) => leak.name)).toEqual(['s-abcdefgh1234-config']);
		expect(world.cf.snapshot().kv).toHaveLength(1);
	});

	it('logs one line with the report when it runs on its schedule', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			const world = await start();
			await strand(world);
			world.clock.advance(30 * MIN);
			await sweepAndLog(world.deps, SCOPE);
			expect(log).toHaveBeenCalledOnce();
			const line = JSON.parse(String(log.mock.calls[0]?.[0]));
			expect(line).toMatchObject({
				event: 'engine.sweep',
				recovered: [{ siteId: world.siteId, outcome: 'rolled-back' }]
			});
		} finally {
			log.mockRestore();
		}
	});
});
