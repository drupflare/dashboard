import { beforeAll, describe, expect, it } from 'vitest';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	beginCreate,
	custodyRows,
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	snapshotWorld,
	type Memo,
	type RunnerScript,
	type World
} from './fakes';

async function start(options: Parameters<typeof makeWorld>[0] = {}) {
	const world = await makeWorld(options);
	await beginCreate(world);
	return world;
}

function attempt(world: World, memo: Memo, script: RunnerScript = {}) {
	const { runner, executed } = makeRunner(memo, script);
	return { executed, done: runSiteCreate(runner, world.deps, world.input) };
}

async function reference(options: Parameters<typeof makeWorld>[0] = {}) {
	const world = await start(options);
	const run = attempt(world, new Map());
	const outcome = await run.done;
	return { world, outcome, steps: run.executed, snapshot: await snapshotWorld(world) };
}

describe('an uninterrupted create', () => {
	it('runs every step once and leaves one of each resource', async () => {
		const { world, outcome, steps, snapshot } = await reference();
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(steps).toEqual([
			'start',
			'lease',
			'reserve-name',
			'resource.CONFIG_KV',
			'resource.PAGE_KV',
			'resource.FILES',
			'resource.FILES_PRIVATE',
			'assets.session',
			'assets.upload.0',
			'assets.upload.1',
			'assets.upload.2',
			'assets.complete',
			'upload-script',
			'authority',
			'route',
			'first-run',
			'verify',
			'activate',
			'finalize',
			'release-lease'
		]);
		expect(snapshot.operation).toMatchObject({
			status: 'succeeded',
			verification: 'passed',
			fencingEpoch: 1,
			cursor: 'assets:3/3'
		});
		expect(snapshot.operation?.steps.every(([, state]) => state === 'succeeded')).toBe(true);
		expect(snapshot.resources).toHaveLength(5);
		expect(snapshot.account.kv).toHaveLength(2);
		expect(snapshot.account.r2).toHaveLength(2);
		expect(snapshot.account.scripts).toHaveLength(1);
		expect(snapshot.siteState).toBe('active');
		expect(snapshot.lease.holder).toBeNull();
		expect(world.authority.stateOf(world.siteId)).toMatchObject({
			state: 'active',
			generation: 1
		});
		expect(snapshot.authority.hosts).toHaveLength(1);
	});

	it('spends one lookup and one create call per resource', async () => {
		const { world } = await reference();
		expect(world.cf.counts.create).toBe(4);
		expect(world.cf.counts.find).toBe(4);
	});

	it('uploads the assets before the script, since the script carries the completion token', async () => {
		const { steps } = await reference();
		expect(steps.indexOf('assets.complete')).toBeLessThan(steps.indexOf('upload-script'));
	});

	it('creates a database and no bucket on the canonical config when asked for one', async () => {
		const { snapshot } = await reference({ config: 'canonical', database: true });
		expect(snapshot.account.kv).toHaveLength(2);
		expect(snapshot.account.d1).toHaveLength(1);
		expect(snapshot.account.r2).toHaveLength(0);
		expect(snapshot.operation?.status).toBe('succeeded');
	});
});

describe('kill and resume', () => {
	let ref: Awaited<ReturnType<typeof reference>>;
	beforeAll(async () => {
		ref = await reference();
	});

	it('ends in the uninterrupted state when killed before any later step starts', async () => {
		for (let k = 0; k < ref.steps.length; k++) {
			const world = await start();
			const memo: Memo = new Map();
			await expect(attempt(world, memo, { killAfter: k }).done).rejects.toBeInstanceOf(
				Killed
			);
			const outcome = await attempt(world, memo).done;
			expect(outcome, `killed after ${k}`).toEqual({ status: 'succeeded' });
			expect(await snapshotWorld(world), `killed after ${k}`).toEqual(ref.snapshot);
		}
	});

	it('ends in the uninterrupted state when killed after a step ran but before it was saved', async () => {
		for (let j = 1; j <= ref.steps.length; j++) {
			const world = await start();
			const memo: Memo = new Map();
			await expect(attempt(world, memo, { killDuring: j }).done).rejects.toBeInstanceOf(
				Killed
			);
			const outcome = await attempt(world, memo).done;
			expect(outcome, `killed during ${ref.steps[j - 1]}`).toEqual({ status: 'succeeded' });
			expect(await snapshotWorld(world), `killed during ${ref.steps[j - 1]}`).toEqual(
				ref.snapshot
			);
		}
	});

	it('survives being killed again on the way', async () => {
		for (let k = 1; k < ref.steps.length - 2; k++) {
			const world = await start();
			const memo: Memo = new Map();
			await expect(attempt(world, memo, { killAfter: k }).done).rejects.toBeInstanceOf(
				Killed
			);
			await expect(attempt(world, memo, { killDuring: 2 }).done).rejects.toBeInstanceOf(
				Killed
			);
			await expect(attempt(world, memo, { killAfter: 1 }).done).rejects.toBeInstanceOf(
				Killed
			);
			await attempt(world, memo).done;
			expect(await snapshotWorld(world), `killed after ${k}`).toEqual(ref.snapshot);
		}
	});

	it('never has a resource twice, whichever step it dies in', async () => {
		for (let j = 1; j <= ref.steps.length; j++) {
			const world = await start();
			const memo: Memo = new Map();
			await expect(attempt(world, memo, { killDuring: j }).done).rejects.toBeInstanceOf(
				Killed
			);
			await attempt(world, memo).done;
			const snapshot = await snapshotWorld(world);
			expect(new Set(snapshot.account.kv.map(([, title]) => title)).size).toBe(2);
			expect(new Set(snapshot.resources.map((row) => row[1])).size).toBe(5);
			expect(world.cf.counts.create).toBe(4);
		}
	});

	it('adopts a resource whose id was never recorded instead of creating it again', async () => {
		const world = await start();
		const memo: Memo = new Map();
		const fill = world.deps.ledger.fill.bind(world.deps.ledger);
		let fills = 0;
		world.deps.ledger.fill = async (id, providerId, fingerprint) => {
			if (++fills === 2) throw new Killed(0);
			return fill(id, providerId, fingerprint);
		};
		await expect(attempt(world, memo).done).rejects.toBeInstanceOf(Killed);
		expect(world.cf.snapshot().kv).toHaveLength(2);
		const rows = await world.ledger.live(world.siteId);
		expect(rows.map((row) => [row.binding, row.providerId !== null])).toEqual([
			['CONFIG_KV', true],
			['PAGE_KV', false]
		]);
		const outcome = await attempt(world, memo).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(await snapshotWorld(world)).toEqual(ref.snapshot);
		expect(world.cf.counts.create).toBe(4);
	});

	it('calls the site once when killed inside the first-run step, and keeps the one sealed secret', async () => {
		const world = await start();
		const memo: Memo = new Map();
		const index = ref.steps.indexOf('first-run') + 1;
		await expect(attempt(world, memo, { killDuring: index }).done).rejects.toBeInstanceOf(
			Killed
		);
		expect(custodyRows(world)).toMatchObject({ ownerToken: true });
		const outcome = await attempt(world, memo).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(world.site.calls.firstRun).toBe(1);
		expect(custodyRows(world)).toEqual(ref.snapshot.custody);
		expect(world.site.bearers).toEqual([FAKE_OWNER_TOKEN]);
	});
});

const FORWARD = [
	'start',
	'lease',
	'reserve-name',
	'resource.CONFIG_KV',
	'resource.PAGE_KV',
	'resource.FILES',
	'resource.FILES_PRIVATE',
	'assets.session',
	'assets.upload.0',
	'assets.upload.2',
	'assets.complete',
	'upload-script',
	'authority',
	'route',
	'first-run',
	'verify',
	'activate'
];

async function expectClean(world: World, label: string) {
	const snapshot = await snapshotWorld(world);
	expect(snapshot.account.kv, label).toEqual([]);
	expect(snapshot.account.r2, label).toEqual([]);
	expect(snapshot.account.d1, label).toEqual([]);
	expect(snapshot.account.scripts, label).toEqual([]);
	expect(await world.ledger.live(world.siteId), label).toEqual([]);
	expect(snapshot.authority.hosts, label).toEqual([]);
	expect(snapshot.custody, label).toEqual({ ownerToken: false, pending: [] });
	for (const [, state] of snapshot.authority.states as [string, { state: string } | null][]) {
		expect(state?.state ?? 'revoked', label).toBe('revoked');
	}
	expect([null, 'deleted'], label).toContain(snapshot.siteState);
	expect(world.names.isFree(world.input.subdomain), label).toBe(true);
	expect(snapshot.lease.holder, label).toBeNull();
	const states = snapshot.operation?.steps.map(([, state]) => state) ?? [];
	expect(states, label).not.toContain('pending');
	expect(states, label).not.toContain('running');
}

describe('a failed create', () => {
	for (const when of ['before', 'after'] as const) {
		it(`rolls back everything it made when any step fails ${when} its work`, async () => {
			for (const step of FORWARD) {
				const world = await start();
				const outcome = await attempt(world, new Map(), { failAt: { step, when } }).done;
				const label = `${step} ${when}`;
				// nothing exists to undo before the lease is taken; after it, the rollback runs
				const nothingToUndo =
					(step === 'start' && when === 'after') ||
					(step === 'lease' && when === 'before');
				const expected =
					step === 'start' && when === 'before'
						? 'cancelled'
						: nothingToUndo
							? 'failed'
							: 'rolled-back';
				expect(outcome.status, label).toBe(expected);
				await expectClean(world, label);
			}
		});
	}

	it('records the failed step and ends the operation as rolled back', async () => {
		const world = await start();
		const outcome = await attempt(world, new Map(), {
			failAt: { step: 'verify', when: 'before' }
		}).done;
		expect(outcome.status).toBe('rolled-back');
		const operation = await world.store.get(world.operationId);
		expect(operation?.status).toBe('rolled-back');
		const failed = operation?.steps.find((step) => step.id === 'verify');
		expect(failed?.state).toBe('failed');
		expect(operation?.finalObservation?.summary).toContain('verify');
	});

	it('rolls back again to the same state when killed during the rollback', async () => {
		const failAt = { step: 'upload-script', when: 'after' } as const;
		const clean = await start();
		const run = attempt(clean, new Map(), { failAt });
		await run.done;
		const expected = await snapshotWorld(clean);
		const rollbackSteps = run.executed.length;
		for (let j = 1; j <= rollbackSteps; j++) {
			const world = await start();
			const memo: Memo = new Map();
			await expect(
				attempt(world, memo, { failAt, killDuring: j }).done
			).rejects.toBeInstanceOf(Killed);
			await attempt(world, memo, { failAt }).done;
			expect(await snapshotWorld(world), `killed during ${j}`).toEqual(expected);
		}
	});

	it('names the rollback steps it could not finish and keeps the operation failed', async () => {
		const world = await start();
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			deleteResource: async (kind, id) => {
				if (kind === 'kv') throw new Error('api down');
				return real.deleteResource(kind, id);
			}
		};
		const outcome = await attempt(world, new Map(), {
			failAt: { step: 'verify', when: 'before' }
		}).done;
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.leaked).toEqual(['resource.PAGE_KV', 'resource.CONFIG_KV']);
		const operation = await world.store.get(world.operationId);
		expect(operation?.status).toBe('failed');
		expect(operation?.finalObservation?.summary).toContain('rollback incomplete');
		expect(world.cf.snapshot().kv).toHaveLength(2);
		expect(world.cf.snapshot().r2).toHaveLength(0);
	});

	it('rolls back when the bundle breaks a size gate, with the typed error in the record', async () => {
		const world = await start();
		world.deps.config.limits.maxAssets = 1;
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('too_many_assets');
		await expectClean(world, 'size gate');
	});

	it('rolls back when an asset does not match its hash', async () => {
		const world = await start();
		const key = [...world.bundle.parts.keys()].find((part) => part.includes('/assets/'))!;
		world.bundle.parts.set(key, new TextEncoder().encode('tampered'));
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		await expectClean(world, 'tampered asset');
	});

	it('leaves another holder alone when the site is busy', async () => {
		const world = await start();
		await world.deps.leases.acquire(world.siteId, {
			holder: 'op_repair00000000',
			purpose: 'repair.run',
			ttlMs: 60_000
		});
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('site_busy');
		expect(world.leases.stateOf(world.siteId).holder?.id).toBe('op_repair00000000');
		expect(world.cf.snapshot().kv).toEqual([]);
		expect(world.names.recordOf(world.input.subdomain)).toBeNull();
	});

	it('does not roll back when the lease was lost mid-run, and leaves the new holder alone', async () => {
		const world = await start();
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			createResource: async (kind, name) => {
				// the holder is slow; its lease runs out and a repair takes the site
				world.clock.advance(world.deps.config.leaseTtlMs + 1);
				await world.deps.leases.acquire(world.siteId, {
					holder: 'op_repair00000000',
					purpose: 'repair.run',
					ttlMs: 60_000
				});
				return real.createResource(kind, name);
			}
		};
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('lease_lost');
		expect(outcome.leaked.length).toBeGreaterThan(0);
		expect(world.leases.stateOf(world.siteId).holder?.id).toBe('op_repair00000000');
		expect(world.leases.stateOf(world.siteId).epoch).toBe(2);
		expect(world.cf.snapshot().kv).toHaveLength(1);
	});

	it('leaves a name another site holds with its owner', async () => {
		const world = await start();
		await world.deps.names.reserve(world.input.subdomain, 'site_other000000000');
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('name_taken');
		expect(world.names.recordOf(world.input.subdomain)).toEqual({
			state: 'taken',
			siteId: 'site_other000000000'
		});
	});

	it('is cancelled before it starts when ten production deploys already run', async () => {
		const world = await start();
		world.deps.store.runningProductionDeploys = async () => 10;
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('cancelled');
		const operation = await world.store.get(world.operationId);
		expect(operation?.status).toBe('cancelled');
		expect(world.cf.snapshot().kv).toEqual([]);
	});
});

describe('a rollback and a hostname that another site holds', () => {
	const OTHER = `site_${'x'.repeat(26)}`;
	const theirs = { siteId: OTHER, script: `s-${'x'.repeat(26)}`, epoch: 1 };

	async function held() {
		const world = await start();
		await world.names.names.reserve(world.input.subdomain, OTHER);
		await world.authority.authority.putHost(world.input.hostname, theirs);
		return world;
	}

	it('leaves the other site route as it was when the name is taken', async () => {
		const world = await held();
		const before = JSON.stringify(world.authority.snapshot().hosts);
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('name_taken');
		expect(JSON.stringify(world.authority.snapshot().hosts)).toBe(before);
		expect(world.authority.snapshot().hosts).toEqual([[world.input.hostname, theirs]]);
	});

	it('converges to the same state when killed at any point of that rollback', async () => {
		const clean = await held();
		const run = attempt(clean, new Map());
		await run.done;
		const expected = await snapshotWorld(clean);
		for (let j = 1; j <= run.executed.length; j++) {
			// a step that fails by itself never reaches its kill point
			if (run.executed[j - 1] === 'reserve-name') continue;
			const world = await held();
			const memo: Memo = new Map();
			await expect(attempt(world, memo, { killDuring: j }).done).rejects.toBeInstanceOf(
				Killed
			);
			await attempt(world, memo).done;
			expect(await snapshotWorld(world), `killed during ${j}`).toEqual(expected);
		}
	});

	// the route step ran, then the hostname was taken over before the rollback
	async function takenOver() {
		const world = await start();
		const put = world.deps.authority.putHost.bind(world.deps.authority);
		world.deps.authority.putHost = async (host, route) => {
			await put(host, route);
			await put(host, theirs);
		};
		return world;
	}

	it('leaves a route that changed hands during the create and says so in the record', async () => {
		const world = await takenOver();
		const outcome = await attempt(world, new Map(), {
			failAt: { step: 'verify', when: 'before' }
		}).done;
		expect(outcome.status).toBe('rolled-back');
		expect(world.authority.snapshot().hosts).toEqual([[world.input.hostname, theirs]]);
		const operation = await world.store.get(world.operationId);
		expect(operation?.status).toBe('rolled-back');
		expect(operation?.finalObservation?.summary).toContain(
			`route for ${world.input.hostname} belongs to another site and was left in place`
		);
	});

	it('converges after a kill during that rollback and keeps the note', async () => {
		const failAt = { step: 'verify', when: 'before' } as const;
		const clean = await takenOver();
		const run = attempt(clean, new Map(), { failAt });
		await run.done;
		const expected = await snapshotWorld(clean);
		for (let j = 1; j <= run.executed.length; j++) {
			// the injected failure comes before the step's work, so it has no kill point
			if (run.executed[j - 1] === 'verify') continue;
			const world = await takenOver();
			const memo: Memo = new Map();
			await expect(
				attempt(world, memo, { failAt, killDuring: j }).done
			).rejects.toBeInstanceOf(Killed);
			await attempt(world, memo, { failAt }).done;
			expect(await snapshotWorld(world), `killed during ${j}`).toEqual(expected);
			const operation = await world.store.get(world.operationId);
			expect(operation?.finalObservation?.summary).toContain('left in place');
		}
	});

	it('still removes its own route when the create rolls back', async () => {
		const world = await start();
		await attempt(world, new Map(), { failAt: { step: 'verify', when: 'before' } }).done;
		expect(world.authority.snapshot().hosts).toEqual([]);
	});
});
