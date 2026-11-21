import { describe, expect, it, vi } from 'vitest';
import { siteId as siteIdSchema } from '../../../contracts/src/common';
import { budgetAuthorityOf } from '../../../engine/src/adapters/authority';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import { PermanentError } from '../../../engine/src/step';
import {
	applySiteAuthState,
	nextSiteAuthState,
	planSiteAuthState,
	runSiteAuthState,
	type SiteAuthStateInput
} from '../../../engine/src/workflows/site-auth-state';
import { authorityState, newSiteId } from '../dispatch/fakes';
import { makeRunner, makeWorld, type World } from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const OP = `op_${'s'.repeat(26)}`;

async function rig(state: SiteAuthStateInput['state'], held = 'active' as const) {
	const world = await makeWorld();
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, kind, category, plane, config, state,
			primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, 'Quiet Otter', 'drupal', 'cms', 'managed', 'managed', 'active', ?, 1, 1, 1)`
		)
		.run(world.siteId, world.orgId, world.input.hostname);
	await world.deps.authority.apply(
		await authorityState({ siteId: siteIdSchema.parse(world.siteId), state: held })
	);
	const input: SiteAuthStateInput = {
		operationId: OP,
		orgId: world.orgId,
		siteId: world.siteId,
		accountId: world.accountId,
		state,
		actor: 'user:admin',
		reason: state === 'suspended' ? 'abuse' : 'lift'
	};
	const frozen = await freezePlan(planSiteAuthState(input));
	await world.store.begin({
		operation: newOperation({
			id: OP,
			orgId: world.orgId,
			idempotencyKey: `auth-${state}`,
			frozen,
			now: world.clock.now()
		}),
		accountId: world.accountId,
		siteId: world.siteId
	});
	return { world, input };
}

const run = (world: World, input: SiteAuthStateInput) =>
	runSiteAuthState(makeRunner(new Map()).runner, world.deps, input);

describe('the site authority state workflow', () => {
	it('suspends an active site through the authority and marks the site row', async () => {
		const { world, input } = await rig('suspended');
		expect(await run(world, input)).toEqual({ status: 'succeeded' });
		expect(world.authority.stateOf(world.siteId)).toMatchObject({
			state: 'suspended',
			generation: 2
		});
		expect(await world.store.siteState(world.siteId)).toBe('suspended');
		expect((await world.store.get(OP))?.status).toBe('succeeded');
	});

	it('lifts a suspension and marks the site row active again', async () => {
		const { world, input } = await rig('active', 'suspended' as never);
		world.sqlite.prepare("UPDATE sites SET state = 'suspended'").run();
		expect(await run(world, input)).toEqual({ status: 'succeeded' });
		expect(world.authority.stateOf(world.siteId)?.state).toBe('active');
		expect(await world.store.siteState(world.siteId)).toBe('active');
	});

	it('writes nothing when the site already holds the state, so a repeat is safe', async () => {
		const { world, input } = await rig('suspended');
		await run(world, input);
		const generation = world.authority.stateOf(world.siteId)?.generation;
		expect(await applySiteAuthState(world.deps, world.siteId, 'suspended')).toBe('unchanged');
		expect(world.authority.stateOf(world.siteId)?.generation).toBe(generation);
	});

	it('refuses a revoked site, which never comes back', async () => {
		const { world, input } = await rig('active', 'revoked' as never);
		const outcome = await run(world, input);
		expect(outcome.status).toBe('failed');
		expect(world.authority.stateOf(world.siteId)?.state).toBe('revoked');
	});

	it('fails with no authority record to write', async () => {
		const { world, input } = await rig('suspended');
		await expect(
			runSiteAuthState(makeRunner(new Map()).runner, world.deps, {
				...input,
				siteId: `site_${'z'.repeat(26)}`
			})
		).resolves.toMatchObject({ status: 'failed' });
	});
});

describe('which states the workflow changes', () => {
	const base = async (state: 'active' | 'plan-grace' | 'over-budget' | 'suspended' | 'revoked') =>
		authorityState({ state });

	it('suspends from any state but revoked and lifts only a suspension', async () => {
		expect(nextSiteAuthState(await base('over-budget'), 'suspended')?.state).toBe('suspended');
		expect(nextSiteAuthState(await base('suspended'), 'suspended')).toBeNull();
		expect(nextSiteAuthState(await base('suspended'), 'active')?.state).toBe('active');
		expect(nextSiteAuthState(await base('over-budget'), 'active')).toBeNull();
		expect(nextSiteAuthState(await base('plan-grace'), 'active')).toBeNull();
		expect(() => nextSiteAuthState({ ...awaitless(), state: 'revoked' }, 'suspended')).toThrow(
			PermanentError
		);
	});
});

function awaitless() {
	return {
		siteId: newSiteId(),
		epoch: 1,
		generation: 1,
		state: 'active' as const,
		risk: 'established' as const,
		limits: {},
		accessRuleHash: `sha256:${'0'.repeat(64)}` as never
	};
}

describe('a suspended site and the budget writer', () => {
	it('is never flipped to active, over-budget or grace by a budget answer', async () => {
		const { world, input } = await rig('suspended');
		await run(world, input);
		const apply = vi.fn();
		const writer = budgetAuthorityOf({
			siteAuth: () => ({ read: () => world.deps.authority.read(world.siteId), apply }),
			controlKey: {} as CryptoKey,
			now: () => world.clock.now()
		});
		for (const state of ['ok', 'over-budget', 'plan-grace'] as const) {
			expect(
				await writer.applyBudgetState(world.siteId, { state, blockAtViews: 10 })
			).toEqual({
				outcome: 'security-state'
			});
		}
		expect(apply).not.toHaveBeenCalled();
		expect(world.authority.stateOf(world.siteId)?.state).toBe('suspended');
	});
});
