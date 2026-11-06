import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CHANGE_BUDGET,
	OPERATION_STATUSES,
	STEP_STATES,
	type Operation
} from '../../../contracts/src/operations';
import {
	assertPlanMatches,
	bindEpoch,
	blastRadiusFor,
	buildPlan,
	bulkDeleteConfirmation,
	checkBudget,
	failStep,
	freezePlan,
	newOperation,
	OPERATION_ERROR_CODES,
	OperationError,
	resolveIdempotent,
	setVerification,
	skipPending,
	STATUS_TRANSITIONS,
	STEP_TRANSITIONS,
	transition,
	transitionStep,
	type ChangeBudget,
	type OperationErrorCode
} from '../../../engine/src/operations/state';
import { D1OperationStore, StaleWriteError } from '../../../engine/src/operations/store';
import { memoryD1 } from './fakes';

const NOW = 1_790_000_000_000;
const orgId = `org_${'o'.repeat(26)}`;
const site = (n: number) => `site_${String(n).padStart(26, 's')}`;

function planOf(
	type: Parameters<typeof buildPlan>[0]['type'] = 'site.create',
	targets = [site(1)]
) {
	return buildPlan({
		type,
		targetIds: targets,
		preconditions: ['a precondition'],
		steps: [
			{ id: 'one', name: 'First' },
			{ id: 'two', name: 'Second' }
		]
	});
}

async function operationOf(key = 'key-1', targets = [site(1)]) {
	const frozen = await freezePlan(planOf('site.create', targets));
	return newOperation({
		id: `op_${key
			.replace(/[^a-z0-9]/g, '')
			.padEnd(26, 'x')
			.slice(0, 26)}`,
		orgId,
		idempotencyKey: key,
		frozen,
		now: NOW
	});
}

const seen = new Set<OperationErrorCode>();

function refusal(action: () => unknown): OperationErrorCode {
	try {
		action();
	} catch (error) {
		if (error instanceof OperationError) {
			seen.add(error.code);
			return error.code;
		}
		throw error;
	}
	throw new Error('expected a refusal');
}

async function rejected(promise: Promise<unknown>): Promise<OperationErrorCode> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof OperationError) {
			seen.add(error.code);
			return error.code;
		}
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('plans', () => {
	it('computes the blast radius from the type and the targets', () => {
		expect(blastRadiusFor('site.delete', [site(1), site(2), site(1)])).toEqual({
			sites: 2,
			destructiveSites: 2,
			productionDeploys: 0
		});
		expect(blastRadiusFor('site.create', [site(1)])).toEqual({
			sites: 1,
			destructiveSites: 0,
			productionDeploys: 1
		});
		expect(blastRadiusFor('backup.verify', [site(1)])).toEqual({
			sites: 1,
			destructiveSites: 0,
			productionDeploys: 0
		});
	});

	it('freezes a plan with a stable digest and an unbound epoch', async () => {
		const a = await freezePlan(planOf());
		const b = await freezePlan(planOf());
		expect(a.planDigest).toBe(b.planDigest);
		expect(a.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(a.fencingEpoch).toBe(0);
		expect(Object.isFrozen(a.plan)).toBe(true);
		expect(Object.isFrozen(a.plan.steps[0])).toBe(true);
		expect(() => (a.plan.steps as unknown[]).push({})).toThrow(TypeError);
	});

	it('gives a different digest for a different plan', async () => {
		const a = await freezePlan(planOf());
		const b = await freezePlan(planOf('site.create', [site(2)]));
		expect(a.planDigest).not.toBe(b.planDigest);
	});

	it('refuses a plan that is not the one the operation froze', async () => {
		const operation = await operationOf();
		await assertPlanMatches(operation, planOf());
		expect(await rejected(assertPlanMatches(operation, planOf('site.create', [site(2)])))).toBe(
			'plan_mismatch'
		);
	});

	it('starts an operation planned, with every step pending and the default budget', async () => {
		const operation = await operationOf();
		expect(operation.status).toBe('planned');
		expect(operation.steps.map((step) => [step.id, step.state, step.attempt])).toEqual([
			['one', 'pending', 0],
			['two', 'pending', 0]
		]);
		expect(operation.budget).toEqual(DEFAULT_CHANGE_BUDGET);
		expect(operation.verification).toBe('pending');
	});
});

describe('idempotency', () => {
	it('treats the same key and plan as the same operation and a new plan as a conflict', async () => {
		const operation = await operationOf();
		expect(resolveIdempotent(null, operation.planDigest)).toBe('create');
		expect(resolveIdempotent(operation, operation.planDigest)).toBe('same');
		expect(refusal(() => resolveIdempotent(operation, 'sha256:' + '1'.repeat(64)))).toBe(
			'idempotency_conflict'
		);
	});
});

describe('status transitions', () => {
	it('allows exactly the listed moves and refuses every other', async () => {
		const base = await operationOf();
		for (const from of OPERATION_STATUSES) {
			for (const to of OPERATION_STATUSES) {
				const operation = { ...base, status: from, verification: 'passed' as const };
				const allowed = STATUS_TRANSITIONS[from].includes(to);
				if (allowed) expect(transition(operation, to, NOW).status).toBe(to);
				else
					expect(refusal(() => transition(operation, to, NOW))).toBe(
						'illegal_transition'
					);
			}
		}
	});

	it('refuses success while verification is pending or failed', async () => {
		const base = await operationOf();
		for (const verification of ['pending', 'failed'] as const) {
			const operation = { ...base, status: 'verifying' as const, verification };
			expect(refusal(() => transition(operation, 'succeeded', NOW))).toBe(
				'verification_required'
			);
		}
		const done = setVerification({ ...base, status: 'verifying' }, 'passed', NOW);
		expect(transition(done, 'succeeded', NOW).status).toBe('succeeded');
	});

	it('makes every change a new version, even inside one millisecond', async () => {
		let operation = await operationOf();
		const seen = new Set([operation.updatedAt]);
		for (let i = 0; i < 5; i++) {
			operation = setVerification(operation, i % 2 ? 'passed' : 'pending', NOW);
			seen.add(operation.updatedAt);
		}
		expect(seen.size).toBe(6);
	});
});

describe('step transitions', () => {
	it('allows exactly the listed moves while the operation runs', async () => {
		const base = { ...(await operationOf()), status: 'running' as const };
		for (const from of STEP_STATES) {
			for (const to of STEP_STATES) {
				const operation = {
					...base,
					steps: base.steps.map((step) =>
						step.id === 'one' ? { ...step, state: from } : step
					)
				};
				const allowed = STEP_TRANSITIONS[from].includes(to);
				const attempt = () => transitionStep(operation, 'one', to, NOW, 'an error');
				if (allowed) expect(attempt().steps[0]?.state).toBe(to);
				else expect(refusal(attempt)).toBe('illegal_step_transition');
			}
		}
	});

	it('counts an attempt each time a step starts, including a restart after a crash', async () => {
		let operation: Operation = { ...(await operationOf()), status: 'running' };
		operation = transitionStep(operation, 'one', 'running', NOW);
		operation = transitionStep(operation, 'one', 'running', NOW + 1);
		expect(operation.steps[0]?.attempt).toBe(2);
		operation = transitionStep(operation, 'one', 'succeeded', NOW + 2);
		expect(operation.steps[0]).toMatchObject({ state: 'succeeded', error: null });
		expect(refusal(() => transitionStep(operation, 'one', 'running', NOW + 3))).toBe(
			'illegal_step_transition'
		);
	});

	it('refuses to start a step while the operation is not running, and to fail one without a reason', async () => {
		const planned = await operationOf();
		expect(refusal(() => transitionStep(planned, 'one', 'running', NOW))).toBe(
			'illegal_step_transition'
		);
		const running = { ...planned, status: 'running' as const };
		const started = transitionStep(running, 'one', 'running', NOW);
		expect(refusal(() => transitionStep(started, 'one', 'failed', NOW))).toBe(
			'illegal_step_transition'
		);
	});

	it('refuses an unknown step', async () => {
		const running = { ...(await operationOf()), status: 'running' as const };
		expect(refusal(() => transitionStep(running, 'nope', 'running', NOW))).toBe('unknown_step');
	});

	it('marks the step a workflow step belongs to as failed, even one that never started', async () => {
		const running = { ...(await operationOf()), status: 'running' as const };
		const failed = failStep(running, 'two', 'it broke', NOW);
		expect(failed.steps[1]).toMatchObject({ state: 'failed', error: 'it broke', attempt: 1 });
		const grouped = {
			...running,
			steps: [
				...running.steps,
				{ ...running.steps[0]!, id: 'assets', state: 'running' as const }
			]
		};
		expect(failStep(grouped, 'assets.upload.3', 'x', NOW).steps[2]?.state).toBe('failed');
		expect(failStep(running, 'unrelated', 'x', NOW)).toBe(running);
	});

	it('skips what is still pending', async () => {
		const running = { ...(await operationOf()), status: 'running' as const };
		const started = transitionStep(running, 'one', 'running', NOW);
		const skipped = skipPending(started, NOW);
		expect(skipped.steps.map((step) => step.state)).toEqual(['running', 'skipped']);
		expect(skipPending(skipped, NOW)).toBe(skipped);
	});
});

describe('the fencing epoch', () => {
	it('binds once and refuses a different epoch afterwards', async () => {
		const operation = await operationOf();
		const bound = bindEpoch(operation, 3, NOW);
		expect(bound.fencingEpoch).toBe(3);
		expect(bindEpoch(bound, 3, NOW)).toBe(bound);
		expect(refusal(() => bindEpoch(bound, 4, NOW))).toBe('epoch_mismatch');
	});
});

describe('change budgets', () => {
	const blast = (destructiveSites: number, productionDeploys = 0) => ({
		sites: destructiveSites,
		destructiveSites,
		productionDeploys
	});
	const budget = (patch: Partial<ChangeBudget>): ChangeBudget => ({
		...DEFAULT_CHANGE_BUDGET,
		...patch
	});

	it('allows five destructive sites with their typed confirmation and refuses the sixth', () => {
		expect(() =>
			checkBudget(blast(5), budget({ bulkDeleteConfirmation: bulkDeleteConfirmation(5) }), 0)
		).not.toThrow();
		expect(
			refusal(() =>
				checkBudget(
					blast(6),
					budget({ bulkDeleteConfirmation: bulkDeleteConfirmation(6) }),
					0
				)
			)
		).toBe('destructive_budget');
	});

	it('lifts the cap when elevated but still wants the typed confirmation', () => {
		expect(() =>
			checkBudget(
				blast(6),
				budget({ elevated: true, bulkDeleteConfirmation: bulkDeleteConfirmation(6) }),
				0
			)
		).not.toThrow();
		expect(refusal(() => checkBudget(blast(6), budget({ elevated: true }), 0))).toBe(
			'confirmation_required'
		);
	});

	it('wants the typed confirmation for any bulk delete and none for a single site', () => {
		expect(refusal(() => checkBudget(blast(2), budget({}), 0))).toBe('confirmation_required');
		expect(
			refusal(() =>
				checkBudget(blast(2), budget({ bulkDeleteConfirmation: 'delete 3 sites' }), 0)
			)
		).toBe('confirmation_required');
		expect(() => checkBudget(blast(1), budget({}), 0)).not.toThrow();
	});

	it('allows ten concurrent production deploys and refuses the eleventh, elevated or not', () => {
		expect(() => checkBudget(blast(0, 1), budget({}), 9)).not.toThrow();
		expect(refusal(() => checkBudget(blast(0, 1), budget({}), 10))).toBe('deploy_budget');
		expect(refusal(() => checkBudget(blast(0, 1), budget({ elevated: true }), 10))).toBe(
			'deploy_budget'
		);
	});
});

describe('the operation store', () => {
	async function fresh() {
		const { db } = memoryD1();
		return new D1OperationStore(db);
	}

	const record = (operation: Awaited<ReturnType<typeof operationOf>>, accountId = 'acct') => ({
		operation,
		accountId,
		siteId: operation.targetIds[0] ?? null
	});

	it('returns one operation for one key, however many times and however concurrently it is asked', async () => {
		const store = await fresh();
		const operation = await operationOf();
		const [a, b, c] = await Promise.all([
			store.begin(record(operation)),
			store.begin(record(operation)),
			store.begin(record(operation))
		]);
		expect([a, b, c].filter((result) => result.created)).toHaveLength(1);
		expect(new Set([a, b, c].map((result) => result.operation.id)).size).toBe(1);
		const again = await store.begin(record(operation));
		expect(again.created).toBe(false);
		expect(again.operation.id).toBe(operation.id);
		expect(again.operation.steps).toHaveLength(2);
	});

	it('refuses the same key with another plan', async () => {
		const store = await fresh();
		await store.begin(record(await operationOf('key-1', [site(1)])));
		const other = await operationOf('key-1', [site(2)]);
		const different = { ...other, id: `op_${'z'.repeat(26)}` as typeof other.id };
		expect(await rejected(store.begin(record(different)))).toBe('idempotency_conflict');
	});

	it('round-trips an operation through the tables', async () => {
		const store = await fresh();
		const operation = await operationOf();
		await store.begin(record(operation));
		expect(await store.get(operation.id)).toEqual(operation);
		expect(await store.findByKey(orgId, 'key-1')).toEqual(operation);
		expect(await store.get(`op_${'q'.repeat(26)}`)).toBeNull();
		expect(await store.findByKey(orgId, 'other')).toBeNull();
	});

	it('lets the first writer win and refuses a writer working from an old copy', async () => {
		const store = await fresh();
		const operation = await operationOf();
		await store.begin(record(operation));
		const first = await store.get(operation.id);
		const second = await store.get(operation.id);
		await store.save(first!, transition(first!, 'running', NOW + 10));
		expect(
			await rejected(store.save(second!, transition(second!, 'cancelled', NOW + 10)))
		).toBe('stale_write');
		expect((await store.get(operation.id))?.status).toBe('running');
	});

	it('does not apply a stale writer step changes either', async () => {
		const store = await fresh();
		const operation = await operationOf();
		await store.begin(record(operation));
		const first = (await store.get(operation.id))!;
		const second = (await store.get(operation.id))!;
		const running = transition(first, 'running', NOW + 1);
		await store.save(first, running);
		const staleNext = transitionStep(
			transition(second, 'running', NOW + 1),
			'one',
			'running',
			NOW + 1
		);
		expect(await rejected(store.save(second, staleNext))).toBe('stale_write');
		expect((await store.get(operation.id))?.steps[0]?.state).toBe('pending');
	});

	it('refuses to change what the plan froze', async () => {
		const store = await fresh();
		const operation = await operationOf();
		await store.begin(record(operation));
		const current = (await store.get(operation.id))!;
		expect(await rejected(store.save(current, { ...current, targetIds: [site(9)] }))).toBe(
			'plan_frozen'
		);
		expect(
			await rejected(store.save(current, { ...current, steps: current.steps.slice(1) }))
		).toBe('plan_frozen');
	});

	it('mutates through a fresh read and reports a missing operation', async () => {
		const store = await fresh();
		const operation = await operationOf();
		await store.begin(record(operation));
		const next = await store.mutate(operation.id, (current) =>
			transition(current, 'running', NOW)
		);
		expect(next.status).toBe('running');
		const same = await store.mutate(operation.id, (current) => current);
		expect(same.status).toBe('running');
		expect(await rejected(store.mutate(`op_${'q'.repeat(26)}`, (current) => current))).toBe(
			'not_found'
		);
	});

	it('counts the production deploys other open operations in an account hold', async () => {
		const store = await fresh();
		const a = await operationOf('a', [site(1)]);
		const b = await operationOf('b', [site(2)]);
		const c = await operationOf('c', [site(3)]);
		await store.begin(record(a, 'acct-1'));
		await store.begin(record(b, 'acct-1'));
		await store.begin(record(c, 'acct-2'));
		expect(await store.runningProductionDeploys('acct-1', c.id)).toBe(0);
		for (const op of [a, b, c])
			await store.mutate(op.id, (cur) => transition(cur, 'running', NOW));
		expect(await store.runningProductionDeploys('acct-1', 'op_none')).toBe(2);
		expect(await store.runningProductionDeploys('acct-1', a.id)).toBe(1);
		expect(await store.runningProductionDeploys('acct-2', 'op_none')).toBe(1);
	});

	it('records a resource once per binding and lists live and all rows', async () => {
		const store = await fresh();
		const resource = {
			siteId: site(1),
			accountId: 'acct',
			kind: 'kv' as const,
			binding: 'CONFIG_KV',
			name: 's-config',
			providerId: 'kv-1',
			createdByOperation: 'op_a'
		};
		const first = await store.recordResource(resource, NOW);
		const second = await store.recordResource({ ...resource, providerId: 'kv-2' }, NOW + 1);
		expect(second.id).toBe(first.id);
		expect(await store.liveResources(site(1))).toHaveLength(1);
		await store.markResourceDeleted(first.id, NOW + 2);
		await store.markResourceDeleted(first.id, NOW + 3);
		expect(await store.liveResources(site(1))).toHaveLength(0);
		const all = await store.allResources(site(1));
		expect(all).toHaveLength(1);
		expect(all[0]?.deletedAt).toBe(NOW + 2);
	});

	it('shares its version check with the dashboard: each save bumps it and a bumped row refuses an old copy', async () => {
		const { db, sqlite } = memoryD1();
		const store = new D1OperationStore(db);
		const operation = await operationOf();
		await store.begin(record(operation));
		const versionOf = () =>
			(
				sqlite.prepare('SELECT version FROM operations WHERE id = ?').get(operation.id) as {
					version: number;
				}
			).version;
		expect(versionOf()).toBe(0);

		const first = (await store.get(operation.id))!;
		const running = await store.save(first, transition(first, 'running', NOW + 1));
		expect(versionOf()).toBe(1);
		// a copy a save returned can be saved again without a read in between
		await store.save(running, transition(running, 'verifying', NOW + 2));
		expect(versionOf()).toBe(2);

		// the dashboard writes the row with its own version bump, even inside one millisecond
		const old = (await store.get(operation.id))!;
		sqlite
			.prepare('UPDATE operations SET version = version + 1 WHERE id = ?')
			.run(operation.id);
		expect(await rejected(store.save(old, transition(old, 'failed', NOW + 3)))).toBe(
			'stale_write'
		);
		expect((await store.get(operation.id))?.status).toBe('verifying');
	});

	it('sets ready_at when it activates a row the dashboard wrote, once, and keeps the rest of the row', async () => {
		const { db, sqlite } = memoryD1();
		const store = new D1OperationStore(db);
		sqlite
			.prepare(
				`INSERT INTO sites (id, organization_id, name, kind, category, plane, config, state,
				primary_hostname, ready_at, created_at, updated_at)
				VALUES (?, ?, 'One', 'smoke', 'workers', 'managed', 'managed', 'active',
				'one.drupflare.app', NULL, 1, 1)`
			)
			.run(site(1), orgId);
		const read = () =>
			sqlite
				.prepare('SELECT kind, primary_hostname, ready_at, state FROM sites WHERE id = ?')
				.get(site(1));
		expect(read()).toMatchObject({ ready_at: null });
		const activate = {
			id: site(1),
			organizationId: orgId,
			name: 'One',
			plane: 'managed',
			accountId: 'a'.repeat(32),
			category: 'workers' as const,
			config: 'managed' as const
		};
		await store.activateSite(activate, NOW);
		await store.activateSite(activate, NOW + 5);
		expect(read()).toEqual({
			kind: 'smoke',
			primary_hostname: 'one.drupflare.app',
			ready_at: NOW,
			state: 'active'
		});
	});

	it('activates a site, moves its state and reads it back', async () => {
		const store = await fresh();
		const record = {
			id: site(1),
			organizationId: orgId,
			name: 'One',
			plane: 'managed',
			accountId: 'a'.repeat(32),
			category: 'cms' as const,
			config: 'managed' as const
		};
		expect(await store.siteState(site(1))).toBeNull();
		await store.activateSite(record, NOW);
		await store.activateSite(record, NOW + 1);
		expect(await store.siteState(site(1))).toBe('active');
		await store.setSiteState(site(1), 'tombstoned', NOW + 2);
		expect(await store.siteState(site(1))).toBe('tombstoned');
		await store.setSiteState(site(2), 'deleted', NOW);
		expect(await store.siteState(site(2))).toBeNull();
	});
});

describe('typed errors', () => {
	it('has tripped every code the engine can raise by the time the file reaches here', () => {
		expect([...seen].sort()).toEqual([...OPERATION_ERROR_CODES].sort());
	});

	it('is the error the store raises for a lost write', () => {
		expect(new StaleWriteError('op_a')).toBeInstanceOf(OperationError);
		expect(new StaleWriteError('op_a').code).toBe('stale_write');
	});
});
