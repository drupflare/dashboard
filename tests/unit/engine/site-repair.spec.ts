import { describe, expect, it, vi } from 'vitest';
import { isAutomatic, REPAIR_HANDLES, type RepairRun } from '../../../engine/src/repair/handles';
import { planSiteRepair } from '../../../engine/src/workflows/site-repair';
import { DEFAULT_REPAIR_BUDGET } from '../../../src/server/domain/incidents';
import type { LadderOutcome } from '../../../src/server/domain/ladder';
import {
	historyOf,
	TICK_MS,
	tickLadder,
	type LadderTickDeps,
	type SiteReading
} from '../../../src/server/services/ladder-tick';
import { CATALOGUE, CATALOGUE_ROWS, type CatalogueRow } from '../../../src/shared/health/catalogue';
import { BREAKER_WINDOW_MS } from '../../../src/shared/health/vocab';
import { inputOf, parsed, repairWorld, runRepair, type Rw } from './repair-fakes';

const VERIFIED = CATALOGUE_ROWS.filter(
	(row) => isAutomatic(row) && REPAIR_HANDLES[row.repairId]!.verified
);
const NEEDS_A_PERSON = CATALOGUE_ROWS.filter((row) => !isAutomatic(row));

// puts the failure a row names on the fake site
function inject(rw: Rw, row: CatalogueRow) {
	if (row.handle === 'reconcile') rw.site.state.owed = 3;
	else if (row.handle === '/armfill') rw.site.state.queued = 2;
	else if (row.source !== 'control plane') rw.site.state.findings.add(row.repairId);
}

const refusedCode = (rw: Rw) => parsed(rw.records().at(-1)!.observation_before).refused?.code;

describe('the plan', () => {
	it('plans one site and six steps', () => {
		const plan = planSiteRepair({ siteId: 'site_a' });
		expect(plan.type).toBe('site.repair');
		expect(plan.targetIds).toEqual(['site_a']);
		expect(plan.steps.map((step) => step.id)).toEqual([
			'lease',
			'find',
			'observe',
			'check',
			'repair',
			'confirm'
		]);
	});
});

describe('a catalogued failure on a site', () => {
	it('has a verified handler for every automatic row whose route the worker serves', () => {
		expect(VERIFIED.map((row) => row.repairId).sort()).toEqual([
			'bridge.asyncify_called',
			'bridge.mask_leaked',
			'cache.anonymous_purity',
			'health.ledger_oversized',
			'memory.highwater_rising',
			'memory.trend_rising',
			'overhead.cache-invalidation-after-deploy',
			'overhead.fill-rearm-after-gap',
			'overhead.reconcile-after-release',
			'pack.generation_mismatch',
			'reconcile',
			'render.empty',
			'render.size_anomaly'
		]);
	});

	it('records what /ledger-gc deleted and what /recycle found', async () => {
		const gc = await repairWorld();
		gc.site.state.findings.add('health.ledger_oversized');
		await runRepair(gc, inputOf(gc, 'health.ledger_oversized'));
		expect(parsed(gc.records()[0]!.observation_after).run.detail).toBe(
			'/ledger-gc deleted 7 rows'
		);
		const idle = await repairWorld();
		idle.site.state.fixes = false;
		idle.site.state.findings.add('memory.trend_rising');
		const { outcome } = await runRepair(idle, inputOf(idle, 'memory.trend_rising'));
		expect(outcome.status).toBe('failed');
		expect(parsed(idle.records()[0]!.observation_after).run.detail).toBe(
			'/recycle found no interpreter resident'
		);
	});

	it.each(VERIFIED.map((row) => [row.repairId, row] as const))(
		'repairs %s and reads the site healthy afterwards',
		async (_id, row) => {
			const rw = await repairWorld();
			inject(rw, row);
			const { outcome, operation } = await runRepair(rw, inputOf(rw, row.repairId));
			expect(outcome).toEqual({ status: 'succeeded' });
			expect(operation.status).toBe('succeeded');
			expect(operation.steps.map((step) => step.state)).toEqual(Array(6).fill('succeeded'));
			const [record] = rw.records();
			expect(record).toMatchObject({
				repair_id: row.repairId,
				status: 'succeeded',
				rung: 'observe'
			});
			const after = parsed(record!.observation_after);
			expect(after.predicate).toEqual({ id: row.successPredicate, cleared: true });
			expect(after.reading.findings).not.toContain(row.repairId);
			expect(rw.site.state.calls.length).toBeGreaterThan(0);
			expect(
				rw.site.state.calls.every(
					(call) => call.path === row.handle || call.path === '/reconcile'
				)
			).toBe(true);
		}
	);

	it('records what the site showed before the repair', async () => {
		const rw = await repairWorld();
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.empty'));
		const before = parsed(rw.records()[0]!.observation_before);
		expect(before.reading.findings).toEqual(['render.empty']);
	});

	it('ends failed and escalates as the row says when the handler fixes nothing', async () => {
		const rw = await repairWorld();
		rw.site.state.findings.add('render.empty');
		rw.site.state.fixes = false;
		const { outcome, operation } = await runRepair(rw, inputOf(rw, 'render.empty'));
		expect(outcome.status).toBe('failed');
		expect(operation.status).toBe('failed');
		expect(operation.verification).toBe('failed');
		const record = rw.records()[0]!;
		expect(record.status).toBe('failed');
		const after = parsed(record.observation_after);
		expect(after.predicate.cleared).toBe(false);
		expect(after.escalation).toBe(CATALOGUE.get('render.empty')!.escalation);
		expect(after.escalated).toBe(false);
	});

	it.each(VERIFIED.map((row) => [row.repairId, row] as const))(
		'ends %s failed when the route changes nothing',
		async (_id, row) => {
			const rw = await repairWorld();
			inject(rw, row);
			rw.site.state.fixes = false;
			const { outcome } = await runRepair(rw, inputOf(rw, row.repairId));
			expect(outcome.status).toBe('failed');
			expect(rw.records()[0]!.status).toBe('failed');
		}
	);

	it('fails the run with no repair row when the id has no catalogue row', async () => {
		const rw = await repairWorld();
		const { outcome } = await runRepair(rw, inputOf(rw, 'not.a.row'));
		expect(outcome).toMatchObject({ status: 'failed' });
		expect((outcome as { reason: string }).reason).toContain('no catalogue row');
		expect(rw.records()).toEqual([]);
		expect(rw.site.state.calls).toEqual([]);
	});
});

describe('a repair that must not run', () => {
	const refuses = async (rw: Rw, code: string, repairId = 'render.empty') => {
		rw.site.state.findings.add(repairId);
		const { outcome, operation } = await runRepair(rw, inputOf(rw, repairId));
		expect(outcome.status).toBe('cancelled');
		expect(operation.status).toBe('cancelled');
		expect(rw.records().at(-1)!.status).toBe('refused');
		expect(refusedCode(rw)).toBe(code);
		expect(rw.site.state.calls).toEqual([]);
	};

	it('does not call the handler while the site is shedding load', async () => {
		const rw = await repairWorld();
		rw.site.state.shedding = true;
		await refuses(rw, 'precondition');
		expect(parsed(rw.records()[0]!.observation_before).refused.reason).toBe(
			'not shedding load'
		);
	});

	it('does not call the handler with a transaction open', async () => {
		const rw = await repairWorld();
		rw.site.state.transactionDepth = 1;
		await refuses(rw, 'precondition');
	});

	it('does not call the handler when the site does not say whether a transaction is open', async () => {
		const rw = await repairWorld();
		rw.site.state.transactionDepth = undefined;
		await refuses(rw, 'precondition');
	});

	it('does not call the handler when the lease check fails', async () => {
		const rw = await repairWorld();
		rw.deps.leases = { ...rw.deps.leases, check: async () => ({ ok: false, code: 'held' }) };
		await refuses(rw, 'precondition');
		expect(parsed(rw.records()[0]!.observation_before).refused.reason).toBe('site lease held');
	});

	it('does not run at all while another operation holds the site', async () => {
		const rw = await repairWorld();
		await rw.deps.leases.acquire(rw.siteId, {
			holder: 'op_other',
			purpose: 'x',
			ttlMs: 600_000
		});
		rw.site.state.findings.add('render.empty');
		const { outcome } = await runRepair(rw, inputOf(rw, 'render.empty'));
		expect(outcome.status).toBe('failed');
		expect(rw.records()).toEqual([]);
		expect(rw.site.state.calls).toEqual([]);
		expect(rw.site.state.reads).toBe(0);
	});

	it('does not call a reconcile handler during a ring promotion', async () => {
		const rw = await repairWorld({ ring: true });
		rw.site.state.owed = 2;
		await refuses(rw, 'precondition', 'reconcile');
	});

	it('does not call the handler on a quarantined site', async () => {
		const rw = await repairWorld();
		rw.site.state.quarantined = true;
		await refuses(rw, 'quarantined');
	});

	it.each(NEEDS_A_PERSON.map((row) => [row.repairId, row] as const))(
		'refuses %s, which needs approval or a person',
		async (id) => {
			const rw = await repairWorld();
			await refuses(rw, 'no_handler', id);
		}
	);

	it('refuses an automatic row whose handle has no owner route on the site', async () => {
		const rw = await repairWorld();
		const row: CatalogueRow = { ...CATALOGUE.get('render.empty')!, repairId: 'test.unrouted' };
		const registries = {
			catalogue: new Map([...CATALOGUE, [row.repairId, row]]),
			handles: {
				...REPAIR_HANDLES,
				[row.repairId]: { verified: false, run: async () => ({ ok: false, detail: '' }) }
			},
			undo: {}
		};
		const { outcome } = await runRepair(rw, inputOf(rw, row.repairId), { registries });
		expect(outcome.status).toBe('cancelled');
		expect(refusedCode(rw)).toBe('no_route');
		expect(rw.site.state.calls).toEqual([]);
	});
});

describe('the switches and the budget', () => {
	it('starts an automatic repair only when the global switch is on', async () => {
		const rw = await repairWorld();
		rw.site.state.findings.add('render.empty');
		const off = await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'auto' }));
		expect(off.outcome.status).toBe('cancelled');
		expect(refusedCode(rw)).toBe('auto_off');
		rw.setSwitch('global', '', true);
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const on = await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'auto' }));
		expect(on.outcome).toEqual({ status: 'succeeded' });
	});

	it('refuses an automatic repair when the organisation or the site is switched off', async () => {
		const rw = await repairWorld();
		rw.setSwitch('global', '', true);
		rw.setSwitch('organization', rw.world.orgId, false);
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'auto' }));
		expect(refusedCode(rw)).toBe('auto_off');
		rw.setSwitch('organization', rw.world.orgId, true);
		rw.setSwitch('site', rw.siteId, false);
		await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'auto' }));
		expect(refusedCode(rw)).toBe('auto_off');
	});

	it('lets an operator run a repair with every switch off', async () => {
		const rw = await repairWorld();
		rw.setSwitch('global', '', false);
		rw.site.state.findings.add('render.empty');
		const { outcome } = await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'manual' }));
		expect(outcome).toEqual({ status: 'succeeded' });
	});

	it('refuses an automatic repair once the organisation spent its hourly budget', async () => {
		const rw = await repairWorld();
		rw.setSwitch('global', '', true);
		rw.deps.budget = { perOrgPerHour: 1, fleetPerHour: 300 };
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.size_anomaly', { trigger: 'auto' }));
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		await runRepair(rw, inputOf(rw, 'render.empty', { trigger: 'auto' }));
		expect(refusedCode(rw)).toBe('budget');
	});
});

describe('the attempt bound and the cool-down', () => {
	it('waits out the cool-down before the same repair runs again', async () => {
		const rw = await repairWorld();
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.empty'));
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.empty'));
		expect(refusedCode(rw)).toBe('cooling_down');
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const again = await runRepair(rw, inputOf(rw, 'render.empty'));
		expect(again.outcome).toEqual({ status: 'succeeded' });
	});

	it('stops after the attempt bound and marks the last failure as escalated', async () => {
		const rw = await repairWorld();
		rw.site.state.fixes = false;
		rw.site.state.findings.add('render.empty');
		const bound = CATALOGUE.get('render.empty')!.attemptBound;
		for (let attempt = 1; attempt <= bound; attempt++) {
			const { outcome } = await runRepair(rw, inputOf(rw, 'render.empty'));
			expect(outcome.status).toBe('failed');
			expect(parsed(rw.records().at(-1)!.observation_after).escalated).toBe(
				attempt === bound
			);
			rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		}
		const callsBefore = rw.site.state.calls.length;
		const { outcome } = await runRepair(rw, inputOf(rw, 'render.empty'));
		expect(outcome.status).toBe('cancelled');
		expect(refusedCode(rw)).toBe('attempts');
		expect(rw.site.state.calls).toHaveLength(callsBefore);
	});
});

describe('undo', () => {
	const undoable: CatalogueRow = {
		...CATALOGUE.get('render.empty')!,
		repairId: 'test.undoable',
		undo: { handle: 'test.undo' }
	};
	const registries = (rw: Rw, undoOk = true) => {
		const ran: RepairRun = { ok: true, detail: 'cleared' };
		return {
			catalogue: new Map([...CATALOGUE, [undoable.repairId, undoable]]),
			handles: {
				...REPAIR_HANDLES,
				[undoable.repairId]: {
					verified: true,
					run: async () => {
						rw.site.state.findings.delete('render.empty');
						return ran;
					}
				}
			},
			undo: {
				'test.undo': async () => {
					rw.site.state.findings.add('render.empty');
					return { ok: undoOk, detail: 'restored' };
				}
			}
		};
	};

	it('restores what the repair changed and marks the repair undone', async () => {
		const rw = await repairWorld();
		const regs = registries(rw);
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'test.undoable'), { registries: regs });
		const [original] = rw.records();
		expect(original!.status).toBe('succeeded');
		expect(rw.site.state.findings.has('render.empty')).toBe(false);
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const undo = await runRepair(rw, inputOf(rw, 'test.undoable', { undoOf: original!.id }), {
			registries: regs
		});
		expect(undo.outcome).toEqual({ status: 'succeeded' });
		expect(rw.site.state.findings.has('render.empty')).toBe(true);
		const rows = rw.records();
		expect(rows.find((row) => row.id === original!.id)!.status).toBe('undone');
		expect(rows.at(-1)).toMatchObject({ status: 'succeeded', undo_of: original!.id });
	});

	it('refuses to undo a repair twice', async () => {
		const rw = await repairWorld();
		const regs = registries(rw);
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'test.undoable'), { registries: regs });
		const original = rw.records()[0]!;
		await runRepair(rw, inputOf(rw, 'test.undoable', { undoOf: original.id }), {
			registries: regs
		});
		await runRepair(rw, inputOf(rw, 'test.undoable', { undoOf: original.id }), {
			registries: regs
		});
		expect(refusedCode(rw)).toBe('not_undoable');
	});

	it('refuses to undo a repair whose row names no undo handle', async () => {
		const rw = await repairWorld();
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'render.empty'));
		const original = rw.records()[0]!;
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const { outcome } = await runRepair(
			rw,
			inputOf(rw, 'render.empty', { undoOf: original.id })
		);
		expect(outcome.status).toBe('cancelled');
		expect(refusedCode(rw)).toBe('not_undoable');
		expect(parsed(rw.records().at(-1)!.observation_before).refused.reason).toContain(
			'stored pages refill'
		);
	});

	it('fails the run when the undo does not take', async () => {
		const rw = await repairWorld();
		const regs = registries(rw, false);
		rw.site.state.findings.add('render.empty');
		await runRepair(rw, inputOf(rw, 'test.undoable'), { registries: regs });
		const original = rw.records()[0]!;
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const { outcome } = await runRepair(
			rw,
			inputOf(rw, 'test.undoable', { undoOf: original.id }),
			{ registries: regs }
		);
		expect(outcome.status).toBe('failed');
		expect(rw.records().find((row) => row.id === original.id)!.status).toBe('succeeded');
	});

	it('refuses to undo a record that belongs to no repair on this site', async () => {
		const rw = await repairWorld();
		const { outcome } = await runRepair(
			rw,
			inputOf(rw, 'render.empty', { undoOf: 'rpr_missing' })
		);
		expect(outcome.status).toBe('failed');
		expect(rw.site.state.calls).toEqual([]);
	});
});

describe('the tick', () => {
	const NOW = 1_790_000_000_000;
	const failing = (code = 'render.empty', strikes = 1): SiteReading => ({
		history: Array.from({ length: strikes }, (): LadderOutcome => ({ ok: false, code })),
		facts: {
			quarantinedAt: null,
			restorePoint: undefined,
			transactionDepth: 0,
			gateHeld: false,
			shedding: false,
			leaseHeld: true,
			ringPromotion: false
		}
	});
	const siteA = { id: 'site_a', organizationId: 'org_a' };
	const siteB = { id: 'site_b', organizationId: 'org_a' };
	const siteC = { id: 'site_c', organizationId: 'org_c' };

	function deps(
		over: Partial<LadderTickDeps> & { readings?: Record<string, SiteReading | null> } = {}
	) {
		const started: { siteId: string; repairId: string; key: string }[] = [];
		const read: string[] = [];
		const { readings = {}, ...rest } = over;
		const built: LadderTickDeps = {
			now: () => NOW,
			sites: async () => [siteA],
			reading: async (site) => {
				read.push(site.id);
				return site.id in readings ? readings[site.id]! : failing();
			},
			switches: async () => ({ global: true }),
			past: async () => [],
			recent: async () => [],
			start: async (site, decision) => {
				started.push({ siteId: site.id, repairId: decision.repairId, key: decision.key });
			},
			hasHandler: (id) => REPAIR_HANDLES[id]?.verified === true,
			budget: DEFAULT_REPAIR_BUDGET,
			...rest
		};
		return { built, started, read };
	}

	it('starts the repair for a failing site when automatic repair is on', async () => {
		const { built, started } = deps();
		const summary = await tickLadder(built);
		expect(started).toEqual([
			{
				siteId: 'site_a',
				repairId: 'render.empty',
				key: `ladder:site_a:render.empty:${Math.floor(NOW / TICK_MS)}`
			}
		]);
		expect(summary.started).toEqual([{ siteId: 'site_a', repairId: 'render.empty' }]);
	});

	it('starts nothing and reads no site when automatic repair is off', async () => {
		for (const global of [false, undefined]) {
			const { built, started, read } = deps({ switches: async () => ({ global }) });
			await tickLadder(built);
			expect(started).toEqual([]);
			expect(read).toEqual([]);
		}
	});

	it('starts nothing for a site whose organisation or own switch is off', async () => {
		for (const switches of [
			{ global: true, org: false },
			{ global: true, site: false }
		]) {
			const { built, started } = deps({ switches: async () => switches });
			const summary = await tickLadder(built);
			expect(started).toEqual([]);
			expect(summary.held[0]!.reason).toBe('automatic repair is off');
		}
	});

	it('starts nothing for a repair that needs a person or has no route', async () => {
		for (const code of ['migrate.incomplete', 'budget.rows_written', 'not.in.catalogue']) {
			const { built, started } = deps({ readings: { site_a: failing(code) } });
			await tickLadder(built);
			expect(started, code).toEqual([]);
		}
	});

	it('starts nothing on a quarantined site or one that may not repair safely', async () => {
		const quarantined = deps({ readings: { site_a: failing('render.empty', 3) } });
		await tickLadder(quarantined.built);
		expect(quarantined.started).toEqual([]);
		const unknown = failing();
		unknown.facts.transactionDepth = undefined;
		const open = deps({ readings: { site_a: unknown } });
		const summary = await tickLadder(open.built);
		expect(open.started).toEqual([]);
		expect(summary.held[0]!.reason).toBe('open transaction or gate held');
	});

	it('holds a repair in its cool-down and after its attempt bound', async () => {
		const recent = deps({
			past: async () => [{ status: 'failed', finishedAt: NOW - 1_000 }]
		});
		await tickLadder(recent.built);
		expect(recent.started).toEqual([]);
		const exhausted = deps({
			past: async () =>
				Array.from({ length: 3 }, () => ({
					status: 'failed',
					finishedAt: NOW - 10 * BREAKER_WINDOW_MS
				}))
		});
		await tickLadder(exhausted.built);
		expect(exhausted.started).toEqual([]);
	});

	it('counts the repairs it starts against the organisation budget', async () => {
		const { built, started } = deps({
			sites: async () => [siteA, siteB, siteC],
			budget: { perOrgPerHour: 1, fleetPerHour: 300 }
		});
		const summary = await tickLadder(built);
		expect(started.map((s) => s.siteId)).toEqual(['site_a', 'site_c']);
		expect(summary.held).toEqual([
			{ siteId: 'site_b', reason: 'organisation repair budget spent for the hour' }
		]);
	});

	it('keeps going when one site fails to read, and lists it', async () => {
		const { built, started } = deps({
			sites: async () => [siteA, siteB, siteC],
			reading: async (site) => {
				if (site.id === 'site_a') throw new Error('shard down');
				return site.id === 'site_b' ? null : failing();
			}
		});
		const summary = await tickLadder(built);
		expect(summary.failed).toEqual([{ siteId: 'site_a', message: 'shard down' }]);
		expect(summary.unreadable).toEqual(['site_b']);
		expect(started.map((s) => s.siteId)).toEqual(['site_c']);
	});

	it('lists nothing as held for a healthy site', async () => {
		const { built, started } = deps({ readings: { site_a: { ...failing(), history: [] } } });
		const summary = await tickLadder(built);
		expect(started).toEqual([]);
		expect(summary.held).toEqual([]);
	});

	it('reads the failing code from the site repair state before its findings', () => {
		expect(historyOf([], { code: null, strikes: 0 })).toEqual([]);
		expect(historyOf(['unknown.code'], { code: null, strikes: 0 })).toEqual([]);
		expect(historyOf(['x', 'render.empty'], { code: null, strikes: 0 })).toEqual([
			{ ok: false, code: 'render.empty' }
		]);
		expect(historyOf(['render.empty'], { code: 'reconcile', strikes: 2 })).toEqual([
			{ ok: false, code: 'reconcile' },
			{ ok: false, code: 'reconcile' }
		]);
		expect(historyOf(['reconcile'], { code: 'render.empty', strikes: 2 })).toHaveLength(2);
	});

	it('is a scheduled task that skips when it carries no environment', async () => {
		vi.doMock('nitropack/runtime', () => ({ defineTask: (task: unknown) => task }));
		const task = (await import('../../../src/server/tasks/ladder-tick')).default;
		expect(task.meta?.name).toBe('ladder-tick');
		expect(await task.run({ payload: {}, name: 'ladder-tick', context: {} } as never)).toEqual({
			result: { skipped: 'the task carries no cloudflare env' }
		});
	});
});
