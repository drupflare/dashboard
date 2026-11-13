import { describe, expect, it } from 'vitest';
import { OBSERVATION_OFFSETS_MS } from '../../../contracts/src/migration-cutover';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { CutoverDeps } from '../../../engine/src/ports';
import {
	CUTOVER_STEP_IDS,
	planMigrationCutover,
	runMigrationCutover,
	type MigrationCutoverInput
} from '../../../engine/src/workflows/migration-cutover';
import { readState, type CutoverState } from '../../../src/server/domain/cutover';
import {
	fakeCutover,
	makeCutoverRunner,
	type CutoverOptions,
	type WaitScript
} from './cutover-fakes';
import { Killed, makeWorld, type Memo, type RunnerScript } from './fakes';

type Policy = MigrationCutoverInput['policy'];

const HOUR = 3_600_000;
const approve: WaitScript = (call) =>
	call.type === 'cutover-approval' ? { payload: {} } : undefined;

// approves, then answers each decision wait from the list in order and lets every other one run out
function decisions(...answers: unknown[]): WaitScript {
	return (call) => {
		if (call.type === 'cutover-approval') return { payload: {} };
		const answer = answers[call.nth - 1];
		return answer === undefined ? undefined : { payload: answer };
	};
}

async function setup(options: CutoverOptions = {}, patch: Partial<MigrationCutoverInput> = {}) {
	const world = await makeWorld();
	const fake = fakeCutover(options);
	const deps: CutoverDeps = { ...world.deps, cutover: fake.ports };
	const input: MigrationCutoverInput = {
		operationId: world.operationId,
		orgId: world.orgId,
		site: { id: world.siteId, accountId: world.accountId },
		source: { ref: 'source-1' },
		hostname: 'www.example.test',
		policy: 'freeze',
		ttlSeconds: 60,
		expectedWindowSeconds: 120,
		approvalTimeoutMs: 24 * HOUR,
		choiceTimeoutMs: 7 * 24 * HOUR,
		...patch
	};
	const frozen = await freezePlan(planMigrationCutover(input));
	const operation = newOperation({
		id: input.operationId,
		orgId: input.orgId,
		idempotencyKey: 'cutover-1',
		frozen,
		now: world.clock.now()
	});
	await world.store.begin({
		operation,
		accountId: world.accountId,
		siteId: world.siteId
	});
	return { world, fake, deps, input };
}

type Aw = Awaited<ReturnType<typeof setup>>;

async function run(
	aw: Aw,
	options: { waits?: WaitScript; memo?: Memo; script?: RunnerScript } = {}
) {
	const { runner, executed, waits } = makeCutoverRunner(options.memo ?? new Map(), {
		waits: options.waits ?? approve,
		advance: aw.world.clock.advance,
		script: options.script
	});
	const outcome = await runMigrationCutover(runner, aw.deps, aw.input);
	return { outcome, executed, waits };
}

async function operationOf(aw: Aw) {
	return (await aw.world.store.get(aw.world.operationId))!;
}

async function stateOf(aw: Aw): Promise<CutoverState> {
	return readState((await operationOf(aw)).cursor)!;
}

// the source is read, frozen on request and handed its writes back; nothing offers to destroy it
function expectIntact(aw: Aw) {
	expect(aw.fake.onlyAllowedCalls()).toBe(true);
}

const countOf = (aw: Aw, effect: string) =>
	aw.fake.world.effects.filter((e) => e === effect).length;

describe('the plan', () => {
	it('names the destination site, the ten steps and the four observation points', () => {
		const plan = planMigrationCutover({
			operationId: 'op_x',
			orgId: 'org_x',
			site: { id: 'site_x', accountId: 'a' },
			source: { ref: 's' },
			hostname: 'www.example.test',
			policy: 'delta',
			ttlSeconds: 60,
			expectedWindowSeconds: null,
			approvalTimeoutMs: 1,
			choiceTimeoutMs: 1
		});
		expect(plan.type).toBe('migration.cutover');
		expect(plan.targetIds).toEqual(['site_x']);
		expect(plan.steps.map((step) => step.id)).toEqual([...CUTOVER_STEP_IDS]);
		expect(plan.steps.filter((step) => step.id.startsWith('observe-'))).toHaveLength(
			OBSERVATION_OFFSETS_MS.length
		);
		expect(plan.rollbackPoint).toBe('before the new site accepts its first write');
	});
});

describe('a cutover that goes through', () => {
	it('moves the address, keeps the source frozen and restores the record it lowered', async () => {
		const aw = await setup();
		const { outcome, waits } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		const { world } = aw.fake;
		expect(world.routedTo).toBe('destination');
		expect(world.routeHostnames).toEqual(['www.example.test']);
		expect(world.sourceOf.length).toBeGreaterThan(0);
		for (const asked of world.sourceOf) {
			expect(asked).toEqual({ ref: 'source-1', orgId: aw.input.orgId });
		}
		expect(world.ttl).toBe(3600);
		expect(world.policy).toBe('freeze');
		expect(world.promoted).not.toBeNull();
		expect(countOf(aw, 'snapshot')).toBe(1);
		expect(waits.filter((wait) => wait.type === 'cutover-approval')).toHaveLength(1);
		const operation = await operationOf(aw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		const state = await stateOf(aw);
		expect(state).toMatchObject({ state: 'completed', observed: 4, destinationWrites: 0 });
		expectIntact(aw);
	});

	it('waits for each observation point from the moment it routed', async () => {
		const aw = await setup();
		const start = aw.world.clock.now();
		const { waits } = await run(aw);
		const decisionWaits = waits.filter((wait) => wait.type === 'cutover-decision');
		expect(decisionWaits.map((wait) => wait.timeoutMs)).toEqual(
			OBSERVATION_OFFSETS_MS.map((offset, index) =>
				index === 0 ? offset : offset - OBSERVATION_OFFSETS_MS[index - 1]!
			)
		);
		expect(aw.world.clock.now() - start).toBeGreaterThanOrEqual(OBSERVATION_OFFSETS_MS[3]!);
	});

	it('waits for approval with the timeout the request set', async () => {
		const aw = await setup({}, { approvalTimeoutMs: 3 * HOUR });
		const { waits } = await run(aw);
		expect(waits.find((wait) => wait.type === 'cutover-approval')?.timeoutMs).toBe(3 * HOUR);
	});

	it('releases the writer lease while it waits for the owner', async () => {
		const aw = await setup();
		let held: unknown = 'unset';
		await run(aw, {
			waits: (call) => {
				if (call.type === 'cutover-approval') {
					held = aw.world.leases.stateOf(aw.world.siteId).holder;
					return { payload: {} };
				}
				return undefined;
			}
		});
		expect(held).toBeNull();
		expect(aw.world.leases.stateOf(aw.world.siteId).holder ?? null).toBeNull();
	});
});

describe('writes that arrive while the source is being frozen', () => {
	for (const policy of ['freeze', 'read-only', 'delta'] as Policy[]) {
		it(`under ${policy}, a write before the freeze is carried and one during it is refused`, async () => {
			const aw = await setup(
				{ atFreeze: () => void aw.fake.sourceWrite('during-freeze') },
				{ policy }
			);
			aw.fake.sourceWrite('before-capture');
			const { outcome } = await run(aw, {
				waits: (call) => {
					if (call.type !== 'cutover-approval') return undefined;
					aw.fake.sourceWrite('while-waiting');
					return { payload: {} };
				}
			});
			expect(outcome).toEqual({ status: 'succeeded' });
			const { world } = aw.fake;
			expect(world.sourceWrites).toEqual(['before-capture', 'while-waiting']);
			expect(world.refused).toEqual(['during-freeze']);
			expect(world.policy).toBe(policy);
			// the delta taken before the approval missed the write that came after it
			expect(world.promoted?.delta).toBe('delta-2');
			expect((await stateOf(aw)).deltaMarker).toBe('delta-2');
			expectIntact(aw);
		});
	}

	it('applies the write policy only after the owner approves, and promotes after the last delta', async () => {
		const aw = await setup();
		await run(aw);
		const order = aw.fake.world.calls.filter((call) =>
			[
				'lowerTtl',
				'snapshot',
				'delta',
				'validate',
				'applyWritePolicy',
				'promote',
				'route'
			].includes(call)
		);
		expect(order).toEqual([
			'lowerTtl',
			'snapshot',
			'delta',
			'validate',
			'applyWritePolicy',
			'delta',
			'validate',
			'promote',
			'route'
		]);
	});
});

describe('a cutover that is killed and resumed', () => {
	async function reference() {
		const aw = await setup();
		const { executed } = await run(aw);
		return executed;
	}
	const index = (executed: string[], label: string) =>
		executed.findIndex((name) => name.startsWith(`${label}.`));

	async function killedThenResumed(label: string, kind: 'killAfter' | 'killDuring') {
		const executed = await reference();
		const at = index(executed, label);
		expect(at).toBeGreaterThan(-1);
		const aw = await setup();
		const memo: Memo = new Map();
		const script = kind === 'killAfter' ? { killAfter: at + 1 } : { killDuring: at + 1 };
		await expect(run(aw, { memo, script })).rejects.toBeInstanceOf(Killed);
		const before = aw.fake.world.effects.length;
		const { outcome } = await run(aw, { memo });
		expect(outcome).toEqual({ status: 'succeeded' });
		return { aw, before };
	}

	it('finishes after a death right after the snapshot, with the snapshot taken once', async () => {
		const { aw, before } = await killedThenResumed('snapshot', 'killAfter');
		expect(countOf(aw, 'snapshot')).toBe(1);
		expect(countOf(aw, 'lowerTtl')).toBe(1);
		expect(aw.fake.world.effects.length).toBeGreaterThan(before);
		expectIntact(aw);
	});

	it('finishes after a death while the snapshot ran, when its answer was lost', async () => {
		const { aw } = await killedThenResumed('snapshot', 'killDuring');
		expect(countOf(aw, 'snapshot')).toBe(1);
	});

	it('finishes after a death while the write policy was being applied', async () => {
		const { aw } = await killedThenResumed('apply-write-policy', 'killDuring');
		expect(countOf(aw, 'applyWritePolicy')).toBe(1);
		expect(aw.fake.world.policy).toBe('freeze');
	});

	it('finishes after a death while the new site was being promoted', async () => {
		const { aw } = await killedThenResumed('promote', 'killDuring');
		expect(countOf(aw, 'promote')).toBe(1);
		expect(aw.fake.world.routedTo).toBe('destination');
	});

	it('does nothing again when every step is replayed', async () => {
		const aw = await setup();
		const memo: Memo = new Map();
		await run(aw, { memo });
		const calls = [...aw.fake.world.calls];
		const again = await run(aw, { memo });
		expect(again.outcome).toEqual({ status: 'succeeded' });
		expect(again.executed).toEqual([]);
		expect(aw.fake.world.calls).toEqual(calls);
	});
});

describe('a rollback', () => {
	const rollback = { kind: 'rollback' };

	it('before the first write is a DNS reversal that gives the source its writes back', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, { waits: decisions(rollback) });
		expect(outcome.status).toBe('rolled-back');
		const { world } = aw.fake;
		expect(world.routedTo).toBe('source');
		expect(world.policy).toBeNull();
		expect(world.ttl).toBe(3600);
		const state = await stateOf(aw);
		expect(state).toMatchObject({ state: 'rolled-back', destinationWrites: 0, choice: null });
		const operation = await operationOf(aw);
		expect(operation.status).toBe('rolled-back');
		expectIntact(aw);
	});

	it('after the first write refuses the reversal and keeps the new site serving', async () => {
		const aw = await setup();
		let recorded: CutoverState | null = null;
		const { outcome } = await run(aw, {
			waits: async (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth === 1) {
					aw.fake.destinationWrite(3);
					return { payload: rollback };
				}
				if (call.nth === 2) {
					recorded = await stateOf(aw);
					return undefined;
				}
				return undefined;
			}
		});
		const refused = recorded as CutoverState | null;
		expect(refused?.refusal?.code).toBe('reversal_closed');
		expect(refused?.refusal?.message).toContain('keep the new site');
		expect(refused?.refusal?.message).toContain('abandon');
		expect(refused?.refusal?.message).toContain('export');
		expect(refused?.destinationWrites).toBe(3);
		expect(aw.fake.world.routedTo).toBe('destination');
		expect(aw.fake.world.calls.filter((call) => call === 'route')).toHaveLength(1);
		expect(outcome.status).toBe('succeeded');
		expectIntact(aw);
	});

	it('records a choice to keep the new site and finishes the observations', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, {
			waits: (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth === 1) {
					aw.fake.destinationWrite(2);
					return { payload: { kind: 'choice', value: 'keep-new' } };
				}
				return undefined;
			}
		});
		expect(outcome).toEqual({ status: 'succeeded' });
		const state = await stateOf(aw);
		expect(state.choice).toMatchObject({ value: 'keep-new', writesAtChoice: 2 });
		expect(state.observed).toBe(4);
		expect(aw.fake.world.routedTo).toBe('destination');
	});

	it('abandons the new data by sending traffic back to the source', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, {
			waits: (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth === 1) {
					aw.fake.destinationWrite(4);
					return { payload: { kind: 'choice', value: 'abandon-new-data' } };
				}
				return undefined;
			}
		});
		expect(outcome.status).toBe('rolled-back');
		expect(aw.fake.world.routedTo).toBe('source');
		expect(aw.fake.world.policy).toBeNull();
		expect(aw.fake.world.exported).toBe(0);
		const state = await stateOf(aw);
		expect(state.choice).toMatchObject({ value: 'abandon-new-data', writesAtChoice: 4 });
		expectIntact(aw);
	});

	it('exports the new changes, names what the path back cannot carry, then goes back', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, {
			waits: (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth === 1) {
					aw.fake.destinationWrite(5);
					return { payload: { kind: 'choice', value: 'export-changes' } };
				}
				return undefined;
			}
		});
		expect(outcome.status).toBe('rolled-back');
		expect(aw.fake.world.exported).toBe(1);
		expect(aw.fake.world.routedTo).toBe('source');
		const state = await stateOf(aw);
		expect(state).toMatchObject({
			exportReference: 'export-5',
			cannotCarry: ['uploaded files'],
			choice: { value: 'export-changes', writesAtChoice: 5 }
		});
	});

	describe('the read after the address moved back', () => {
		const exporting = (aw: Aw): WaitScript => {
			let wrote = false;
			return (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.type === 'cutover-decision' && !wrote) {
					wrote = true;
					aw.fake.destinationWrite(5);
					return { payload: { kind: 'choice', value: 'export-changes' } };
				}
				return undefined;
			};
		};

		it('reads from the first read after old caches expire, then ends the count', async () => {
			const aw = await setup({ finalStatements: 3 }, { ttlSeconds: 600 });
			const { outcome, waits } = await run(aw, { waits: exporting(aw) });
			expect(outcome.status).toBe('rolled-back');
			const { world } = aw.fake;
			expect(world.finalSince).toEqual([5]);
			const at = (name: string) => world.calls.indexOf(name);
			expect(at('route')).toBeGreaterThan(-1);
			expect(at('exportFinalChanges')).toBeGreaterThan(world.calls.lastIndexOf('route'));
			expect(at('stopCounting')).toBeGreaterThan(at('exportFinalChanges'));
			const settle = waits.filter((wait) => wait.type === 'cutover-settle');
			expect(settle).toHaveLength(1);
			expect(settle[0]!.timeoutMs).toBe(600_000);
			expect(await stateOf(aw)).toMatchObject({
				state: 'rolled-back',
				finalChanges: 'ready',
				finalStatements: 3
			});
			expectIntact(aw);
		});

		it('says there is nothing after the first file when the read finds nothing', async () => {
			const aw = await setup();
			await run(aw, { waits: exporting(aw) });
			expect(await stateOf(aw)).toMatchObject({ finalChanges: 'none', finalStatements: 0 });
		});

		it('keeps the first file and still closes when the read cannot be made', async () => {
			const aw = await setup({ fail: { exportFinalChanges: 99 } });
			const { outcome } = await run(aw, { waits: exporting(aw) });
			expect(outcome.status).toBe('rolled-back');
			expect(await stateOf(aw)).toMatchObject({
				finalChanges: 'unread',
				exportReference: 'export-5'
			});
			expect(aw.fake.world.countEnds).toBe(1);
			expect(aw.fake.world.routedTo).toBe('source');
		});

		it('is not made for a move that goes back without exporting', async () => {
			const aw = await setup();
			await run(aw, { waits: decisions({ kind: 'rollback' }) });
			expect(aw.fake.world.calls).not.toContain('exportFinalChanges');
			expect((await stateOf(aw)).finalChanges).toBeNull();
		});

		it('gives the same ending when it is killed after or during any step and run again', async () => {
			const reference = await (async () => {
				const aw = await setup({ finalStatements: 2 });
				return (await run(aw, { waits: exporting(aw) })).executed;
			})();
			expect(reference.length).toBeGreaterThan(0);
			for (let at = 0; at < reference.length; at++) {
				for (const kind of ['killAfter', 'killDuring'] as const) {
					const aw = await setup({ finalStatements: 2 });
					const memo: Memo = new Map();
					const script =
						kind === 'killAfter' ? { killAfter: at + 1 } : { killDuring: at + 1 };
					const waits = exporting(aw);
					// a kill after the very last step lets the first run finish
					const first = await run(aw, { memo, script, waits }).then(
						() => null,
						(error: unknown) => error
					);
					if (first !== null) expect(first).toBeInstanceOf(Killed);
					const { outcome } = await run(aw, { memo, waits });
					expect(outcome.status, `${kind} ${at}`).toBe('rolled-back');
					expect(aw.fake.world.finalSince.length, `${kind} ${at}`).toBe(1);
					expect(aw.fake.world.countEnds, `${kind} ${at}`).toBe(1);
					expect(await stateOf(aw), `${kind} ${at}`).toMatchObject({
						finalChanges: 'ready',
						finalStatements: 2
					});
				}
			}
		});
	});

	it('records a count that would not end on a rolled-back move too', async () => {
		const aw = await setup({ fail: { stopCounting: 99 } });
		const { outcome } = await run(aw, { waits: decisions({ kind: 'rollback' }) });
		expect(outcome.status).toBe('rolled-back');
		expect((await operationOf(aw)).finalObservation?.summary).toContain('still counting');
	});

	it('refuses a choice before any write and a second choice after one', async () => {
		const aw = await setup();
		const seen: (string | undefined)[] = [];
		await run(aw, {
			waits: async (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth > 1) {
					seen.push((await stateOf(aw)).refusal?.code);
				}
				if (call.nth === 1) return { payload: { kind: 'choice', value: 'keep-new' } };
				if (call.nth === 2) {
					aw.fake.destinationWrite();
					return { payload: { kind: 'choice', value: 'keep-new' } };
				}
				if (call.nth === 3)
					return { payload: { kind: 'choice', value: 'abandon-new-data' } };
				return undefined;
			}
		});
		expect(seen.slice(0, 3)).toEqual(['no_writes_yet', undefined, 'choice_recorded']);
	});

	it('ignores a decision it cannot read', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, { waits: decisions({ kind: 'explode' }, null) });
		expect(outcome).toEqual({ status: 'succeeded' });
		expect((await stateOf(aw)).refusal).toBeNull();
	});
});

describe('a delta that conflicts', () => {
	it('before the approval stops the cutover and leaves the source as it was', async () => {
		const aw = await setup({ validate: { 1: 'the orders table differs' } });
		const { outcome, waits } = await run(aw);
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' && outcome.reason).toContain('orders table');
		const { world } = aw.fake;
		expect(world.promoted).toBeNull();
		expect(world.routedTo).toBe('source');
		expect(world.policy).toBeNull();
		expect(world.ttl).toBe(3600);
		expect(world.calls).not.toContain('applyWritePolicy');
		expect(world.calls).not.toContain('restoreWrites');
		expect(waits).toEqual([]);
		expectIntact(aw);
	});

	it('after the freeze refuses to promote and hands the source its writes back', async () => {
		const aw = await setup({ validate: { 2: 'row 4 changed on both sides' } });
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('rolled-back');
		const { world } = aw.fake;
		expect(world.calls).toContain('applyWritePolicy');
		expect(world.promoted).toBeNull();
		expect(world.routedTo).toBe('source');
		expect(world.policy).toBeNull();
		expect(world.ttl).toBe(3600);
		const operation = await operationOf(aw);
		expect(operation.status).toBe('rolled-back');
		expect(operation.steps.find((step) => step.id === 'final-delta')?.state).toBe('failed');
		expectIntact(aw);
	});
});

describe('an approval that nobody gives', () => {
	it('runs out, changes nothing on the source and ends rolled back', async () => {
		const aw = await setup();
		const { outcome } = await run(aw, { waits: () => undefined });
		expect(outcome.status).toBe('rolled-back');
		expect(outcome.status === 'rolled-back' && outcome.reason).toContain('approved');
		const { world } = aw.fake;
		expect(world.policy).toBeNull();
		expect(world.calls).not.toContain('applyWritePolicy');
		expect(world.ttl).toBe(3600);
		const operation = await operationOf(aw);
		expect(operation.steps.find((step) => step.id === 'owner-approval')?.state).toBe('failed');
		expect(aw.world.clock.now()).toBeGreaterThan(0);
		expectIntact(aw);
	});
});

describe('observation', () => {
	const points = [0, 1, 2, 3];

	for (const point of points) {
		it(`that cannot be read at point ${point} never reverses DNS`, async () => {
			const observations = points.map((i) =>
				i === point ? ('throw' as const) : { healthy: true }
			);
			const aw = await setup({ observations });
			const { outcome } = await run(aw);
			const state = await stateOf(aw);
			const operation = await operationOf(aw);
			expect(aw.fake.world.routedTo).toBe('destination');
			expect(aw.fake.world.calls.filter((call) => call === 'route')).toHaveLength(1);
			expect(operation.steps.find((step) => step.id.startsWith('observe-'))).toBeDefined();
			const stepId = ['observe-5m', 'observe-30m', 'observe-6h', 'observe-24h'][point]!;
			expect(operation.steps.find((step) => step.id === stepId)?.state).toBe('failed');
			if (point === 3) {
				expect(outcome.status).toBe('failed');
				expect(state.state).toBe('failed');
			} else {
				expect(outcome).toEqual({ status: 'succeeded' });
				expect(state.state).toBe('completed');
			}
			expectIntact(aw);
		});

		it(`that finds the new site unhealthy at point ${point} before any write goes back to the source`, async () => {
			const observations = points.map((i) =>
				i === point ? { healthy: false, writes: 0 } : { healthy: true }
			);
			const aw = await setup({ observations });
			const { outcome } = await run(aw);
			expect(outcome.status).toBe('rolled-back');
			expect(aw.fake.world.routedTo).toBe('source');
			expect(aw.fake.world.policy).toBeNull();
			expect((await stateOf(aw)).state).toBe('rolled-back');
			expectIntact(aw);
		});
	}

	it('that finds the new site unhealthy after a write asks for a choice and does not reverse', async () => {
		const observations = [
			{ healthy: false, writes: 2 },
			{ healthy: true },
			{ healthy: true },
			{ healthy: true }
		];
		const aw = await setup({ observations });
		let asked: CutoverState | null = null;
		await run(aw, {
			waits: async (call) => {
				if (call.type === 'cutover-approval') return { payload: {} };
				if (call.nth === 2) asked = await stateOf(aw);
				return undefined;
			}
		});
		const state = asked as CutoverState | null;
		expect(state?.needsChoice).toBe(true);
		expect(state?.destinationWrites).toBe(2);
		expect(aw.fake.world.routedTo).toBe('destination');
	});

	it('that is still waiting on a choice at the end runs out and leaves the new site serving', async () => {
		const observations = [
			{ healthy: true },
			{ healthy: true },
			{ healthy: true },
			{ healthy: false, writes: 1 }
		];
		const aw = await setup({ observations }, { choiceTimeoutMs: 2 * HOUR });
		const { outcome, waits } = await run(aw);
		expect(outcome.status).toBe('failed');
		expect(waits.at(-1)).toMatchObject({ type: 'cutover-decision', timeoutMs: 2 * HOUR });
		expect(aw.fake.world.routedTo).toBe('destination');
		const state = await stateOf(aw);
		expect(state.state).toBe('failed');
		expect(state.reason).toContain('No choice was recorded');
		expectIntact(aw);
	});
});

describe('a step that keeps failing', () => {
	it('before the approval unwinds the source', async () => {
		const aw = await setup({ fail: { snapshot: 99 } });
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('rolled-back');
		expect(aw.fake.world.ttl).toBe(3600);
		expect(aw.fake.world.policy).toBeNull();
		expectIntact(aw);
	});

	it('at the promote hands the source its writes back', async () => {
		const aw = await setup({ fail: { promote: 99 } });
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('rolled-back');
		expect(aw.fake.world.policy).toBeNull();
		expect(aw.fake.world.routedTo).toBe('source');
	});

	it('at the route sends traffic back to the source before it ends', async () => {
		const aw = await setup({ fail: { route: 1 } });
		const { outcome } = await run(aw, { script: { retries: 0 } });
		expect(outcome.status).toBe('rolled-back');
		expect(aw.fake.world.routedTo).toBe('source');
		expect(aw.fake.world.policy).toBeNull();
	});

	it('that cannot be undone ends failed and names what is left', async () => {
		const aw = await setup({ fail: { snapshot: 99, restoreTtl: 99 } });
		const { outcome } = await run(aw);
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['ttl'] });
		const state = await stateOf(aw);
		expect(state.state).toBe('failed');
	});

	it('refuses a second site on the same writer lease', async () => {
		const aw = await setup();
		await aw.world.leases.leases.acquire(aw.world.siteId, {
			holder: 'someone-else',
			purpose: 'site.upgrade',
			ttlMs: 10 * HOUR
		});
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('failed');
		expect(aw.fake.world.calls).toEqual([]);
		expect((await operationOf(aw)).steps.find((step) => step.id === 'lease')?.state).toBe(
			'failed'
		);
	});
});

describe('the count of accepted writes', () => {
	const choice =
		(value: string, writes: number) =>
		(aw: Aw): WaitScript =>
		(call) => {
			if (call.type === 'cutover-approval') return { payload: {} };
			if (call.nth === 1) {
				aw.fake.destinationWrite(writes);
				return { payload: { kind: 'choice', value } };
			}
			return undefined;
		};
	const ended = (aw: Aw) => {
		const { world } = aw.fake;
		expect(world.countStarts).toBe(1);
		expect(world.countEnds).toBe(1);
		expect(world.counting).toBe(false);
	};

	it('starts in the promote step, after the copy loads and before the address moves', async () => {
		const aw = await setup();
		await run(aw);
		const { calls } = aw.fake.world;
		const at = (name: string) => calls.indexOf(name);
		expect(at('promote')).toBeGreaterThan(-1);
		expect(at('startCounting')).toBe(at('promote') + 1);
		expect(at('route')).toBeGreaterThan(at('startCounting'));
		expect((await operationOf(aw)).steps.find((step) => step.id === 'promote')?.state).toBe(
			'succeeded'
		);
	});

	it('names one mark for the whole move', async () => {
		const aw = await setup();
		await run(aw, { waits: decisions({ kind: 'rollback' }) });
		for (const key of aw.fake.world.countKeys) {
			expect(key.startsWith(`${aw.input.operationId}:`)).toBe(true);
		}
		expect(new Set(aw.fake.world.countKeys).size).toBe(1);
	});

	it('starts once when the promote step dies and replays', async () => {
		const reference = (await run(await setup())).executed;
		const at = reference.findIndex((name) => name.startsWith('promote.'));
		const aw = await setup();
		const memo: Memo = new Map();
		await expect(run(aw, { memo, script: { killDuring: at + 1 } })).rejects.toBeInstanceOf(
			Killed
		);
		const { outcome } = await run(aw, { memo });
		expect(outcome).toEqual({ status: 'succeeded' });
		ended(aw);
	});

	it('skips the separate start when the new site opened the count with the copy', async () => {
		const aw = await setup({ opensCount: true });
		const { outcome } = await run(aw, { waits: decisions({ kind: 'rollback' }) });
		expect(outcome.status).toBe('rolled-back');
		const { world } = aw.fake;
		expect(world.calls).not.toContain('startCounting');
		expect(world.countStarts).toBe(0);
		expect(world.countOpenedWithCopy).toBe(1);
		expect(world.countEnds).toBe(1);
		expect(world.counting).toBe(false);
	});

	it('starts it separately when the copy did not open it', async () => {
		const aw = await setup({ opensCount: false });
		await run(aw, { waits: decisions({ kind: 'rollback' }) });
		const { world } = aw.fake;
		expect(world.countStarts).toBe(1);
		expect(world.countOpenedWithCopy).toBe(0);
	});

	it('opens the count once when the promote step dies and replays, with no second start', async () => {
		const reference = (await run(await setup({ opensCount: true }))).executed;
		const at = reference.findIndex((name) => name.startsWith('promote.'));
		for (const script of [{ killDuring: at + 1 }, { killAfter: at + 1 }]) {
			const aw = await setup({ opensCount: true });
			const memo: Memo = new Map();
			await expect(run(aw, { memo, script })).rejects.toBeInstanceOf(Killed);
			const { outcome } = await run(aw, { memo });
			expect(outcome).toEqual({ status: 'succeeded' });
			expect(aw.fake.world.countOpenedWithCopy).toBe(1);
			expect(aw.fake.world.countStarts).toBe(0);
			expect(countOf(aw, 'promote')).toBe(1);
		}
	});

	it('fails the promote step and does not route when the count cannot start', async () => {
		const aw = await setup({ fail: { startCounting: 99 } });
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('rolled-back');
		const { world } = aw.fake;
		expect(world.calls).not.toContain('route');
		expect(world.routedTo).toBe('source');
		expect(world.policy).toBeNull();
		expect(world.counting).toBe(false);
		expect((await operationOf(aw)).steps.find((step) => step.id === 'promote')?.state).toBe(
			'failed'
		);
	});

	it('is read at each observation and rises across them', async () => {
		const aw = await setup({
			observations: [
				{ healthy: true, writes: 0 },
				{ healthy: true, writes: 3 },
				{ healthy: true, writes: 3 },
				{ healthy: true, writes: 8 }
			]
		});
		await run(aw);
		const state = await stateOf(aw);
		expect(state.destinationWrites).toBe(8);
		expect(state.state).toBe('completed');
	});

	it('ends when the move completes', async () => {
		const aw = await setup();
		await run(aw);
		ended(aw);
	});

	it('ends when the owner goes back before any write', async () => {
		const aw = await setup();
		await run(aw, { waits: decisions({ kind: 'rollback' }) });
		ended(aw);
	});

	it('ends after the owner abandons the new data', async () => {
		const aw = await setup();
		await run(aw, { waits: choice('abandon-new-data', 4)(aw) });
		ended(aw);
	});

	it('ends after the export, never before it', async () => {
		const aw = await setup();
		await run(aw, { waits: choice('export-changes', 5)(aw) });
		ended(aw);
		const { calls } = aw.fake.world;
		expect(calls.indexOf('exportChanges')).toBeGreaterThan(-1);
		expect(calls.indexOf('stopCounting')).toBeGreaterThan(calls.indexOf('exportChanges'));
	});

	it('ends when the owner keeps the new site and the observations finish', async () => {
		const aw = await setup();
		await run(aw, { waits: choice('keep-new', 2)(aw) });
		ended(aw);
	});

	it('ends when the last check cannot be read', async () => {
		const aw = await setup({
			observations: [{ healthy: true }, { healthy: true }, { healthy: true }, 'throw']
		});
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('failed');
		ended(aw);
	});

	it('ends when no choice is made in time', async () => {
		const aw = await setup({
			observations: [
				{ healthy: true },
				{ healthy: true },
				{ healthy: true },
				{ healthy: false, writes: 1 }
			]
		});
		const { outcome } = await run(aw);
		expect(outcome.status).toBe('failed');
		ended(aw);
	});

	it('ends when the route step fails and the move goes back', async () => {
		const aw = await setup({ fail: { route: 1 } });
		const { outcome } = await run(aw, { script: { retries: 0 } });
		expect(outcome.status).toBe('rolled-back');
		ended(aw);
	});

	it('is never started or ended for a move that stops before the promote', async () => {
		const aw = await setup({ fail: { snapshot: 99 } });
		await run(aw);
		expect(aw.fake.world.calls).not.toContain('startCounting');
		expect(aw.fake.world.calls).not.toContain('stopCounting');
	});

	it('leaves the outcome as it was when the count will not end, and says so', async () => {
		const aw = await setup({ fail: { stopCounting: 99 } });
		const { outcome } = await run(aw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect((await operationOf(aw)).finalObservation?.summary).toContain('still counting');
		const stuck = await setup({
			fail: { stopCounting: 99 },
			observations: [{ healthy: true }, { healthy: true }, { healthy: true }, 'throw']
		});
		expect((await run(stuck)).outcome).toMatchObject({ status: 'failed', leaked: ['count'] });
	});
});
