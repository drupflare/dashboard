import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../../../../contracts/src/common';
import { countsRoute } from '../../../../dispatch/src/control-counts';
import { applyIn, hourOf, readHourIn, readMonthIn } from '../../../../dispatch/src/counting';
import { dispatchCountsReader } from '../../../../src/server/integrations/dispatch-counts';
import {
	blockThreshold,
	budgetModeOf,
	evaluateAllBudgets,
	evaluateOrganization,
	periodOf,
	REASSERT_MS,
	reevaluate,
	type BudgetEnforcementDeps,
	type BudgetMode,
	type BudgetWrite,
	type OrgBudgetInput,
	type StateRecord
} from '../../../../src/server/services/budget-enforcement';
import { fakeClock, memoryKv } from '../../dispatch/fakes';

const NOW = 1_790_000_000_000;
const PERIOD = periodOf(NOW);

type Counts = Record<string, number | null | 'throw'>;

function rig(orgs: OrgBudgetInput[], counts: Counts, mode: BudgetMode = 'on') {
	const sources = new Map(orgs.map((org) => [org.orgId, org]));
	const lease = new Map<string, { state: 'ok' | 'over-budget'; blockAtViews: number | null }>();
	const calls: { siteId: string; state: string; blockAtViews: number | null }[] = [];
	const fail = new Set<string>();
	const security = new Set<string>();
	const audits: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
	const logs: { message: string; detail: Record<string, unknown> }[] = [];
	const ledger = new Map<string, StateRecord>();
	const state = { counts, mode };
	const clock = { at: NOW };
	const deps: BudgetEnforcementDeps = {
		get mode() {
			return state.mode;
		},
		now: () => clock.at,
		source: {
			organizations: async () => [...sources.values()],
			organization: async (orgId) => sources.get(orgId) ?? null
		},
		counts: {
			monthViews: async (siteId, period) => {
				expect(period).toBe(PERIOD);
				const value = state.counts[siteId];
				if (value === 'throw') throw new Error('counter down');
				return value ?? null;
			}
		},
		authority: {
			async applyBudgetState(siteId, input): Promise<BudgetWrite> {
				calls.push({ siteId, state: input.state, blockAtViews: input.blockAtViews });
				if (fail.has(siteId)) throw new Error('authority down');
				if (security.has(siteId)) return { outcome: 'security-state' };
				const before = lease.get(siteId);
				lease.set(siteId, { ...input });
				return JSON.stringify(before) === JSON.stringify(input)
					? { outcome: 'unchanged', generation: 1 }
					: { outcome: 'written', generation: 2 };
			}
		},
		ledger: {
			get: async (siteId) => ledger.get(siteId) ?? null,
			set: async (siteId, record) => void ledger.set(siteId, record)
		},
		audit: async (orgId, input) => void audits.push({ orgId, ...input }),
		log: (message, detail) => void logs.push({ message, detail })
	};
	return { deps, sources, lease, calls, fail, security, audits, logs, ledger, state, clock };
}

// one organisation with the given sites, an allowance of 1,000 views each
function org(
	opts: {
		org?: OrgBudgetInput['budget'];
		sites?: Record<string, OrgBudgetInput['sites'][number]['budget']>;
		orgAllowance?: number | null;
	} = {}
): OrgBudgetInput {
	return {
		orgId: 'org_a',
		allowanceViews: opts.orgAllowance === undefined ? 3_000 : opts.orgAllowance,
		budget: opts.org ?? null,
		sites: Object.entries(opts.sites ?? { site_1: null }).map(([siteId, budget]) => ({
			siteId,
			allowanceViews: 1_000,
			budget
		}))
	};
}

const hard = (percent: number) => ({ percent, enforcement: 'block' as const });
const soft = (percent: number) => ({ percent, enforcement: 'alert' as const });

describe('a hard site budget', () => {
	it('blocks at exactly the cap and not a view before', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 1_999 });
		const before = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(before.sites[0]).toMatchObject({
			action: 'unchanged',
			state: 'ok',
			blockAtViews: 2_000
		});
		expect(r.calls).toEqual([{ siteId: 'site_1', state: 'ok', blockAtViews: 2_000 }]);
		r.state.counts.site_1 = 2_000;
		const at = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(at.sites[0]).toMatchObject({
			action: 'blocked',
			state: 'over-budget',
			blockAtViews: null
		});
		expect(r.calls.at(-1)).toEqual({
			siteId: 'site_1',
			state: 'over-budget',
			blockAtViews: null
		});
	});

	it('audits the block once, with the numbers, and records the state', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 });
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.audits).toHaveLength(1);
		expect(r.audits[0]).toMatchObject({
			orgId: 'org_a',
			action: 'budget.block',
			target: 'site_1',
			detail: { reason: 'site-budget', period: PERIOD, siteViews: 2_500, sitePercent: 200 }
		});
		expect(r.ledger.get('site_1')).toEqual({
			state: 'over-budget',
			reason: 'site-budget',
			mode: 'on',
			blockAtViews: null,
			writtenAt: NOW
		});
	});

	it('sends nothing for a site whose answer the ledger already holds, and repeats it each hour', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 });
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		const second = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.calls).toHaveLength(1);
		expect(second.sites[0]?.action).toBe('unchanged');
		r.clock.at = NOW + REASSERT_MS;
		const third = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.calls).toHaveLength(2);
		expect(r.calls[0]).toEqual(r.calls[1]);
		expect(third.sites[0]?.action).toBe('unchanged');
	});

	it('writes again when only the threshold moved', async () => {
		const r = rig([org({ org: hard(100), sites: { site_1: null, site_2: null } })], {
			site_1: 100,
			site_2: 0
		});
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		r.state.counts.site_2 = 300;
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(
			r.calls.filter((call) => call.siteId === 'site_1').map((call) => call.blockAtViews)
		).toEqual([3_000, 2_700]);
	});

	it('lifts at once when the cap is raised, and audits the lift', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 });
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		r.sources.set('org_a', org({ sites: { site_1: hard(400) } }));
		const outcome = await reevaluate(r.deps, 'org_a');
		expect(outcome?.sites[0]).toMatchObject({
			action: 'unblocked',
			state: 'ok',
			blockAtViews: 4_000
		});
		expect(r.audits.map((a) => a.action)).toEqual(['budget.block', 'budget.unblock']);
		expect(r.lease.get('site_1')).toEqual({ state: 'ok', blockAtViews: 4_000 });
	});

	it('returns null from reevaluate for an organisation with no budget record', async () => {
		const r = rig([], {});
		expect(await reevaluate(r.deps, 'org_none')).toBeNull();
		expect(r.calls).toHaveLength(0);
	});
});

describe('a hard organisation budget', () => {
	const three = (budget = hard(300)) =>
		org({ org: budget, sites: { site_1: null, site_2: null, site_3: null } });

	it('blocks every site once the organisation total reaches the cap', async () => {
		const r = rig([three()], { site_1: 4_000, site_2: 3_000, site_3: 2_000 });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.action)).toEqual(['blocked', 'blocked', 'blocked']);
		expect(
			r.audits.every((a) => (a.detail as { reason: string }).reason === 'org-budget')
		).toBe(true);
	});

	it('blocks none a view before, and gives each site the room the others left', async () => {
		const r = rig([three()], { site_1: 4_000, site_2: 3_000, site_3: 1_999 });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.state)).toEqual(['ok', 'ok', 'ok']);
		expect(outcome.sites.map((s) => s.blockAtViews)).toEqual([4_001, 3_001, 2_000]);
	});

	it('stops a flood on one site between runs: its threshold is its own count plus the room left', async () => {
		const r = rig([three()], { site_1: 100, site_2: 100, site_3: 100 });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.blockAtViews)).toEqual([8_800, 8_800, 8_800]);
	});

	it('takes the smaller of the site cap and what the organisation has left', async () => {
		const mixed = org({ org: hard(300), sites: { site_1: hard(150), site_2: null } });
		const r = rig([mixed], { site_1: 1_000, site_2: 100 });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.blockAtViews)).toEqual([1_500, 8_000]);
	});
});

describe('soft budgets', () => {
	it('never blocks and never sets a threshold for a soft organisation budget', async () => {
		const r = rig([org({ org: soft(200), sites: { site_1: null, site_2: null } })], {
			site_1: 90_000,
			site_2: 90_000
		});
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => [s.state, s.blockAtViews, s.action])).toEqual([
			['ok', null, 'unchanged'],
			['ok', null, 'unchanged']
		]);
		expect(r.audits).toHaveLength(0);
	});

	it('still blocks a hard site under a soft organisation, and only that site', async () => {
		const r = rig([org({ org: soft(200), sites: { site_1: hard(150), site_2: null } })], {
			site_1: 1_500,
			site_2: 1_500
		});
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.state)).toEqual(['over-budget', 'ok']);
		expect(outcome.sites[1]?.blockAtViews).toBeNull();
	});

	it('never blocks a soft site under a hard organisation that has room', async () => {
		const r = rig([org({ org: hard(500), sites: { site_1: soft(100), site_2: null } })], {
			site_1: 5_000,
			site_2: 100
		});
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.state)).toEqual(['ok', 'ok']);
		expect(outcome.sites[0]?.blockAtViews).toBe(5_000 + 15_000 - 5_100);
	});

	it('does nothing for an organisation with no budget at all', async () => {
		const r = rig([org()], { site_1: 1_000_000 });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites[0]).toMatchObject({
			action: 'unchanged',
			state: 'ok',
			blockAtViews: null
		});
	});
});

describe('shadow mode', () => {
	it('computes and logs would-block with the numbers, and writes nothing to the authority', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 }, 'shadow');
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites[0]?.action).toBe('would-block');
		expect(r.calls).toHaveLength(0);
		expect(r.logs).toHaveLength(1);
		expect(r.logs[0]?.message).toBe('budget enforcement would block');
		expect(r.logs[0]?.detail).toMatchObject({
			siteId: 'site_1',
			siteViews: 2_500,
			sitePercent: 200
		});
		expect(r.audits.map((a) => a.action)).toEqual(['budget.would-block']);
		expect(r.lease.size).toBe(0);
	});

	it('reports a would-block once, not on every run', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 }, 'shadow');
		for (let run = 0; run < 3; run++)
			await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.audits).toHaveLength(1);
		expect(r.logs).toHaveLength(1);
		expect(r.calls).toHaveLength(0);
	});

	it('writes nothing for a soft budget or for a threshold either', async () => {
		const r = rig([org({ org: hard(300), sites: { site_1: null } })], { site_1: 10 }, 'shadow');
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.calls).toHaveLength(0);
	});

	it('starts again when the flag moves to on, so the first real block is audited', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 }, 'shadow');
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		r.state.mode = 'on';
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites[0]?.action).toBe('blocked');
		expect(r.audits.map((a) => a.action)).toEqual(['budget.would-block', 'budget.block']);
		expect(r.calls).toHaveLength(1);
	});

	it('records a would-unblock when the cap is raised', async () => {
		const r = rig([org({ sites: { site_1: hard(200) } })], { site_1: 2_500 }, 'shadow');
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		r.sources.set('org_a', org({ sites: { site_1: hard(400) } }));
		const outcome = await reevaluate(r.deps, 'org_a');
		expect(outcome?.sites[0]?.action).toBe('would-unblock');
		expect(r.audits.map((a) => a.action)).toEqual([
			'budget.would-block',
			'budget.would-unblock'
		]);
	});
});

describe('failures', () => {
	it('lets one site fail without stopping the others, and retries it next run', async () => {
		const r = rig(
			[org({ sites: { site_1: hard(150), site_2: hard(150), site_3: hard(150) } })],
			{
				site_1: 2_000,
				site_2: 2_000,
				site_3: 2_000
			}
		);
		r.fail.add('site_2');
		const first = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(first.sites.map((s) => s.action)).toEqual(['blocked', 'failed', 'blocked']);
		expect(first.sites[1]?.message).toBe('authority down');
		expect(r.audits.map((a) => a.target)).toEqual(['site_1', 'site_3']);
		r.fail.delete('site_2');
		const second = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(second.sites.map((s) => s.action)).toEqual(['unchanged', 'blocked', 'unchanged']);
		expect(r.audits.map((a) => a.target)).toEqual(['site_1', 'site_3', 'site_2']);
	});

	it('never lifts a block on a count it could not read', async () => {
		for (const unreadable of [null, 'throw'] as const) {
			const r = rig([org({ sites: { site_1: hard(150) } })], { site_1: 2_000 });
			await evaluateOrganization(r.deps, r.sources.get('org_a')!);
			r.state.counts.site_1 = unreadable;
			const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
			expect(outcome.sites[0]?.action).toBe('held');
			expect(r.lease.get('site_1')?.state).toBe('over-budget');
			expect(r.audits.map((a) => a.action)).toEqual(['budget.block']);
		}
	});

	it('does not lift an organisation block while one of its sites cannot be read', async () => {
		const budgeted = org({ org: hard(100), sites: { site_1: null, site_2: null } });
		const r = rig([budgeted], { site_1: 3_000, site_2: 0 });
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(r.lease.get('site_2')?.state).toBe('over-budget');
		r.state.counts = { site_1: 1, site_2: null };
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.action)).toEqual(['held', 'held']);
	});

	it('blocks on a lower bound even when another site cannot be read', async () => {
		const budgeted = org({ org: hard(100), sites: { site_1: null, site_2: null } });
		const r = rig([budgeted], { site_1: 3_000, site_2: 'throw' });
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.state)).toEqual(['over-budget', 'over-budget']);
	});

	it('holds a block while the allowance is unknown', async () => {
		const r = rig([org({ sites: { site_1: hard(150) } })], { site_1: 2_000 });
		await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		const unknown = org({ sites: { site_1: hard(150) } });
		unknown.sites[0]!.allowanceViews = null;
		const outcome = await evaluateOrganization(r.deps, unknown);
		expect(outcome.sites[0]?.action).toBe('held');
	});

	it('holds a site the authority says is suspended or revoked', async () => {
		const r = rig([org({ sites: { site_1: hard(150) } })], { site_1: 2_000 });
		r.security.add('site_1');
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites[0]).toMatchObject({ action: 'held', message: 'security-state' });
		expect(r.audits).toHaveLength(0);
	});

	it('carries on with the next organisation when one cannot be evaluated', async () => {
		const broken = { ...org(), orgId: 'org_broken', sites: null } as unknown as OrgBudgetInput;
		const good: OrgBudgetInput = { ...org({ sites: { site_9: hard(150) } }), orgId: 'org_b' };
		const r = rig([broken, good], { site_9: 2_000 });
		const outcomes = await evaluateAllBudgets(r.deps);
		expect(outcomes.map((o) => o.orgId)).toEqual(['org_b']);
		expect(outcomes[0]?.sites[0]?.action).toBe('blocked');
		expect(r.logs[0]).toMatchObject({
			message: 'budget evaluation failed for an organisation',
			detail: { orgId: 'org_broken' }
		});
	});

	it('reports a site whose ledger fails as failed and still evaluates the rest', async () => {
		const r = rig([org({ sites: { site_1: hard(150), site_2: hard(150) } })], {
			site_1: 2_000,
			site_2: 2_000
		});
		r.deps.ledger.get = async (siteId) => {
			if (siteId === 'site_1') throw new Error('ledger down');
			return null;
		};
		const outcome = await evaluateOrganization(r.deps, r.sources.get('org_a')!);
		expect(outcome.sites.map((s) => s.action)).toEqual(['failed', 'blocked']);
	});
});

describe('the mode flag and the pure parts', () => {
	it('reads anything but on as shadow', () => {
		expect(budgetModeOf('on')).toBe('on');
		for (const value of [undefined, '', 'shadow', 'ON', 'true', 1, null]) {
			expect(budgetModeOf(value)).toBe('shadow');
		}
	});

	it('names the period by the UTC month', () => {
		expect(periodOf(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe('2026-11');
		expect(periodOf(Date.UTC(2026, 11, 1, 0, 0, 0))).toBe('2026-12');
	});

	it('gives no threshold with no hard budget, and none from an organisation whose count is unknown', () => {
		const site = { siteId: 's', allowanceViews: 1_000, budget: null };
		const none = { allowanceViews: 3_000, budget: null };
		expect(blockThreshold({ site, org: none, siteViews: 5, orgViews: 5 })).toBeNull();
		const hardOrg = { allowanceViews: 3_000, budget: hard(300) };
		expect(blockThreshold({ site, org: hardOrg, siteViews: null, orgViews: 5 })).toBeNull();
		expect(blockThreshold({ site, org: hardOrg, siteViews: 5, orgViews: null })).toBeNull();
		expect(blockThreshold({ site, org: hardOrg, siteViews: 5, orgViews: 9_001 })).toBe(5);
		expect(blockThreshold({ site, org: hardOrg, siteViews: 5, orgViews: 100 })).toBe(8_905);
	});

	it('rounds a fractional cap up, since views are whole', () => {
		const site = { siteId: 's', allowanceViews: 1_001, budget: hard(150.5) };
		const none = { allowanceViews: null, budget: null };
		expect(blockThreshold({ site, org: none, siteViews: 0, orgViews: 0 })).toBe(1_507);
		// a percent whose decimal form is not exact in binary still lands on the whole view
		const tenth = { siteId: 's', allowanceViews: 1_000, budget: hard(111.1) };
		expect(blockThreshold({ site: tenth, org: none, siteViews: 0, orgViews: 0 })).toBe(1_111);
	});
});

describe('the counts reader', () => {
	async function counted(views: number) {
		const control = await generateSigningKey();
		const clock = fakeClock(NOW);
		const kv = memoryKv();
		applyIn(
			kv,
			{
				siteId: 'site_1',
				hour: hourOf(NOW),
				origin: 'origin12345678',
				ranges: [{ from: 1, to: views }],
				issued: views,
				unavailable: false,
				sync: false
			},
			NOW,
			'site_1'
		);
		const route = (request: Request, key = control.publicKey) =>
			countsRoute(request, {
				controlKey: key,
				now: clock.now,
				counter: () => ({
					read: async (hour) => readHourIn(kv, 'site_1', hour),
					month: async (month) => readMonthIn(kv, month)
				})
			});
		return { control, clock, route };
	}

	it('reads the month total through the signed op', async () => {
		const c = await counted(42);
		const reader = dispatchCountsReader({
			controlUrl: 'https://control.test',
			signingKey: c.control.privateKey,
			now: c.clock.now,
			fetch: async (url, init) => {
				expect(url).toBe('https://control.test/counts');
				return c.route(new Request(url, init));
			}
		});
		expect(await reader.monthViews('site_1', PERIOD)).toBe(42);
		expect(await reader.monthViews('site_1', '2020-01')).toBe(0);
	});

	it('answers null, never zero, for a refusal, an outage or a bad body', async () => {
		const c = await counted(42);
		const other = await generateSigningKey();
		const make = (
			fetch: (url: string, init: RequestInit) => Promise<Response>,
			key = c.control
		) =>
			dispatchCountsReader({
				controlUrl: 'https://control.test',
				signingKey: key.privateKey,
				now: c.clock.now,
				fetch
			});
		const wrongKey = make(async (url, init) => c.route(new Request(url, init)), other);
		expect(await wrongKey.monthViews('site_1', PERIOD)).toBeNull();
		expect(
			await make(async () => Promise.reject(new Error('down'))).monthViews('site_1', PERIOD)
		).toBeNull();
		expect(
			await make(async () => new Response('nope', { status: 500 })).monthViews(
				'site_1',
				PERIOD
			)
		).toBeNull();
		expect(
			await make(async () => new Response('not json')).monthViews('site_1', PERIOD)
		).toBeNull();
		expect(
			await make(async () => Response.json({ ok: true, hours: [], months: [] })).monthViews(
				'site_1',
				PERIOD
			)
		).toBeNull();
	});
});

describe('the scheduled task', () => {
	afterEach(() => {
		vi.doUnmock('../../../../src/server/services/budgets');
		vi.resetModules();
	});

	async function loadTask(enforcement: (() => BudgetEnforcementDeps | null) | 'not-built') {
		vi.resetModules();
		vi.doMock('nitropack/runtime', () => ({ defineTask: (task: unknown) => task }));
		vi.doMock('../../../../src/server/services/budgets', async () => {
			// the class the task checks against is the one loaded after the reset
			const { ApiError } = await import('../../../../src/shared/errors');
			return {
				budgetServices: () => {
					if (enforcement === 'not-built') {
						throw new ApiError('not_built', 'Budgets are not available yet');
					}
					return { enforcement };
				}
			};
		});
		return (await import('../../../../src/server/tasks/budget-evaluate')).default;
	}

	it('is named and skips while the engine binding or the counts secret is missing', async () => {
		const task = await loadTask(() => null);
		expect(task.meta?.name).toBe('budget-evaluate');
		expect(
			await task.run({ payload: {}, name: 'budget-evaluate', context: {} } as never)
		).toEqual({ result: { skipped: 'the engine binding or the counts secret is missing' } });
	});

	it('skips while the services are not installed in the isolate', async () => {
		const task = await loadTask('not-built');
		expect(
			await task.run({ payload: {}, name: 'budget-evaluate', context: {} } as never)
		).toEqual({ result: { skipped: 'the services are not installed in this isolate yet' } });
	});

	it('runs the evaluation over every organisation with the deps it is given', async () => {
		const r = rig([org({ sites: { site_1: hard(150) } })], { site_1: 2_000 });
		const task = await loadTask(() => r.deps);
		const run = await task.run({
			payload: {},
			name: 'budget-evaluate',
			context: { cloudflare: { env: {} } }
		} as never);
		expect(run).toEqual({ result: { mode: 'on', organisations: 1, changed: 1 } });
		expect(r.calls).toEqual([{ siteId: 'site_1', state: 'over-budget', blockAtViews: null }]);
	});
});
