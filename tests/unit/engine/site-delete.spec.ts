import { describe, expect, it } from 'vitest';
import { buildPlan, freezePlan, newOperation } from '../../../engine/src/operations/state';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	checkPurge,
	planSiteDelete,
	planSitePurge,
	PURGE_REFUSALS,
	runSiteDelete,
	runSitePurge,
	type PurgeRefusal
} from '../../../engine/src/workflows/site-delete';
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

const DELETE_OP = `op_${'d'.repeat(26)}`;
const PURGE_OP = `op_${'u'.repeat(26)}`;
const HOLD_MS = 7 * 86_400_000;

async function created() {
	const world = await makeWorld();
	await beginCreate(world);
	const { runner } = makeRunner(new Map());
	await runSiteCreate(runner, world.deps, world.input);
	return world;
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

const deleteInput = (world: World, operationId = DELETE_OP) => ({
	operationId,
	siteId: world.siteId,
	accountId: world.accountId,
	hostnames: [world.input.hostname]
});

const purgeInput = (world: World, patch: Partial<Parameters<typeof runSitePurge>[2]> = {}) => ({
	operationId: PURGE_OP,
	siteId: world.siteId,
	accountId: world.accountId,
	subdomain: world.input.subdomain,
	confirm: world.siteId,
	holdUntil: world.clock.now(),
	...patch
});

function deleteRun(world: World, memo: Memo, script: RunnerScript = {}) {
	const { runner, executed } = makeRunner(memo, script);
	return { executed, done: runSiteDelete(runner, world.deps, deleteInput(world)) };
}

function purgeRun(world: World, memo: Memo, script: RunnerScript = {}, patch = {}) {
	const { runner, executed } = makeRunner(memo, script);
	return { executed, done: runSitePurge(runner, world.deps, purgeInput(world, patch)) };
}

async function deleted() {
	const world = await created();
	await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
	const run = deleteRun(world, new Map());
	const outcome = await run.done;
	return { world, run, outcome };
}

const seen = new Set<PurgeRefusal>();
function refusal(patch: Parameters<typeof checkPurge>[0]) {
	const result = checkPurge(patch);
	if (result !== null) seen.add(result);
	return result;
}

describe('site.delete', () => {
	it('revokes authority and drops the route first, then tombstones and keeps every resource', async () => {
		const { world, run, outcome } = await deleted();
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(run.executed).toEqual([
			'start',
			'lease',
			'revoke',
			'route',
			'tombstone',
			'finalize',
			'release-lease'
		]);
		expect(world.authority.stateOf(world.siteId)).toMatchObject({
			state: 'revoked',
			generation: 2
		});
		expect(world.authority.snapshot().hosts).toEqual([]);
		expect(await world.store.siteState(world.siteId)).toBe('tombstoned');
		expect(await world.ledger.live(world.siteId)).toHaveLength(5);
		const account = world.cf.snapshot();
		expect(account.kv).toHaveLength(2);
		expect(account.r2).toHaveLength(2);
		expect(account.scripts).toHaveLength(1);
		expect(world.names.recordOf(world.input.subdomain)).toMatchObject({ state: 'taken' });
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		const operation = await world.store.get(DELETE_OP);
		expect(operation?.status).toBe('succeeded');
		expect(operation?.steps.every((step) => step.state === 'succeeded')).toBe(true);
	});

	it('ends in the same state when killed at any step, before or after it saved', async () => {
		const { world: reference, run } = await deleted();
		const expected = await snapshotWorld(reference, [DELETE_OP]);
		for (let k = 0; k < run.executed.length; k++) {
			for (const kind of ['killAfter', 'killDuring'] as const) {
				const world = await created();
				await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
				const memo: Memo = new Map();
				const script = kind === 'killAfter' ? { killAfter: k } : { killDuring: k + 1 };
				await expect(deleteRun(world, memo, script).done).rejects.toBeInstanceOf(Killed);
				await deleteRun(world, memo).done;
				expect(await snapshotWorld(world, [DELETE_OP]), `${kind} ${k}`).toEqual(expected);
			}
		}
	});

	it('discards the unread admin password and keeps the owner token while the site can be restored', async () => {
		const world = await created();
		expect(custodyRows(world)).toEqual({
			ownerToken: true,
			pending: [`${world.siteId}:admin-password`]
		});
		await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
		await deleteRun(world, new Map()).done;
		expect(custodyRows(world)).toEqual({ ownerToken: true, pending: [] });
	});

	it('can be repeated on a site that is already revoked', async () => {
		const { world } = await deleted();
		const expected = await snapshotWorld(world);
		const again = world.authority.stateOf(world.siteId);
		await begin(world, `op_${'e'.repeat(26)}`, planSiteDelete({ siteId: world.siteId }));
		const { runner } = makeRunner(new Map());
		const outcome = await runSiteDelete(
			runner,
			world.deps,
			deleteInput(world, `op_${'e'.repeat(26)}`)
		);
		expect(outcome.status).toBe('succeeded');
		expect(world.authority.stateOf(world.siteId)).toEqual(again);
		expect((await snapshotWorld(world)).account).toEqual(expected.account);
	});

	it('keeps going where it stopped when a step fails, with nothing deleted', async () => {
		const world = await created();
		await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
		const outcome = await deleteRun(world, new Map(), {
			failAt: { step: 'route', when: 'before' }
		}).done;
		expect(outcome.status).toBe('failed');
		expect(world.authority.stateOf(world.siteId)?.state).toBe('revoked');
		expect(await world.ledger.live(world.siteId)).toHaveLength(5);
		expect(world.cf.snapshot().scripts).toHaveLength(1);
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		const operation = await world.store.get(DELETE_OP);
		expect(operation?.status).toBe('failed');
		expect(operation?.steps.find((step) => step.id === 'route')?.state).toBe('failed');
		expect(operation?.steps.find((step) => step.id === 'tombstone')?.state).toBe('skipped');
	});

	it('is cancelled before it starts when the destructive budget is spent', async () => {
		const world = await created();
		const six = buildPlan({
			type: 'site.delete',
			targetIds: [1, 2, 3, 4, 5, 6].map((n) => `site_${String(n).padStart(26, 'x')}`),
			preconditions: [],
			steps: planSiteDelete({ siteId: world.siteId }).steps
		});
		await begin(world, DELETE_OP, six);
		const outcome = await deleteRun(world, new Map()).done;
		expect(outcome.status).toBe('cancelled');
		if (outcome.status !== 'cancelled') return;
		expect(outcome.reason).toContain('destructive_budget');
		expect(await world.store.siteState(world.siteId)).toBe('active');
		expect(world.authority.stateOf(world.siteId)?.state).toBe('active');
		expect((await world.store.get(DELETE_OP))?.status).toBe('cancelled');
	});
});

describe('checkPurge', () => {
	const base = {
		state: 'tombstoned' as const,
		siteId: 'site_a',
		confirm: 'site_a',
		holdUntil: 100,
		now: 100
	};

	it('accepts a tombstoned or purge-eligible site that was confirmed once the hold has passed', () => {
		expect(refusal(base)).toBeNull();
		expect(refusal({ ...base, state: 'purge-eligible' })).toBeNull();
	});

	it('refuses a site that is not tombstoned, an unconfirmed purge and a hold still running', () => {
		for (const state of ['active', 'suspended', 'deleted', null] as const) {
			expect(refusal({ ...base, state })).toBe('not_tombstoned');
		}
		expect(refusal({ ...base, confirm: '' })).toBe('confirmation_required');
		expect(refusal({ ...base, confirm: 'site_b' })).toBe('confirmation_required');
		expect(refusal({ ...base, now: 99 })).toBe('hold_active');
	});

	it('has tripped every refusal it can give', () => {
		expect([...seen].sort()).toEqual([...PURGE_REFUSALS].sort());
	});
});

describe('site.purge', () => {
	async function tombstoned() {
		const { world } = await deleted();
		await begin(world, PURGE_OP, planSitePurge({ siteId: world.siteId }));
		world.clock.advance(HOLD_MS + 1);
		return world;
	}

	it('does nothing without the second action', async () => {
		const world = await tombstoned();
		const before = await snapshotWorld(world);
		const run = purgeRun(world, new Map(), {}, { confirm: '' });
		const outcome = await run.done;
		expect(outcome).toEqual({ status: 'cancelled', reason: 'confirmation_required' });
		expect(run.executed).toEqual(['guard', 'refuse']);
		const after = await snapshotWorld(world, [PURGE_OP]);
		expect(after.account).toEqual(before.account);
		expect(after.resources).toEqual(before.resources);
		expect(after.siteState).toBe('tombstoned');
		expect(after.name).toEqual(before.name);
		expect(after.lease).toEqual(before.lease);
		expect(after.others[0]).toMatchObject({ status: 'cancelled' });
	});

	it('does nothing while the hold is running or the site is not tombstoned', async () => {
		const world = await tombstoned();
		const early = await purgeRun(world, new Map(), {}, { holdUntil: world.clock.now() + 1 })
			.done;
		expect(early).toEqual({ status: 'cancelled', reason: 'hold_active' });
		expect(world.cf.snapshot().scripts).toHaveLength(1);

		const active = await created();
		await begin(active, PURGE_OP, planSitePurge({ siteId: active.siteId }));
		const refused = await purgeRun(active, new Map()).done;
		expect(refused).toEqual({ status: 'cancelled', reason: 'not_tombstoned' });
		expect(active.cf.snapshot().scripts).toHaveLength(1);
		expect(await active.store.siteState(active.siteId)).toBe('active');
	});

	it('deletes the script and every resource, releases the name and marks the site deleted', async () => {
		const world = await tombstoned();
		const run = purgeRun(world, new Map());
		const outcome = await run.done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(run.executed).toEqual([
			'guard',
			'start',
			'lease',
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
		const rows = await world.ledger.all(world.siteId);
		expect(rows).toHaveLength(5);
		expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
		expect(await world.store.siteState(world.siteId)).toBe('deleted');
		expect(world.names.recordOf(world.input.subdomain)).toMatchObject({ state: 'held' });
		expect(world.names.isFree(world.input.subdomain)).toBe(false);
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('discards the owner token and the pending secret with the site', async () => {
		const world = await tombstoned();
		expect(custodyRows(world)).toEqual({ ownerToken: true, pending: [] });
		await purgeRun(world, new Map()).done;
		expect(custodyRows(world)).toEqual({ ownerToken: false, pending: [] });
	});

	it('ends in the same state when killed at any step, before or after it saved', async () => {
		const reference = await tombstoned();
		const run = purgeRun(reference, new Map());
		await run.done;
		const expected = await snapshotWorld(reference, [PURGE_OP]);
		for (let k = 0; k < run.executed.length; k++) {
			for (const kind of ['killAfter', 'killDuring'] as const) {
				const world = await tombstoned();
				const memo: Memo = new Map();
				const script = kind === 'killAfter' ? { killAfter: k } : { killDuring: k + 1 };
				await expect(purgeRun(world, memo, script).done).rejects.toBeInstanceOf(Killed);
				await purgeRun(world, memo).done;
				expect(await snapshotWorld(world, [PURGE_OP]), `${kind} ${k}`).toEqual(expected);
			}
		}
	});

	it('is finished by a second purge when the first fails halfway', async () => {
		const world = await tombstoned();
		const first = await purgeRun(world, new Map(), {
			failAt: { step: 'resources', when: 'after' }
		}).done;
		expect(first.status).toBe('failed');
		expect(world.cf.snapshot().scripts).toEqual([]);
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		expect(await world.store.siteState(world.siteId)).toBe('tombstoned');

		const retry = `op_${'v'.repeat(26)}`;
		await begin(world, retry, planSitePurge({ siteId: world.siteId }));
		const { runner } = makeRunner(new Map());
		const second = await runSitePurge(
			runner,
			world.deps,
			purgeInput(world, { operationId: retry })
		);
		expect(second).toEqual({ status: 'succeeded' });
		expect(await world.store.siteState(world.siteId)).toBe('deleted');
	});
});

describe('site.delete and a hostname that changed hands', () => {
	const OTHER = `site_${'x'.repeat(26)}`;
	const theirs = { siteId: OTHER, script: `s-${'x'.repeat(26)}`, epoch: 1 };

	it('removes its own route', async () => {
		const { world } = await deleted();
		expect(world.authority.snapshot().hosts).toEqual([]);
	});

	it('deletes nothing when the recorded hostname now points at a different site', async () => {
		const world = await created();
		await world.authority.authority.putHost(world.input.hostname, theirs);
		await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
		const outcome = await deleteRun(world, new Map()).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(world.authority.snapshot().hosts).toEqual([[world.input.hostname, theirs]]);
		const operation = await world.store.get(DELETE_OP);
		expect(operation?.finalObservation?.summary).toContain(
			`left in place, held by another site: ${world.input.hostname}`
		);
	});

	it('converges to the same state when killed at any step with the hostname held elsewhere', async () => {
		const setup = async () => {
			const world = await created();
			await world.authority.authority.putHost(world.input.hostname, theirs);
			await begin(world, DELETE_OP, planSiteDelete({ siteId: world.siteId }));
			return world;
		};
		const clean = await setup();
		const reference = deleteRun(clean, new Map());
		await reference.done;
		const expected = await snapshotWorld(clean, [DELETE_OP]);
		for (let j = 1; j <= reference.executed.length; j++) {
			const world = await setup();
			const memo: Memo = new Map();
			await expect(deleteRun(world, memo, { killDuring: j }).done).rejects.toBeInstanceOf(
				Killed
			);
			await deleteRun(world, memo).done;
			expect(await snapshotWorld(world, [DELETE_OP]), `killed during ${j}`).toEqual(expected);
			const operation = await world.store.get(DELETE_OP);
			expect(operation?.finalObservation?.summary).toContain('held by another site');
		}
	});
});
