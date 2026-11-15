import { beforeAll, describe, expect, it } from 'vitest';
import { scriptName } from '../../../contracts/src/sites';
import { encodeBundle } from '../../../engine/src/containers/image/template-build.mjs';
import { planSiteCreate, runSiteCreate } from '../../../engine/src/workflows/site-create';
import { workersDevHost } from '../../../src/shared/plane-connections';
import {
	beginCreate,
	custodyRows,
	FAKE_ADMIN_NAME,
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

function adminColumns(world: World) {
	const [row] = world.sqlite
		.prepare(`SELECT admin_name, admin_mail FROM sites WHERE id = '${world.siteId}'`)
		.all();
	return row;
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

	it('sends the owner mail in the first-run body and stores the admin the site reports', async () => {
		const { world } = await reference();
		expect(world.site.bodies.map((body) => JSON.parse(body!))).toEqual([
			{ adminMail: 'owner@example.test' }
		]);
		expect(adminColumns(world)).toEqual({
			admin_name: FAKE_ADMIN_NAME,
			admin_mail: 'owner@example.test'
		});
	});

	it('stores what the site answered, not what was sent', async () => {
		const world = await start();
		world.deps.site = {
			...world.deps.site,
			firstRun: async () => ({
				status: 200,
				secrets: { ownerToken: FAKE_OWNER_TOKEN, adminPassword: null },
				admin: { adminName: 'site-admin', adminMail: 'reset@example.test' }
			})
		};
		expect(await attempt(world, new Map()).done).toEqual({ status: 'succeeded' });
		expect(adminColumns(world)).toEqual({
			admin_name: 'site-admin',
			admin_mail: 'reset@example.test'
		});
	});

	it('leaves the admin columns null when the site reports no admin', async () => {
		const world = await start();
		world.deps.site = {
			...world.deps.site,
			firstRun: async () => ({
				status: 200,
				secrets: { ownerToken: FAKE_OWNER_TOKEN, adminPassword: null }
			})
		};
		expect(await attempt(world, new Map()).done).toEqual({ status: 'succeeded' });
		expect(adminColumns(world)).toEqual({ admin_name: null, admin_mail: null });
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

	it('keeps the lease through a run longer than its lifetime when every step is shorter', async () => {
		const world = await start();
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			createResource: (kind, name) => {
				world.clock.advance(Math.floor(world.deps.config.leaseTtlMs * 0.4));
				return real.createResource(kind, name);
			}
		};
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('succeeded');
		expect(world.leases.stateOf(world.siteId).epoch).toBe(1);
	});

	it('takes an expired lease back to roll back when no one else holds the site', async () => {
		const world = await start();
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			createResource: (kind, name) => {
				world.clock.advance(world.deps.config.leaseTtlMs + 1);
				return real.createResource(kind, name);
			}
		};
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('lease_lost');
		world.deps.cloudflare = real;
		await expectClean(world, 'expired lease');
		expect(world.leases.stateOf(world.siteId).epoch).toBe(2);
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

describe('a create from a template', () => {
	const COMMIT = 'c'.repeat(40);
	const KEY = 'templates/thunder/tpl_aaaaaaaa/bundle';
	const enc = new TextEncoder();

	const bundleOf = (sql: Uint8Array, over: Record<string, unknown> = {}) =>
		new Uint8Array(
			encodeBundle(
				{
					version: 1,
					entryId: 'thunder',
					commit: COMMIT,
					phpVersion: '8.4.27',
					buildSeconds: 1,
					rows: 3,
					advisories: [],
					patchesFailed: [],
					packages: 1,
					...over
				},
				[
					{ name: 'database.sql', bytes: sql },
					{ name: 'composer.lock', bytes: enc.encode('{}') }
				]
			)
		);

	// the site answers pending once for each wait before it answers applied
	async function withTemplate(
		options: {
			blob?: Uint8Array | null;
			states?: ('absent' | 'pending' | 'applied' | 'failed')[];
			firstRun?: boolean;
			// what each window of the lock answers, in order; the last one repeats
			windows?: (
				| 'absent'
				| {
						done: boolean;
						cursor: number;
						failure?: [string, string];
						skipped?: { name: string; reason: string }[];
				  }
			)[];
		} = {}
	) {
		const world = await makeWorld();
		world.input.template = { entryId: 'thunder', commit: COMMIT, bundleKey: KEY };
		if (options.firstRun === false) delete world.input.firstRun;
		await beginCreate(world);
		const blobs = new Map<string, Uint8Array>();
		const stored =
			options.blob === undefined
				? bundleOf(enc.encode('INSERT INTO a VALUES(1);'))
				: options.blob;
		if (stored !== null) blobs.set(KEY, stored);
		const restores: { hostname: string; body: Uint8Array; label: string }[] = [];
		const states = [...(options.states ?? ['pending', 'applied'])];
		let sent = false;
		const windows = [...(options.windows ?? [{ done: true, cursor: 1 }])];
		const locks: { cursor: number; body: string }[] = [];
		const rollbacks: string[] = [];
		const worker = {
			importState: async () => (sent ? (states.shift() ?? 'applied') : 'absent'),
			importReason: async () => 'users',
			restore: async (hostname: string, body: Uint8Array, label: string) => {
				sent = true;
				restores.push({ hostname, body, label });
			},
			installLock: async (_host: string, lock: Uint8Array, cursor: number) => {
				locks.push({ cursor, body: new TextDecoder().decode(lock) });
				const next = windows.length > 1 ? windows.shift() : windows[0];
				if (next === 'absent') return 'absent';
				return {
					done: next!.done,
					cursor: next!.cursor,
					total: 100,
					installed: 40,
					skipped: 0,
					failure: next!.failure
						? { name: next!.failure[0], error: next!.failure[1] }
						: null,
					session: 'a1b2c3d4e5f6a7b8',
					skippedPackages: next!.skipped ?? [],
					patches: 'not applied'
				};
			},
			rollbackLock: async (_host: string, session: string) => {
				rollbacks.push(session);
			}
		};
		const deps = {
			...world.deps,
			worker: worker as never,
			blobs: { get: async (key: string) => blobs.get(key) ?? null } as never,
			sleep: async (): Promise<void> => undefined,
			templateCodeDelivery: true
		};
		const run = (
			memo: Memo = new Map(),
			custom: Parameters<typeof runSiteCreate>[1] = deps
		) => {
			const { runner, executed } = makeRunner(memo, {});
			return { executed, done: runSiteCreate(runner, custom, world.input) };
		};
		return { world, run, restores, deps, locks, rollbacks };
	}

	it('installs the template code after the database and before the probe', async () => {
		const { run, locks } = await withTemplate({
			windows: [
				{ done: false, cursor: 40 },
				{ done: false, cursor: 80 },
				{ done: true, cursor: 100 }
			]
		});
		const { executed, done } = run();
		expect(await done).toEqual({ status: 'succeeded' });
		expect(locks.map((call) => call.cursor)).toEqual([0, 40, 80]);
		expect(locks[0]?.body).toBe('{}');
		expect(executed.indexOf('template-apply')).toBeLessThan(executed.indexOf('template-code'));
		expect(executed.indexOf('template-code')).toBeLessThan(executed.indexOf('verify'));
	});

	it('rolls back and names the package when the site cannot install one', async () => {
		const { run } = await withTemplate({
			windows: [{ done: false, cursor: 12, failure: ['drupal/token', 'archive 502'] }]
		});
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringMatching(/template_code_failed.*drupal\/token.*archive 502/)
		});
	});

	it('rolls back when the site has no lock route', async () => {
		const { run } = await withTemplate({ windows: ['absent'] });
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_code_unsupported')
		});
	});

	it('rolls back when the cursor stops advancing', async () => {
		const { run, locks } = await withTemplate({ windows: [{ done: false, cursor: 0 }] });
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_code_stalled')
		});
		expect(locks).toHaveLength(1);
	});

	it('restores the template database after the first run and before the probe', async () => {
		const { world, run, restores } = await withTemplate();
		const { executed, done } = run();
		expect(await done).toEqual({ status: 'succeeded' });
		expect(restores).toHaveLength(1);
		expect(restores[0]).toMatchObject({
			hostname: world.input.hostname,
			label: world.operationId
		});
		expect(new TextDecoder().decode(restores[0]?.body)).toBe('INSERT INTO a VALUES(1);');
		const at = (step: string) => executed.indexOf(step);
		expect(at('first-run')).toBeLessThan(at('template-restore'));
		expect(at('template-restore')).toBeLessThan(at('template-apply'));
		expect(at('template-apply')).toBeLessThan(at('verify'));
	});

	it('tells the owner the template replaced the first admin account', async () => {
		const { world, run } = await withTemplate();
		await run().done;
		const operation = await world.store.get(world.operationId);
		expect(operation?.finalObservation?.summary).toContain('thunder template replaced');
	});

	it('says which packages the lock skipped, and that patches were not applied', async () => {
		const { world, run } = await withTemplate({
			windows: [
				{
					done: true,
					cursor: 100,
					skipped: [
						{
							name: 'drupal/a',
							reason: 'a Composer plugin, which cannot run on the site'
						}
					]
				}
			]
		});
		expect(await run().done).toEqual({ status: 'succeeded' });
		const operation = await world.store.get(world.operationId);
		const summary = operation?.finalObservation?.summary ?? '';
		expect(summary).toContain(
			'1 package was skipped: drupal/a (a Composer plugin, which cannot run on the site)'
		);
		expect(summary).toContain('Patches Not Applied');
	});

	it('rolls back the lock session the site failed to install', async () => {
		const { run, rollbacks } = await withTemplate({
			windows: [{ done: false, cursor: 12, failure: ['drupal/token', 'archive 502'] }]
		});
		expect(await run().done).toMatchObject({ status: 'rolled-back' });
		expect(rollbacks).toEqual(['a1b2c3d4e5f6a7b8']);
	});

	it('does not send the database twice when the engine dies inside the restore step', async () => {
		const reference = await withTemplate();
		const steps = reference.run();
		await steps.done;
		const at = steps.executed.indexOf('template-restore') + 1;
		const { world, run, restores, deps } = await withTemplate();
		const memo: Memo = new Map();
		const first = makeRunner(memo, { killDuring: at });
		await expect(runSiteCreate(first.runner, deps, world.input)).rejects.toBeInstanceOf(Killed);
		expect(restores).toHaveLength(1);
		expect(await run(memo).done).toEqual({ status: 'succeeded' });
		expect(restores).toHaveLength(1);
	});

	it('refuses a bundle that is missing and rolls the site back', async () => {
		const { run, restores } = await withTemplate({ blob: null });
		const outcome = await run().done;
		expect(outcome).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_missing')
		});
		expect(restores).toEqual([]);
	});

	it.each([
		['another commit', { commit: 'd'.repeat(40) }],
		['another template', { entryId: 'govcms' }]
	])('refuses a bundle built for %s', async (_name, over) => {
		const { run, restores } = await withTemplate({
			blob: bundleOf(enc.encode('INSERT INTO a VALUES(1);'), over)
		});
		const outcome = await run().done;
		expect(outcome).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_changed')
		});
		expect(restores).toEqual([]);
	});

	it('refuses a database above the restore ceiling with the plain reason and sends nothing', async () => {
		const { run, restores } = await withTemplate({
			blob: bundleOf(new Uint8Array(16 * 1024 * 1024 + 1))
		});
		const outcome = await run().done;
		expect(outcome).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('A larger restore path is not available yet')
		});
		expect(restores).toEqual([]);
	});

	it('refuses a bundle that was cut', async () => {
		const whole = bundleOf(enc.encode('INSERT INTO a VALUES(1);'));
		const { run } = await withTemplate({ blob: whole.slice(0, whole.length - 4) });
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('bundle_malformed')
		});
	});

	it('needs the owner token the first run seals', async () => {
		const { run, restores } = await withTemplate({ firstRun: false });
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_needs_owner_token')
		});
		expect(restores).toEqual([]);
	});

	it('rolls back when the site reports the import failed, and says where', async () => {
		const { run } = await withTemplate({ states: ['pending', 'failed'] });
		expect(await run().done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('failed at users')
		});
	});

	it('rolls back when the site never applies the template', async () => {
		const { world, run, deps } = await withTemplate({ states: Array(100).fill('pending') });
		let ticks = 0;
		const slow = {
			...deps,
			sleep: async () => {
				ticks++;
				world.clock.advance(60_000);
			}
		};
		expect(await run(new Map(), slow).done).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_import_timeout')
		});
		expect(ticks).toBeGreaterThan(1);
	});

	it('refuses when the engine has no restore dependencies', async () => {
		const { world, run } = await withTemplate();
		expect(
			await run(new Map(), { ...world.deps, templateCodeDelivery: true }).done
		).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('template_unavailable')
		});
	});

	it('refuses a template before any resource while code delivery is off', async () => {
		const { run, deps } = await withTemplate();
		const { executed, done } = run(new Map(), { ...deps, templateCodeDelivery: undefined });
		expect(await done).toMatchObject({
			status: 'failed',
			reason: expect.stringContaining('template_code_delivery')
		});
		expect(executed).not.toContain('reserve-name');
		expect(executed.some((step) => step.startsWith('resource.'))).toBe(false);
	});

	it('leaves a create without a template with no template steps', async () => {
		const world = await start();
		const { executed, done } = attempt(world, new Map());
		await done;
		expect(executed).not.toContain('template-restore');
		expect(planSiteCreate(world.input).steps.map((step) => step.id)).not.toContain(
			'template-restore'
		);
	});
});

describe('a create in a customer account', () => {
	const DISPATCH_ONLY = ['reserve-name', 'authority'];

	it('skips the steps that belong to the managed plane and reports the plan without them', async () => {
		const world = await start({ plane: 'self-managed' });
		const ids = planSiteCreate(world.input).steps.map((step) => step.id);
		for (const step of DISPATCH_ONLY) expect(ids).not.toContain(step);
		const { executed, done } = attempt(world, new Map());
		expect(await done).toEqual({ status: 'succeeded' });
		for (const step of DISPATCH_ONLY) expect(executed).not.toContain(step);
		expect(executed).toContain('route');
		expect(executed).toContain('upload-script');
	});

	it('never touches the names registry or the site authority', async () => {
		const world = await start({ plane: 'self-managed' });
		await attempt(world, new Map()).done;
		expect(world.names.calls).toEqual([]);
		expect(world.authority.snapshot()).toEqual({ hosts: [], states: [] });
		expect(world.names.recordOf(world.input.subdomain)).toBeNull();
	});

	it('switches on workers.dev for the script when the address is the account subdomain', async () => {
		const world = await start({ plane: 'self-managed' });
		await attempt(world, new Map()).done;
		expect(world.account.enabled).toEqual([scriptName(world.siteId)]);
		expect(world.input.hostname).toBe(workersDevHost(scriptName(world.siteId), 'acme'));
		expect(world.cf.snapshot().routes).toEqual([]);
	});

	it('refuses, and creates nothing, when the account subdomain changed since the connection was read', async () => {
		const world = await start({ plane: 'self-managed' });
		world.account.state.subdomain = 'renamed';
		const outcome = await attempt(world, new Map()).done;
		expect(outcome).toMatchObject({
			status: 'rolled-back',
			reason: expect.stringContaining('subdomain_changed')
		});
		expect(world.account.enabled).toEqual([]);
		expect(world.cf.snapshot()).toMatchObject({ kv: [], r2: [], d1: [], scripts: [] });
	});

	it('refuses when the account has no subdomain at all', async () => {
		const world = await start({ plane: 'self-managed' });
		world.account.state.subdomain = null;
		expect(await attempt(world, new Map()).done).toMatchObject({
			reason: expect.stringContaining('subdomain_changed')
		});
	});

	it('routes a hostname on the customer zone and leaves workers.dev off', async () => {
		const world = await start({ plane: 'self-managed', zoneId: 'zone-1' });
		expect(await attempt(world, new Map()).done).toEqual({ status: 'succeeded' });
		expect(world.account.enabled).toEqual([]);
		expect(world.cf.snapshot().routes).toHaveLength(1);
		expect(world.cf.snapshot().routes[0]).toContain(world.input.hostname);
	});

	it('creates no bucket on the canonical config', async () => {
		const world = await start({ plane: 'self-managed', config: 'canonical' });
		expect(await attempt(world, new Map()).done).toEqual({ status: 'succeeded' });
		expect(world.cf.snapshot().r2).toEqual([]);
		expect(world.cf.snapshot().kv.length).toBeGreaterThan(0);
	});

	it('keeps the configNote in the preconditions the owner reads before the create', async () => {
		const world = await start({ plane: 'self-managed' });
		const note = 'Object storage is off in this account, so this site runs the simpler setup.';
		const plan = planSiteCreate({ ...world.input, configNote: note });
		expect(plan.preconditions).toContain(note);
		expect(plan.preconditions[0]).toContain(world.input.hostname);
	});

	it('leaves the managed plane with its name and authority steps', async () => {
		const world = await start();
		const ids = planSiteCreate(world.input).steps.map((step) => step.id);
		for (const step of DISPATCH_ONLY) expect(ids).toContain(step);
	});
});
