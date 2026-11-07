import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import type { AuthorityState } from '../../../contracts/src/site-auth';
import { readAuthority } from '../../../dispatch/src/authority';
import { DEFAULT_HOLD_MS, type NameRecord } from '../../../dispatch/src/registry';
import { resolveRoute } from '../../../dispatch/src/route';
import { authorityOf } from '../../../engine/src/adapters/authority';
import { hostsOf } from '../../../engine/src/adapters/hosts';
import { leasesOf } from '../../../engine/src/adapters/leases';
import { namesOf } from '../../../engine/src/adapters/names';
import { releasesOf as adapterReleases } from '../../../engine/src/adapters/releases';
import { siteOf } from '../../../engine/src/adapters/site';
import { bundleKeys } from '../../../engine/src/bundle';
import { EMPTY_LEASE, type LeaseState } from '../../../engine/src/lease';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type {
	Authority,
	HostRoute,
	Leases,
	Names,
	Releases,
	Site
} from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	planSiteDelete,
	planSitePurge,
	runSiteDelete,
	runSitePurge
} from '../../../engine/src/workflows/site-delete';
import { shardKey } from '../../../src/shared/names';
import { authorityState } from '../dispatch/fakes';
import {
	CDN_BASE,
	cdnOf,
	hostsKv,
	leaseObjects,
	namesObjects,
	newAnswer,
	siteAuthObjects,
	siteFetch
} from './doubles';
import {
	FAKE_ADMIN_PASSWORD,
	FAKE_OWNER_TOKEN,
	beginCreate,
	fakeAuthority,
	fakeLeases,
	fakeNames,
	releasesOf as fakeReleases,
	fakeSite,
	makeBundle,
	makeRunner,
	makeWorld,
	snapshotWorld,
	type FakeBundle,
	type RunnerScript,
	type World
} from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const START = 1_790_000_000_000;
const SITE = `site_${'s'.repeat(26)}`;
const OTHER = `site_${'t'.repeat(26)}`;
const NAME = 'quiet-otter';
const now = () => Date.now();

async function failureOf(promise: Promise<unknown>): Promise<PermanentError> {
	try {
		await promise;
	} catch (error) {
		return error as PermanentError;
	}
	throw new Error('the call did not fail');
}

interface Arm {
	authority: Authority;
	names: Names;
	leases: Leases;
	site: Site;
	releases: Releases;
	setStatus(status: number): void;
	routeOf(host: string): HostRoute | null;
}

async function fakeArm(bundle: FakeBundle): Promise<Arm> {
	const authority = await fakeAuthority(now);
	const site = fakeSite();
	return {
		authority: authority.authority,
		names: fakeNames(now).names,
		leases: fakeLeases(now).leases,
		site: site.site,
		releases: fakeReleases(bundle),
		setStatus(status) {
			site.answers.probe = status;
			site.answers.firstRun = status;
		},
		routeOf: (host) => authority.snapshot().hosts.find(([key]) => key === host)?.[1] ?? null
	};
}

async function adapterPorts(bundle: FakeBundle, clock: () => number) {
	const control = await generateSigningKey();
	const siteAuth = siteAuthObjects(control);
	const names = namesObjects();
	const leases = leaseObjects();
	const hosts = hostsKv();
	const answer = newAnswer();
	return {
		siteAuth,
		names,
		leases,
		hosts,
		answer,
		authority: authorityOf({
			siteAuth: siteAuth.stub,
			hosts: hostsOf(hosts.kv),
			controlKey: control.privateKey,
			now: clock
		}),
		namesPort: namesOf(names.stub),
		leasesPort: leasesOf(leases.stub),
		site: siteOf(siteFetch(answer), 1_000),
		releases: adapterReleases(
			CDN_BASE,
			cdnOf(
				new Map<string, Uint8Array | string | number>([
					[
						bundleKeys.manifest(bundle.manifest.releaseId),
						JSON.stringify(bundle.manifest)
					],
					...bundle.parts
				])
			)
		),
		routeOf(host: string): HostRoute | null {
			const raw = hosts.map.get(host) ?? null;
			const parsed = resolveRoute(host, raw);
			return parsed.ok ? parsed.value : null;
		}
	};
}

async function adapterArm(bundle: FakeBundle): Promise<Arm> {
	const ports = await adapterPorts(bundle, now);
	return {
		authority: ports.authority,
		names: ports.namesPort,
		leases: ports.leasesPort,
		site: ports.site,
		releases: ports.releases,
		setStatus: (status) => void (ports.answer.status = status),
		routeOf: ports.routeOf
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

const arms: [string, (bundle: FakeBundle) => Promise<Arm>][] = [
	['the fake', fakeArm],
	['the adapter over Durable Object doubles', adapterArm]
];

describe.each(arms)('the port contract on %s', (_label, build) => {
	const arm = async () => build(await makeBundle());

	describe('authority', () => {
		const state = (patch: Partial<AuthorityState> = {}) =>
			authorityState({ siteId: SITE as never, ...patch });

		it('reads null, writes, reads back, and answers a repeat as not applied', async () => {
			const { authority } = await arm();
			expect(await authority.read(SITE)).toBeNull();
			const first = await state();
			expect(await authority.apply(first)).toEqual({ applied: true, generation: 1 });
			expect(await authority.read(SITE)).toEqual(first);
			expect(await authority.apply(first)).toEqual({ applied: false, generation: 1 });
		});

		it('takes the next generation and refuses a lower or reused one by name', async () => {
			const { authority } = await arm();
			const first = await state();
			await authority.apply(first);
			const revoked = { ...first, state: 'revoked' as const, generation: 2 };
			expect(await authority.apply(revoked)).toEqual({ applied: true, generation: 2 });
			for (const stale of [first, { ...revoked, state: 'active' as const }]) {
				const refused = await authority.apply(stale).catch((error) => error);
				expect(refused).toBeInstanceOf(PermanentError);
				expect(refused.code).toBe('authority_stale_generation');
			}
			expect((await authority.read(SITE))?.state).toBe('revoked');
		});

		it('refuses to bring a revoked site back at the same epoch', async () => {
			const { authority } = await arm();
			const first = await state();
			await authority.apply(first);
			await authority.apply({ ...first, state: 'revoked', generation: 2 });
			const refused = await authority
				.apply({ ...first, state: 'active', generation: 3 })
				.catch((error) => error);
			expect(refused).toBeInstanceOf(PermanentError);
			expect(refused.code).toBe('authority_revoked_epoch');
		});

		it('keeps sites apart', async () => {
			const { authority } = await arm();
			await authority.apply(await state());
			expect(await authority.read(OTHER)).toBeNull();
		});

		it('routes a host and removes the route', async () => {
			const { authority, routeOf } = await arm();
			const route = { siteId: SITE, script: `s-${SITE}`, epoch: 1 };
			await authority.putHost('quiet-otter.drupflare.app', route);
			expect(routeOf('quiet-otter.drupflare.app')).toEqual(route);
			await authority.putHost('quiet-otter.drupflare.app', { ...route, epoch: 2 });
			expect(routeOf('quiet-otter.drupflare.app')).toEqual({ ...route, epoch: 2 });
			expect(await authority.deleteHostIfOwned('quiet-otter.drupflare.app', SITE)).toBe(
				'deleted'
			);
			expect(routeOf('quiet-otter.drupflare.app')).toBeNull();
			expect(await authority.deleteHostIfOwned('quiet-otter.drupflare.app', SITE)).toBe(
				'absent'
			);
		});

		it('refuses to remove a route that names another site', async () => {
			const { authority, routeOf } = await arm();
			const route = { siteId: OTHER, script: `s-${OTHER}`, epoch: 1 };
			await authority.putHost('quiet-otter.drupflare.app', route);
			expect(await authority.deleteHostIfOwned('quiet-otter.drupflare.app', SITE)).toBe(
				'foreign'
			);
			expect(routeOf('quiet-otter.drupflare.app')).toEqual(route);
		});
	});

	describe('names', () => {
		it('reserves, answers the same site again, and refuses another site', async () => {
			const { names } = await arm();
			expect(await names.reserve(NAME, SITE)).toBe('reserved');
			expect(await names.reserve(NAME, SITE)).toBe('reserved');
			expect(await names.reserve(NAME, OTHER)).toBe('taken');
			expect(await names.confirm(NAME, SITE)).toBe(true);
			expect(await names.confirm(NAME, OTHER)).toBe(false);
		});

		it('refuses a reserved word and a name that is not a label', async () => {
			const { names } = await arm();
			expect(await names.reserve('admin', SITE)).toBe('reserved-word');
			expect(await names.reserve('quiet-otter-staging', SITE)).toBe('reserved-word');
			expect(await names.reserve('Quiet Otter', SITE)).toBe('invalid');
		});

		it('frees the name at once for a hold of zero', async () => {
			const { names } = await arm();
			await names.reserve(NAME, SITE);
			expect(await names.release(NAME, SITE, 0)).toBe('released');
			expect(await names.reserve(NAME, OTHER)).toBe('reserved');
		});

		it('holds the name for the default hold when none is given', async () => {
			const { names } = await arm();
			await names.reserve(NAME, SITE);
			expect(await names.release(NAME, SITE)).toBe('released');
			expect(await names.reserve(NAME, OTHER)).toBe('held');
			vi.setSystemTime(START + DEFAULT_HOLD_MS - 1);
			expect(await names.reserve(NAME, OTHER)).toBe('held');
			vi.setSystemTime(START + DEFAULT_HOLD_MS);
			expect(await names.reserve(NAME, OTHER)).toBe('reserved');
		});

		it('answers not-owner and unknown for a release it cannot honour', async () => {
			const { names } = await arm();
			await names.reserve(NAME, SITE);
			expect(await names.release(NAME, OTHER, 0)).toBe('not-owner');
			expect(await names.release('calm-river-stone', SITE, 0)).toBe('unknown');
		});
	});

	describe('leases', () => {
		const request = (holder: string) => ({ holder, purpose: 'site.create', ttlMs: 60_000 });

		it('grants one writer, refuses a second, and raises the epoch for the next', async () => {
			const { leases } = await arm();
			const first = await leases.acquire(SITE, request('op-a'));
			expect(first).toMatchObject({ ok: true, epoch: 1 });
			expect(await leases.acquire(SITE, request('op-b'))).toMatchObject({
				ok: false,
				code: 'held',
				heldBy: 'op-a'
			});
			expect(await leases.check(SITE, { holder: 'op-a', epoch: 1 })).toMatchObject({
				ok: true
			});
			expect(
				await leases.heartbeat(SITE, { holder: 'op-a', epoch: 1, ttlMs: 60_000 })
			).toMatchObject({
				ok: true,
				epoch: 1
			});
			expect(await leases.release(SITE, { holder: 'op-a', epoch: 1 })).toEqual({ ok: true });
			expect(await leases.check(SITE, { holder: 'op-a', epoch: 1 })).toMatchObject({
				ok: false
			});
			expect(await leases.acquire(SITE, request('op-b'))).toMatchObject({
				ok: true,
				epoch: 2
			});
		});

		it('refuses a holder that is not the holder and a lease that ran out', async () => {
			const { leases } = await arm();
			await leases.acquire(SITE, request('op-a'));
			expect(await leases.check(SITE, { holder: 'op-b', epoch: 1 })).toMatchObject({
				ok: false,
				code: 'not_holder'
			});
			vi.setSystemTime(START + 60_000);
			expect(await leases.check(SITE, { holder: 'op-a', epoch: 1 })).toMatchObject({
				ok: false,
				code: 'expired'
			});
		});
	});

	describe('site', () => {
		it('reports the status of a probe and of the first-run call', async () => {
			const { site, setStatus } = await arm();
			for (const status of [200, 204, 503]) {
				setStatus(status);
				expect(await site.probe('quiet-otter.drupflare.app', '/')).toEqual({ status });
				expect(
					await site.firstRun('quiet-otter.drupflare.app', {
						method: 'POST',
						path: '/first-run'
					})
				).toEqual({ status });
			}
		});
	});

	describe('releases', () => {
		it('returns the manifest and a part, and names what is missing', async () => {
			const bundle = await makeBundle();
			const { releases } = await build(bundle);
			expect(await releases.manifest(bundle.manifest.releaseId)).toEqual(bundle.manifest);
			const module = bundle.manifest.modules[0]!;
			const key = bundleKeys.module(bundle.manifest.releaseId, module.name);
			expect(await releases.part(key)).toEqual(bundle.parts.get(key));
			const missing = await failureOf(releases.manifest('v9'));
			expect(missing).toBeInstanceOf(PermanentError);
			expect(missing.code).toBe('release_not_found');
			const part = await failureOf(releases.part('releases/v9/modules/x'));
			expect(part).toBeInstanceOf(PermanentError);
			expect(part.code).toBe('release_part_missing');
		});
	});
});

// #region the same operations over the fakes and over the adapters

async function adapterWorld(): Promise<{
	world: World;
	ports: Awaited<ReturnType<typeof adapterPorts>>;
}> {
	const world = await makeWorld();
	const ports = await adapterPorts(world.bundle, world.clock.now);
	ports.answer.body = JSON.stringify({
		ownerToken: FAKE_OWNER_TOKEN,
		adminPass: FAKE_ADMIN_PASSWORD
	});
	world.deps = {
		...world.deps,
		authority: ports.authority,
		names: ports.namesPort,
		leases: ports.leasesPort,
		site: ports.site,
		releases: ports.releases
	};
	world.authority = {
		authority: ports.authority,
		snapshot: () => ({
			hosts: [...ports.hosts.map]
				.map(([host, raw]) => {
					const { v: _v, ...route } = JSON.parse(raw);
					return [host, route];
				})
				.sort(),
			states: [...ports.siteAuth.stores]
				.map(([siteId, kv]) => [siteId, readAuthority(kv) ?? null])
				.sort()
		}),
		stateOf: (siteId: string) => readAuthority(ports.siteAuth.kvOf(siteId))
	} as unknown as World['authority'];
	world.leases = {
		leases: ports.leasesPort,
		stateOf: (siteId: string) =>
			ports.leases.kvOf(siteId).get<LeaseState>('lease') ?? EMPTY_LEASE
	};
	world.names = {
		names: ports.namesPort,
		calls: [],
		recordOf: (name: string) =>
			ports.names.kvOf(shardKey(name)).get<NameRecord>(`name:${name}`) ?? null,
		isFree: (name: string) => {
			const record = ports.names.kvOf(shardKey(name)).get<NameRecord>(`name:${name}`);
			return (
				record === undefined ||
				(record.state === 'held' && world.clock.now() >= record.until)
			);
		}
	};
	vi.setSystemTime(world.clock.now());
	return { world, ports };
}

async function fakeWorld(): Promise<World> {
	return makeWorld();
}

const advance = (world: World, ms: number) => {
	world.clock.advance(ms);
	vi.setSystemTime(world.clock.now());
};

async function create(world: World, script: RunnerScript = {}) {
	await beginCreate(world);
	return runSiteCreate(makeRunner(new Map(), script).runner, world.deps, world.input);
}

async function begin(world: World, id: string, plan: ReturnType<typeof planSiteDelete>) {
	const operation = newOperation({
		id,
		orgId: world.orgId,
		idempotencyKey: `key-${id}`,
		frozen: await freezePlan(plan),
		verification: 'not-required',
		now: world.clock.now()
	});
	await world.store.begin({ operation, accountId: world.accountId, siteId: world.siteId });
}

const DELETE_OP = `op_${'d'.repeat(26)}`;
const PURGE_OP = `op_${'u'.repeat(26)}`;
const HOLD_MS = 7 * 86_400_000;

async function remove(world: World) {
	await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
	return runSiteDelete(makeRunner(new Map()).runner, world.deps, {
		operationId: DELETE_OP,
		siteId: world.siteId,
		accountId: world.accountId,
		hostnames: [world.input.hostname]
	});
}

async function purge(world: World, holdUntil: number) {
	await begin(world, PURGE_OP, planSitePurge({ siteId: world.siteId }));
	return runSitePurge(makeRunner(new Map()).runner, world.deps, {
		operationId: PURGE_OP,
		siteId: world.siteId,
		accountId: world.accountId,
		subdomain: world.input.subdomain,
		confirm: world.siteId,
		holdUntil
	});
}

function nameState(world: World, now: number): 'free' | 'taken' | 'held' {
	const record = world.names.recordOf(world.input.subdomain);
	if (record === null) return 'free';
	if (record.state === 'taken') return 'taken';
	return record.state === 'held' && now >= record.until ? 'free' : 'held';
}

describe('a workflow over the adapters ends where it ends over the fakes', () => {
	it('a create that succeeds leaves the same state', async () => {
		const fake = await fakeWorld();
		expect(await create(fake)).toEqual({ status: 'succeeded' });
		const { world } = await adapterWorld();
		expect(await create(world)).toEqual({ status: 'succeeded' });
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(fake));
		expect(nameState(world, world.clock.now())).toBe('taken');
		expect(world.authority.stateOf(world.siteId)).toMatchObject({
			state: 'active',
			generation: 1
		});
	});

	it('a create that fails frees its name at once, as the fake does', async () => {
		const script: RunnerScript = { failAt: { step: 'first-run', when: 'after' } };
		const fake = await fakeWorld();
		const fakeOutcome = await create(fake, script);
		const { world } = await adapterWorld();
		const outcome = await create(world, script);
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status).toBe(fakeOutcome.status);
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(fake));
		expect(nameState(world, world.clock.now())).toBe('free');
		expect(world.names.recordOf(world.input.subdomain)).toMatchObject({ state: 'held' });
		expect(world.authority.stateOf(world.siteId)).toMatchObject({ state: 'revoked' });
	});

	it('a delete and a purge leave the same state and the name held for the default hold', async () => {
		const fake = await fakeWorld();
		await create(fake);
		expect(await remove(fake)).toEqual({ status: 'succeeded' });
		advance(fake, HOLD_MS);
		expect(await purge(fake, fake.clock.now())).toEqual({ status: 'succeeded' });
		const { world } = await adapterWorld();
		await create(world);
		expect(await remove(world)).toEqual({ status: 'succeeded' });
		expect(nameState(world, world.clock.now())).toBe('taken');
		advance(world, HOLD_MS);
		expect(await purge(world, world.clock.now())).toEqual({ status: 'succeeded' });
		expect(await snapshotWorld(world)).toEqual(await snapshotWorld(fake));
		const purgedAt = world.clock.now();
		expect(nameState(world, purgedAt)).toBe('held');
		expect(nameState(world, purgedAt + DEFAULT_HOLD_MS - 1)).toBe('held');
		expect(nameState(world, purgedAt + DEFAULT_HOLD_MS)).toBe('free');
		expect(world.authority.stateOf(world.siteId)).toMatchObject({ state: 'revoked' });
	});

	it('a revoke after the object restarted takes the next generation, never a reused one', async () => {
		const { world, ports } = await adapterWorld();
		await create(world);
		expect(ports.siteAuth.kvOf(world.siteId).get<AuthorityState>('authority')?.generation).toBe(
			1
		);
		// every stub call already runs on a new instance; this read is the first after the create
		expect(await ports.authority.read(world.siteId)).toMatchObject({ generation: 1 });
		expect(await remove(world)).toEqual({ status: 'succeeded' });
		expect(await ports.authority.read(world.siteId)).toMatchObject({
			state: 'revoked',
			generation: 2
		});
	});
});

// #endregion
