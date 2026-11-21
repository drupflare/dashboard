import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_MAX_SITES } from '../../../../contracts/src/engine-batch';
import {
	engineBudgetWriter,
	engineCountsReaders,
	type EngineBatchConfig
} from '../../../../src/server/integrations/engine-batch';
import {
	evaluateAllBudgets,
	periodOf,
	reevaluate,
	type BudgetEnforcementDeps,
	type BudgetMode,
	type OrgBudgetInput,
	type StateRecord
} from '../../../../src/server/services/budget-enforcement';
import { newSiteId } from '../../dispatch/fakes';
import {
	BUDGET_SECRET,
	COUNTS_SECRET,
	NOW,
	bindingOf,
	rig as engineRig,
	freezeClock
} from '../../engine/batch-support';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

beforeEach(freezeClock);
afterEach(() => vi.useRealTimers());

const PERIOD = periodOf(NOW);
type Budget = { percent: number; enforcement: 'block' | 'alert' };
const hard = (percent: number): Budget => ({ percent, enforcement: 'block' });
const soft = (percent: number): Budget => ({ percent, enforcement: 'alert' });

type SiteSpec = { views: number; budget?: Budget | null };

// real engine route, real authority objects, in-memory source, ledger and audit; every site has an
// allowance of 1,000 views and the organisation 1,000 times the number of sites
async function world(
	sites: Record<string, SiteSpec>,
	orgBudget: Budget | null,
	mode: BudgetMode = 'on'
) {
	const ids = Object.fromEntries(Object.keys(sites).map((name) => [name, newSiteId()]));
	const r = await engineRig(Object.values(ids));
	const log: { path: string; body: unknown }[] = [];
	const config: EngineBatchConfig = {
		binding: bindingOf(r.deps, log),
		budgetSecret: BUDGET_SECRET,
		countsSecret: COUNTS_SECRET,
		now: () => NOW,
		newId: () => `req_${crypto.randomUUID()}`
	};
	const views = new Map(Object.entries(sites).map(([name, spec]) => [ids[name]!, spec.views]));
	const sync = () => {
		for (const [siteId, count] of views) {
			r.countsAnswer.set(siteId, {
				ok: true,
				hours: [],
				months: [{ month: PERIOD, views: count }]
			});
		}
	};
	sync();
	const input = (): OrgBudgetInput => ({
		orgId: 'org_a',
		allowanceViews: 1_000 * Object.keys(sites).length,
		budget: orgBudget,
		sites: Object.entries(sites).map(([name, spec]) => ({
			siteId: ids[name]!,
			allowanceViews: 1_000,
			budget: spec.budget ?? null
		}))
	});
	const state = { org: input() };
	const ledger = new Map<string, StateRecord>();
	const audits: { action: string; target: string }[] = [];
	const logs: { message: string; detail: Record<string, unknown> }[] = [];
	const counts = engineCountsReaders(config);
	const deps: BudgetEnforcementDeps = {
		mode,
		now: () => NOW,
		source: {
			organizations: async () => [state.org],
			organization: async (orgId) => (orgId === state.org.orgId ? state.org : null)
		},
		counts: counts.views,
		authority: engineBudgetWriter(config),
		ledger: {
			get: async (siteId) => ledger.get(siteId) ?? null,
			getMany: async (siteIds) =>
				new Map(siteIds.flatMap((id) => (ledger.has(id) ? [[id, ledger.get(id)!]] : []))),
			set: async (siteId, record) => void ledger.set(siteId, record)
		},
		audit: async (_orgId, entry) => void audits.push(entry),
		log: (message, detail) => void logs.push({ message, detail })
	};
	const lease = async (name: string) => (await r.stubs.get(ids[name]!)!.read())!;
	return {
		ids,
		r,
		log,
		deps,
		state,
		ledger,
		audits,
		logs,
		lease,
		setViews(name: string, count: number) {
			views.set(ids[name]!, count);
			sync();
		},
		setOrg(next: OrgBudgetInput) {
			state.org = next;
		},
		input
	};
}

describe('budget enforcement through the engine', () => {
	it('blocks a hard site, leaves a soft site alone, and sends one batch', async () => {
		const w = await world(
			{
				hard: { views: 2_500, budget: hard(200) },
				soft: { views: 9_000, budget: soft(200) }
			},
			null
		);
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites.map((s) => s.action)).toEqual(['blocked', 'unchanged']);
		expect((await w.lease('hard')).state).toBe('over-budget');
		const softLease = await w.lease('soft');
		expect(softLease.state).toBe('active');
		expect('blockAtViews' in softLease.limits).toBe(false);
		expect(w.log.map((entry) => entry.path)).toEqual(['/counts', '/budget']);
		expect(w.audits).toEqual([
			{
				actor: 'system:budget-enforcement',
				action: 'budget.block',
				target: w.ids.hard,
				detail: expect.anything()
			}
		]);
	});

	it('lifts a block at the next run once the cap is raised', async () => {
		const w = await world({ one: { views: 2_500, budget: hard(200) } }, null);
		await evaluateAllBudgets(w.deps);
		expect((await w.lease('one')).state).toBe('over-budget');
		w.setOrg({
			...w.input(),
			sites: w.input().sites.map((site) => ({ ...site, budget: hard(300) }))
		});
		const next = await evaluateAllBudgets(w.deps);
		expect(next[0]?.sites[0]?.action).toBe('unblocked');
		const lease = await w.lease('one');
		expect(lease.state).toBe('active');
		expect(lease.limits.blockAtViews).toBe(3_000);
		expect(w.audits.map((a) => a.action)).toEqual(['budget.block', 'budget.unblock']);
	});

	it('applies a changed cap at once through reevaluate', async () => {
		const w = await world({ one: { views: 2_500, budget: hard(200) } }, null);
		await evaluateAllBudgets(w.deps);
		w.setOrg({ ...w.input(), sites: [{ ...w.input().sites[0]!, budget: hard(400) }] });
		const done = await reevaluate(w.deps, 'org_a');
		expect(done?.sites[0]?.action).toBe('unblocked');
		expect((await w.lease('one')).state).toBe('active');
	});

	it('blocks all three sites of an organisation that is at its cap', async () => {
		const w = await world(
			{ a: { views: 1_000 }, b: { views: 1_000 }, c: { views: 1_000 } },
			hard(100)
		);
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites.map((s) => s.action)).toEqual(['blocked', 'blocked', 'blocked']);
		for (const name of ['a', 'b', 'c']) expect((await w.lease(name)).state).toBe('over-budget');
	});

	it('stops a flooded site at the lower of its own cap and its count plus what the organisation has left', async () => {
		const w = await world(
			{
				flood: { views: 500, budget: hard(300) },
				b: { views: 1_000 },
				c: { views: 0 }
			},
			hard(100)
		);
		await evaluateAllBudgets(w.deps);
		// organisation cap 3,000, served 1,500, so the flooded site may reach 500 + 1,500
		expect((await w.lease('flood')).limits.blockAtViews).toBe(2_000);
		const tighter = await world(
			{ flood: { views: 500, budget: hard(150) }, b: { views: 1_000 }, c: { views: 0 } },
			hard(100)
		);
		await evaluateAllBudgets(tighter.deps);
		expect((await tighter.lease('flood')).limits.blockAtViews).toBe(1_500);
	});

	it('sends the second run nothing for sites whose answer the ledger holds', async () => {
		const w = await world({ one: { views: 100, budget: hard(200) } }, null);
		await evaluateAllBudgets(w.deps);
		await evaluateAllBudgets(w.deps);
		expect(w.log.filter((entry) => entry.path === '/budget')).toHaveLength(1);
		expect(w.log.filter((entry) => entry.path === '/counts')).toHaveLength(2);
	});

	it('keeps shadow mode away from the write route and records what it would have done', async () => {
		const w = await world({ one: { views: 2_500, budget: hard(200) } }, null, 'shadow');
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites[0]?.action).toBe('would-block');
		expect(w.log.map((entry) => entry.path)).toEqual(['/counts']);
		expect((await w.lease('one')).state).toBe('active');
		expect(w.audits.map((a) => a.action)).toEqual(['budget.would-block']);
		expect(w.logs.some((l) => l.message === 'budget enforcement would block')).toBe(true);
	});

	it('keeps a block when the counts could not be read, and never lifts it', async () => {
		const w = await world({ one: { views: 2_500, budget: hard(200) } }, null);
		await evaluateAllBudgets(w.deps);
		w.r.countsAnswer.set(w.ids.one!, null);
		w.setOrg({ ...w.input(), sites: [{ ...w.input().sites[0]!, budget: hard(900) }] });
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites[0]?.action).toBe('held');
		expect((await w.lease('one')).state).toBe('over-budget');
	});

	it('never writes over a suspended site and reports it held', async () => {
		const w = await world({ one: { views: 2_500, budget: hard(200) } }, null);
		const { signApply } = await import('../../../../dispatch/src/authority');
		const current = await w.lease('one');
		await w.r.stubs
			.get(w.ids.one!)!
			.apply(
				await signApply(
					{ ...current, state: 'suspended', generation: current.generation + 1 },
					NOW,
					w.r.control.privateKey
				)
			);
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites[0]).toMatchObject({ action: 'held', message: 'security-state' });
		expect((await w.lease('one')).state).toBe('suspended');
	});

	it('reports a failing site as failed and writes the others in the same batch', async () => {
		const w = await world(
			{ bad: { views: 2_500, budget: hard(200) }, good: { views: 2_500, budget: hard(200) } },
			null
		);
		w.r.broken.add(w.ids.bad!);
		const out = await evaluateAllBudgets(w.deps);
		expect(out[0]?.sites.map((s) => s.action)).toEqual(['failed', 'blocked']);
		expect(w.log.filter((entry) => entry.path === '/budget')).toHaveLength(1);
		expect((await w.lease('good')).state).toBe('over-budget');
	});

	it('records one summary line for the run', async () => {
		const w = await world(
			{ one: { views: 2_500, budget: hard(200) }, two: { views: 10, budget: hard(200) } },
			null
		);
		await evaluateAllBudgets(w.deps);
		expect(w.logs.find((l) => l.message === 'budget evaluation run')?.detail).toEqual({
			mode: 'on',
			organisations: 1,
			sites: 2,
			writesSent: 2,
			blocked: 1,
			unblocked: 0,
			wouldBlock: 0,
			held: 0,
			errors: 0
		});
	});

	it('reads and writes a large run in chunks of the cap', async () => {
		const names = Object.fromEntries(
			Array.from({ length: BATCH_MAX_SITES + 3 }, (_, i) => [
				`s${i}`,
				{ views: 5_000, budget: hard(200) }
			])
		);
		const w = await world(names, null);
		await evaluateAllBudgets(w.deps);
		expect(w.log.map((entry) => entry.path)).toEqual([
			'/counts',
			'/counts',
			'/budget',
			'/budget'
		]);
	});
});
