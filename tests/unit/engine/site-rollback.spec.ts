import { describe, expect, it } from 'vitest';
import { scriptName } from '../../../contracts/src/sites';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { RollbackDeps, RollbackFacts } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	planSiteRollback,
	runSiteRollback,
	type SiteRollbackInput
} from '../../../engine/src/workflows/site-rollback';
import {
	planSiteUpgrade,
	runSiteUpgrade,
	type SiteUpgradeInput
} from '../../../engine/src/workflows/site-upgrade';
import {
	beginCreate,
	Killed,
	makeBundle,
	makeRunner,
	makeWorld,
	releasesOf,
	type FakeBundle,
	type Memo,
	type World
} from './fakes';

const UPGRADE_ID = `op_${'u'.repeat(26)}`;
const ROLLBACK_ID = `op_${'b'.repeat(26)}`;

function combined(...bundles: FakeBundle[]) {
	const parts = bundles.map((bundle) => releasesOf(bundle));
	return {
		async manifest(releaseId: string) {
			const id = bundles.findIndex((bundle) => bundle.manifest.releaseId === releaseId);
			if (id < 0) throw new PermanentError('release_not_found', releaseId);
			return parts[id]!.manifest(releaseId);
		},
		async part(key: string) {
			for (const part of parts) {
				try {
					return await part.part(key);
				} catch (error) {
					if (!(error instanceof PermanentError)) throw error;
				}
			}
			throw new PermanentError('release_part_missing', key);
		}
	};
}

const OPEN: RollbackFacts = {
	dataSchemaVersion: 1,
	target: { schemaVersion: 1, acceptsSchema: 1 }
};

// a site that runs v1.0.5 after an update, with v1.0.4 still in the store
async function updatedSite(facts: RollbackFacts = OPEN) {
	const world = await makeWorld();
	await beginCreate(world);
	await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
	const next = await makeBundle('v1.0.5', 7);
	world.deps.releases = combined(world.bundle, next);
	const site: SiteUpgradeInput['site'] = {
		id: world.siteId,
		orgId: world.orgId,
		kind: 'drupal',
		plane: 'managed',
		config: 'managed',
		ring: 'R1',
		plan: 'free',
		accountId: world.accountId
	};
	const probe = { path: '/health', expectStatus: 200, auth: 'owner-token' as const };
	const up: SiteUpgradeInput = {
		operationId: UPGRADE_ID,
		site,
		hostname: world.input.hostname,
		releaseId: 'v1.0.5',
		currentRelease: 'v1.0.4',
		probe
	};
	await world.store.begin({
		operation: newOperation({
			id: UPGRADE_ID,
			orgId: world.orgId,
			idempotencyKey: 'upgrade-1',
			frozen: await freezePlan(
				(await import('../../../engine/src/workflows/site-upgrade')).planSiteUpgrade(up)
			),
			now: world.clock.now()
		}),
		accountId: world.accountId,
		siteId: world.siteId
	});
	expect(await runSiteUpgrade(makeRunner(new Map()).runner, world.deps, up)).toEqual({
		status: 'succeeded'
	});
	const input: SiteRollbackInput = {
		...up,
		operationId: ROLLBACK_ID,
		releaseId: 'v1.0.4',
		currentRelease: 'v1.0.5'
	};
	await world.store.begin({
		operation: newOperation({
			id: ROLLBACK_ID,
			orgId: world.orgId,
			idempotencyKey: 'rollback-1',
			frozen: await freezePlan(planSiteRollback(input)),
			now: world.clock.now()
		}),
		accountId: world.accountId,
		siteId: world.siteId
	});
	const asked: [string, string][] = [];
	const deps: RollbackDeps = {
		...world.deps,
		rollbackFacts: async (siteId, targetId) => {
			asked.push([siteId, targetId]);
			return facts;
		}
	};
	return { world, input, deps, asked };
}

const live = (world: World) => world.cf.scripts.get(scriptName(world.siteId))!;
const releaseRow = (world: World) =>
	(
		world.sqlite.prepare('SELECT release_id FROM sites WHERE id = ?').get(world.siteId) as {
			release_id: string | null;
		}
	).release_id;

describe('a rollback the data allows', () => {
	it('uploads the earlier bundle, verifies the site and puts the release id back', async () => {
		const { world, input, deps } = await updatedSite();
		const uploads = world.cf.uploads.length;
		const { runner, executed } = makeRunner(new Map());
		expect(await runSiteRollback(runner, deps, input)).toEqual({ status: 'succeeded' });
		expect(executed).toEqual([
			'start',
			'guard',
			'lease',
			'preflight',
			'assets.session',
			'assets.complete',
			'upload-script',
			'record',
			'verify',
			'finalize',
			'release-lease'
		]);
		expect(world.cf.uploads.length).toBe(uploads + 1);
		expect(live(world).tags).toContain('v:v1.0.4');
		expect(releaseRow(world)).toBe('v1.0.4');
		const operation = await world.store.get(ROLLBACK_ID);
		expect(operation).toMatchObject({ status: 'succeeded', verification: 'passed' });
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('keeps the data schema where it was, since the data is not rolled back', async () => {
		const { world, input, deps } = await updatedSite();
		const read = () =>
			(
				world.sqlite
					.prepare('SELECT data_schema_version AS v FROM sites WHERE id = ?')
					.get(world.siteId) as { v: number | null }
			).v;
		const before = read();
		await runSiteRollback(makeRunner(new Map()).runner, deps, input);
		expect(read()).toBe(before);
	});
});

describe('a rollback in a customer account', () => {
	it('uploads the earlier bundle with no name, authority or resource change', async () => {
		const world = await makeWorld({ plane: 'self-managed' });
		await beginCreate(world);
		await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
		const next = await makeBundle('v1.0.5', 7);
		world.deps.releases = combined(world.bundle, next);
		const site: SiteUpgradeInput['site'] = {
			id: world.siteId,
			orgId: world.orgId,
			kind: 'drupal',
			plane: 'self-managed',
			config: 'managed',
			ring: 'R1',
			plan: 'free',
			accountId: world.accountId
		};
		const up: SiteUpgradeInput = {
			operationId: UPGRADE_ID,
			site,
			hostname: world.input.hostname,
			releaseId: 'v1.0.5',
			currentRelease: 'v1.0.4',
			probe: { path: '/health', expectStatus: 200, auth: 'owner-token' }
		};
		await world.store.begin({
			operation: newOperation({
				id: UPGRADE_ID,
				orgId: world.orgId,
				idempotencyKey: 'upgrade-1',
				frozen: await freezePlan(planSiteUpgrade(up)),
				now: world.clock.now()
			}),
			accountId: world.accountId,
			siteId: world.siteId
		});
		expect(await runSiteUpgrade(makeRunner(new Map()).runner, world.deps, up)).toEqual({
			status: 'succeeded'
		});
		const input: SiteRollbackInput = {
			...up,
			operationId: ROLLBACK_ID,
			releaseId: 'v1.0.4',
			currentRelease: 'v1.0.5'
		};
		await world.store.begin({
			operation: newOperation({
				id: ROLLBACK_ID,
				orgId: world.orgId,
				idempotencyKey: 'rollback-1',
				frozen: await freezePlan(planSiteRollback(input)),
				now: world.clock.now()
			}),
			accountId: world.accountId,
			siteId: world.siteId
		});
		const names = [...world.names.calls];
		const hosts = world.authority.snapshot();
		const deps: RollbackDeps = { ...world.deps, rollbackFacts: async () => OPEN };
		expect(await runSiteRollback(makeRunner(new Map()).runner, deps, input)).toEqual({
			status: 'succeeded'
		});
		expect(live(world).tags).toContain('v:v1.0.4');
		expect(releaseRow(world)).toBe('v1.0.4');
		expect(world.names.calls).toEqual(names);
		expect(world.authority.snapshot()).toEqual(hosts);
	});
});

describe('a rollback the data refuses', () => {
	const refusals: [string, RollbackFacts][] = [
		[
			'a schema the earlier code cannot read',
			{ dataSchemaVersion: 3, target: { schemaVersion: 1, acceptsSchema: 1 } }
		],
		[
			'a site with no recorded data version',
			{ dataSchemaVersion: null, target: { schemaVersion: 1, acceptsSchema: 1 } }
		]
	];
	for (const [name, facts] of refusals) {
		it(`stops for ${name}, names both offers and uploads nothing`, async () => {
			const { world, input, deps } = await updatedSite(facts);
			const uploads = world.cf.uploads.length;
			const outcome = await runSiteRollback(makeRunner(new Map()).runner, deps, input);
			expect(outcome.status).toBe('failed');
			const reason = (outcome as { reason: string }).reason;
			expect(reason).toContain('rollback_refused');
			expect(reason).toContain('restore-data-with-code');
			expect(reason).toContain('fix-forward');
			expect(world.cf.uploads.length).toBe(uploads);
			expect(live(world).tags).toContain('v:v1.0.5');
			expect(releaseRow(world)).toBe('v1.0.5');
			expect(world.leases.stateOf(world.siteId).holder).toBeNull();
			expect((await world.store.get(ROLLBACK_ID))?.status).toBe('failed');
		});
	}

	it('stops for a release that is not registered', async () => {
		const { world, input, deps } = await updatedSite({ dataSchemaVersion: 1, target: null });
		const outcome = await runSiteRollback(makeRunner(new Map()).runner, deps, input);
		expect((outcome as { reason: string }).reason).toContain('release_unknown');
		expect(releaseRow(world)).toBe('v1.0.5');
	});
});

describe('what the preflight refuses', () => {
	it('refuses a site that already runs the target', async () => {
		const { world, input, deps } = await updatedSite();
		const outcome = await runSiteRollback(makeRunner(new Map()).runner, deps, {
			...input,
			releaseId: 'v1.0.5'
		});
		expect((outcome as { reason: string }).reason).toContain('up_to_date');
		expect(releaseRow(world)).toBe('v1.0.5');
	});

	it('refuses a site that is neither managed nor self-managed', async () => {
		const { input, deps } = await updatedSite();
		const outcome = await runSiteRollback(makeRunner(new Map()).runner, deps, {
			...input,
			site: { ...input.site, plane: 'self-hosted' }
		});
		expect((outcome as { reason: string }).reason).toContain('unsupported_plane');
	});
});

describe('a failed check after the upload', () => {
	it('leaves the site on the earlier code, records it and says so', async () => {
		const { world, input, deps } = await updatedSite();
		const real = deps.site.probe;
		deps.site = {
			...deps.site,
			probe: async (host, path, expectStatus, auth) =>
				live(world).tags.includes('v:v1.0.4')
					? { status: 500 }
					: real(host, path, expectStatus, auth)
		};
		const outcome = await runSiteRollback(makeRunner(new Map()).runner, deps, input);
		expect(outcome.status).toBe('failed');
		expect((outcome as { reason: string }).reason).toContain(
			'runs v1.0.4 but did not pass its check'
		);
		expect(live(world).tags).toContain('v:v1.0.4');
		expect(releaseRow(world)).toBe('v1.0.4');
		expect((await world.store.get(ROLLBACK_ID))?.status).toBe('failed');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('leaves the site as it was when the assets fail before the upload', async () => {
		const { world, input, deps } = await updatedSite();
		const uploads = world.cf.uploads.length;
		const { runner } = makeRunner(new Map(), {
			failAt: { step: 'assets.session', when: 'before' }
		});
		const outcome = await runSiteRollback(runner, deps, input);
		expect(outcome.status).toBe('failed');
		expect(world.cf.uploads.length).toBe(uploads);
		expect(releaseRow(world)).toBe('v1.0.5');
	});
});

describe('kill and resume', () => {
	it('never uploads the script twice, whichever step it dies in', async () => {
		const ref = await updatedSite();
		const refRun = makeRunner(new Map());
		const base = ref.world.cf.uploads.length;
		await runSiteRollback(refRun.runner, ref.deps, ref.input);
		const steps = refRun.executed.length;
		for (let j = 1; j <= steps; j++) {
			const { world, input, deps } = await updatedSite();
			const memo: Memo = new Map();
			await expect(
				runSiteRollback(makeRunner(memo, { killDuring: j }).runner, deps, input)
			).rejects.toBeInstanceOf(Killed);
			expect(
				await runSiteRollback(makeRunner(memo).runner, deps, input),
				`during ${j}`
			).toEqual({
				status: 'succeeded'
			});
			expect(world.cf.uploads.length).toBe(base + 1);
			expect(releaseRow(world)).toBe('v1.0.4');
		}
	});
});
