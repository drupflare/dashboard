import { describe, expect, it } from 'vitest';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import {
	planSiteCleanup,
	runSiteCleanup,
	type SiteCleanupInput
} from '../../../engine/src/workflows/site-cleanup';
import {
	planSiteCreate,
	runSiteCreate,
	type SiteCreateInput
} from '../../../engine/src/workflows/site-create';
import {
	beginCreate,
	custodyRows,
	Killed,
	makeRunner,
	makeWorld,
	snapshotWorld,
	type Memo,
	type RunnerScript,
	type World
} from './fakes';

const CLEANUP_OP = `op_${'c'.repeat(26)}`;
const SECOND_OP = `op_${'d'.repeat(26)}`;
const RETRY_OP = `op_${'r'.repeat(26)}`;
const RETRY_SITE = `site_${'t'.repeat(26)}`;

// the row the dashboard writes when it accepts a create; it stays hidden until the create ends
function hiddenRow(world: World) {
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, kind, category, plane, config, state,
			primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, 'Quiet Otter', 'drupal', 'cms', 'managed', 'managed', 'active', ?, NULL, 1, 1)`
		)
		.run(world.siteId, world.orgId, world.input.hostname);
}

async function start() {
	const world = await makeWorld();
	hiddenRow(world);
	await beginCreate(world);
	return world;
}

// the create fails at its probe and its rollback cannot delete a KV namespace, so the namespaces
// stay in the account and the row stays active
async function leaking() {
	const world = await start();
	const real = world.deps.cloudflare;
	world.deps.cloudflare = {
		...real,
		deleteResource: async (kind, id) => {
			if (kind === 'kv') throw new Error('api down');
			return real.deleteResource(kind, id);
		}
	};
	const run = makeRunner(new Map(), { failAt: { step: 'verify', when: 'before' } });
	const outcome = await runSiteCreate(run.runner, world.deps, world.input);
	world.deps.cloudflare = real;
	return { world, outcome };
}

const targetOf = (world: World): Omit<SiteCleanupInput, 'operationId'> => ({
	siteId: world.siteId,
	accountId: world.accountId,
	plane: 'managed',
	hostname: world.input.hostname,
	subdomain: world.input.subdomain
});

async function beginCleanup(world: World, id: string, key = `cleanup-${id}`) {
	const frozen = await freezePlan(planSiteCleanup({ siteId: world.siteId }));
	const operation = newOperation({
		id,
		orgId: world.orgId,
		idempotencyKey: key,
		frozen,
		verification: 'not-required',
		now: world.clock.now()
	});
	return world.store.begin({ operation, accountId: world.accountId, siteId: world.siteId });
}

function cleanup(world: World, id: string, memo: Memo, script: RunnerScript = {}) {
	const { runner, executed } = makeRunner(memo, script);
	return {
		executed,
		done: runSiteCleanup(runner, world.deps, { operationId: id, ...targetOf(world) })
	};
}

async function view(world: World) {
	return {
		...(await snapshotWorld(world, [CLEANUP_OP])),
		hosts: world.authority.snapshot().hosts
	};
}

describe('a failed create that left things behind', () => {
	it('ends with the site hidden but active when its rollback could not finish', async () => {
		const { world, outcome } = await leaking();
		expect(outcome.status).toBe('failed');
		expect(await world.store.siteState(world.siteId)).toBe('active');
		expect(await world.store.siteLive(world.siteId)).toBe(false);
		expect(world.cf.snapshot().kv).toHaveLength(2);
	});
});

describe('the cleanup of a site that never became active', () => {
	it('removes what the failed create left and frees the name', async () => {
		const { world } = await leaking();
		await beginCleanup(world, CLEANUP_OP);
		const run = cleanup(world, CLEANUP_OP, new Map());
		expect(await run.done).toEqual({ status: 'succeeded' });
		expect(run.executed).toEqual([
			'guard',
			'start',
			'lease',
			'stop',
			'script',
			'resources',
			'name',
			'forget',
			'finalize',
			'release-lease'
		]);

		const account = world.cf.snapshot();
		expect([account.kv, account.r2, account.d1, account.scripts]).toEqual([[], [], [], []]);
		expect(await world.ledger.live(world.siteId)).toEqual([]);
		expect(world.authority.snapshot().hosts).toEqual([]);
		expect(custodyRows(world)).toEqual({ ownerToken: false, pending: [] });
		expect(world.names.isFree(world.input.subdomain)).toBe(true);
		expect(await world.store.siteState(world.siteId)).toBe('deleted');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		const operation = await world.store.get(CLEANUP_OP);
		expect(operation?.status).toBe('succeeded');
		expect(operation?.steps.map((step) => step.state)).toEqual(Array(6).fill('succeeded'));
		for (const [, state] of world.authority.snapshot().states as [
			string,
			{ state: string } | null
		][]) {
			expect(state?.state ?? 'revoked').toBe('revoked');
		}
	});

	it('succeeds again on a clean site and changes nothing', async () => {
		const { world } = await leaking();
		await beginCleanup(world, CLEANUP_OP);
		await cleanup(world, CLEANUP_OP, new Map()).done;
		const before = await view(world);
		await beginCleanup(world, SECOND_OP);
		expect(await cleanup(world, SECOND_OP, new Map()).done).toEqual({ status: 'succeeded' });
		const after = await view(world);
		expect(after.account).toEqual(before.account);
		expect(after.resources).toEqual(before.resources);
		expect(after.authority).toEqual(before.authority);
		expect(after.siteState).toBe('deleted');
		expect(after.name).toEqual(before.name);
	});

	it('refuses a site that became active and touches nothing', async () => {
		const world = await start();
		const created = await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
		expect(created.status).toBe('succeeded');
		const before = await view(world);
		await beginCleanup(world, CLEANUP_OP);
		const outcome = await cleanup(world, CLEANUP_OP, new Map()).done;
		expect(outcome).toEqual({ status: 'cancelled', reason: 'site_active' });
		const after = await view(world);
		expect(after.account).toEqual(before.account);
		expect(after.resources).toEqual(before.resources);
		expect(after.authority).toEqual(before.authority);
		expect(await world.store.siteState(world.siteId)).toBe('active');
		const operation = await world.store.get(CLEANUP_OP);
		expect(operation?.status).toBe('cancelled');
		expect(operation?.finalObservation?.summary).toContain('site_active');
	});

	it('does not take a deleted row for a live site when a create activated before it rolled back', async () => {
		const world = await start();
		await runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
		await world.store.setSiteState(world.siteId, 'deleted', 1);
		expect(await world.store.siteLive(world.siteId)).toBe(false);
		await beginCleanup(world, CLEANUP_OP);
		const outcome = await cleanup(world, CLEANUP_OP, new Map()).done;
		expect(outcome.status).toBe('succeeded');
	});

	it('leaves another holder alone while the site is busy', async () => {
		const { world } = await leaking();
		await world.deps.leases.acquire(world.siteId, {
			holder: 'op_repair00000000',
			purpose: 'repair.run',
			ttlMs: 60_000
		});
		await beginCleanup(world, CLEANUP_OP);
		const outcome = await cleanup(world, CLEANUP_OP, new Map()).done;
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('site_busy');
		expect(world.cf.snapshot().kv).toHaveLength(2);
		expect(world.leases.stateOf(world.siteId).holder?.id).toBe('op_repair00000000');
	});

	it('fails with the step named when a delete is refused, keeps the row, and a repeat finishes it', async () => {
		const { world } = await leaking();
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			deleteResource: async (kind, id) => {
				if (kind === 'kv') throw new Error('api down');
				return real.deleteResource(kind, id);
			}
		};
		await beginCleanup(world, CLEANUP_OP);
		const outcome = await cleanup(world, CLEANUP_OP, new Map()).done;
		expect(outcome.status).toBe('failed');
		const operation = await world.store.get(CLEANUP_OP);
		expect(operation?.status).toBe('failed');
		expect(operation?.steps.find((step) => step.id === 'resources')?.state).toBe('failed');
		expect(await world.store.siteState(world.siteId)).toBe('active');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();

		world.deps.cloudflare = real;
		await beginCleanup(world, SECOND_OP);
		expect(await cleanup(world, SECOND_OP, new Map()).done).toEqual({ status: 'succeeded' });
		expect(world.cf.snapshot().kv).toEqual([]);
		expect(await world.store.siteState(world.siteId)).toBe('deleted');
	});

	it('ends in the uninterrupted state when killed at any point and resumed', async () => {
		const reference = await leaking();
		await beginCleanup(reference.world, CLEANUP_OP);
		const run = cleanup(reference.world, CLEANUP_OP, new Map());
		await run.done;
		const expected = await view(reference.world);
		for (let k = 0; k < run.executed.length; k++) {
			for (const script of [{ killAfter: k }, { killDuring: k + 1 }]) {
				const { world } = await leaking();
				await beginCleanup(world, CLEANUP_OP);
				const memo: Memo = new Map();
				await expect(cleanup(world, CLEANUP_OP, memo, script).done).rejects.toBeInstanceOf(
					Killed
				);
				expect(await cleanup(world, CLEANUP_OP, memo).done, JSON.stringify(script)).toEqual(
					{
						status: 'succeeded'
					}
				);
				expect(await view(world), JSON.stringify(script)).toEqual(expected);
			}
		}
	});
});

describe('a create that retries an earlier one', () => {
	function retryInput(world: World): SiteCreateInput {
		return {
			...world.input,
			operationId: RETRY_OP,
			site: { ...world.input.site, id: RETRY_SITE },
			prior: {
				siteId: world.siteId,
				accountId: world.accountId,
				plane: 'managed',
				hostname: world.input.hostname,
				subdomain: world.input.subdomain
			}
		};
	}

	async function beginRetry(world: World, input: SiteCreateInput) {
		const frozen = await freezePlan(planSiteCreate(input));
		const operation = newOperation({
			id: RETRY_OP,
			orgId: world.orgId,
			idempotencyKey: 'retry-1',
			frozen,
			now: world.clock.now()
		});
		return world.store.begin({ operation, accountId: world.accountId, siteId: RETRY_SITE });
	}

	function attempt(world: World, input: SiteCreateInput, memo: Memo, script: RunnerScript = {}) {
		const { runner, executed } = makeRunner(memo, script);
		return { executed, done: runSiteCreate(runner, world.deps, input) };
	}

	it('plans the cleanup right after the lease, and only when there is an earlier attempt', async () => {
		const world = await makeWorld();
		const plain = planSiteCreate(world.input).steps.map((step) => step.id);
		const retry = planSiteCreate(retryInput(world)).steps.map((step) => step.id);
		expect(plain).not.toContain('cleanup');
		expect(retry.slice(0, 3)).toEqual(['lease', 'cleanup', 'reserve-name']);
		expect(retry.filter((id) => id !== 'cleanup')).toEqual(plain);
	});

	it('cleans up the earlier site first and then creates under the same name', async () => {
		const { world } = await leaking();
		const input = retryInput(world);
		await beginRetry(world, input);
		const run = attempt(world, input, new Map());
		expect(await run.done).toEqual({ status: 'succeeded' });
		expect(run.executed.slice(0, 4)).toEqual(['start', 'lease', 'cleanup', 'reserve-name']);

		expect(await world.ledger.live(world.siteId)).toEqual([]);
		expect(await world.store.siteState(world.siteId)).toBe('deleted');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		expect(world.names.recordOf(input.subdomain)).toEqual({
			state: 'taken',
			siteId: RETRY_SITE
		});
		const live = await world.ledger.live(RETRY_SITE);
		expect(live.length).toBeGreaterThan(0);
		expect(world.cf.snapshot().kv).toHaveLength(2);
		const operation = await world.store.get(RETRY_OP);
		expect(operation?.status).toBe('succeeded');
		expect(operation?.steps.find((step) => step.id === 'cleanup')?.state).toBe('succeeded');
	});

	it('fails the retry at the cleanup and leaves the earlier site as it was while it is busy', async () => {
		const { world } = await leaking();
		await world.deps.leases.acquire(world.siteId, {
			holder: 'op_repair00000000',
			purpose: 'repair.run',
			ttlMs: 60_000
		});
		const input = retryInput(world);
		await beginRetry(world, input);
		const outcome = await attempt(world, input, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('site_busy');
		expect(world.cf.snapshot().kv).toHaveLength(2);
		expect(await world.store.siteState(world.siteId)).toBe('active');
		const operation = await world.store.get(RETRY_OP);
		expect(operation?.steps.find((step) => step.id === 'cleanup')?.state).toBe('failed');
	});

	it('ends in the uninterrupted state when killed at any point and resumed', async () => {
		const reference = await leaking();
		const input = retryInput(reference.world);
		await beginRetry(reference.world, input);
		const run = attempt(reference.world, input, new Map());
		await run.done;
		const expected = {
			account: reference.world.cf.snapshot(),
			name: reference.world.names.recordOf(input.subdomain),
			operation: (await reference.world.store.get(RETRY_OP))?.status,
			earlier: await reference.world.store.siteState(reference.world.siteId)
		};
		for (let k = 1; k < run.executed.length; k++) {
			for (const script of [{ killAfter: k }, { killDuring: k }]) {
				const { world } = await leaking();
				await beginRetry(world, input);
				const memo: Memo = new Map();
				await expect(attempt(world, input, memo, script).done).rejects.toBeInstanceOf(
					Killed
				);
				await attempt(world, input, memo).done;
				expect(
					{
						account: world.cf.snapshot(),
						name: world.names.recordOf(input.subdomain),
						operation: (await world.store.get(RETRY_OP))?.status,
						earlier: await world.store.siteState(world.siteId)
					},
					JSON.stringify(script)
				).toEqual(expected);
			}
		}
	});
});
