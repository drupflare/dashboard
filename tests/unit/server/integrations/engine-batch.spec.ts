import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_MAX_SITES } from '../../../../contracts/src/engine-batch';
import type { CountedHour } from '../../../../dispatch/src/counting';
import {
	budgetConfigured,
	countsConfigured,
	engineBatchConfigOf,
	engineBudgetWriter,
	engineCountsReaders,
	type EngineBatchConfig
} from '../../../../src/server/integrations/engine-batch';
import { newSiteId } from '../../dispatch/fakes';
import {
	BUDGET_SECRET,
	COUNTS_SECRET,
	NOW,
	bindingOf,
	freezeClock,
	rig
} from '../../engine/batch-support';

const START = 'start-secret-'.repeat(3);

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

function configOf(binding: EngineBatchConfig['binding'], over: Partial<EngineBatchConfig> = {}) {
	let n = 0;
	return {
		binding,
		budgetSecret: BUDGET_SECRET,
		countsSecret: COUNTS_SECRET,
		now: () => NOW,
		newId: () => `req_client_${String(++n).padStart(6, '0')}`,
		...over
	} satisfies EngineBatchConfig;
}

describe('engineBatchConfigOf', () => {
	it('reads the binding and the two secrets, and drops what is empty', () => {
		const binding = { fetch: async () => new Response() };
		expect(
			engineBatchConfigOf({ ENGINE: binding, BUDGET_SECRET: 'b', COUNTS_SECRET: '' })
		).toEqual({ binding, budgetSecret: 'b', countsSecret: undefined });
		expect(engineBatchConfigOf({ ENGINE: 'not a binding' }).binding).toBeUndefined();
	});

	it('falls back to the start secret for a message type with no secret of its own', () => {
		expect(
			engineBatchConfigOf({
				START_SECRET: START,
				BUDGET_SECRET: BUDGET_SECRET,
				COUNTS_SECRET: ''
			})
		).toMatchObject({ budgetSecret: BUDGET_SECRET, countsSecret: START });
		expect(engineBatchConfigOf({ START_SECRET: START })).toMatchObject({
			budgetSecret: START,
			countsSecret: START
		});
		expect(engineBatchConfigOf({})).toMatchObject({
			budgetSecret: undefined,
			countsSecret: undefined
		});
	});

	it('counts a secret as configured only when it is long enough', () => {
		const binding = { fetch: async () => new Response() };
		expect(countsConfigured({ binding, countsSecret: 'short' })).toBe(false);
		expect(countsConfigured({ binding, countsSecret: COUNTS_SECRET })).toBe(true);
		expect(budgetConfigured({ binding: undefined, budgetSecret: BUDGET_SECRET })).toBe(false);
		expect(budgetConfigured({ binding, budgetSecret: BUDGET_SECRET })).toBe(true);
	});
});

describe('the counts reader', () => {
	it('reads many sites in chunks of the cap, one round trip each', async () => {
		const ids = Array.from({ length: BATCH_MAX_SITES * 2 + 5 }, () => newSiteId());
		const r = await rig([]);
		const log: { path: string; body: unknown }[] = [];
		const { views } = engineCountsReaders(configOf(bindingOf(r.deps, log)));
		const out = await views.monthViewsMany!(ids, '2026-11');
		expect(log.map((entry) => entry.path)).toEqual(['/counts', '/counts', '/counts']);
		expect(log.map((entry) => (entry.body as { reads: unknown[] }).reads.length)).toEqual([
			BATCH_MAX_SITES,
			BATCH_MAX_SITES,
			5
		]);
		expect(out.size).toBe(ids.length);
		expect([...out.values()].every((views) => views === 7)).toBe(true);
	});

	it('reads one site through monthViews', async () => {
		const r = await rig([]);
		const id = newSiteId();
		const { views } = engineCountsReaders(configOf(bindingOf(r.deps)));
		expect(await views.monthViews(id, '2026-11')).toBe(7);
	});

	it('answers null for a site the counter did not answer and for a month it did not return', async () => {
		const r = await rig([]);
		const down = newSiteId();
		const empty = newSiteId();
		r.countsAnswer.set(down, null);
		r.countsAnswer.set(empty, { ok: true, hours: [], months: [] });
		const { views } = engineCountsReaders(configOf(bindingOf(r.deps)));
		const out = await views.monthViewsMany!([down, empty], '2026-11');
		expect(out.get(down)).toBeNull();
		expect(out.get(empty)).toBeNull();
	});

	it('answers the hours as the counter holds them, null for an hour with no record', async () => {
		const r = await rig([]);
		const id = newSiteId();
		const held = { siteId: id, start: 'x', issued: 3 } as unknown as CountedHour;
		r.countsAnswer.set(id, { ok: true, hours: [held, null], months: [] });
		const { hours } = engineCountsReaders(configOf(bindingOf(r.deps)));
		expect(await hours.read(id, [NOW, NOW + 1])).toEqual([held, null]);
	});

	it('tries a failed chunk once more with a new id, and gives up after the second try', async () => {
		const r = await rig([]);
		const id = newSiteId();
		let calls = 0;
		const failing = {
			async fetch(input: string | Request, init?: RequestInit) {
				calls++;
				if (calls === 1) return new Response('down', { status: 503 });
				return bindingOf(r.deps).fetch(input, init);
			}
		};
		const { views } = engineCountsReaders(configOf(failing));
		expect(await views.monthViews(id, '2026-11')).toBe(7);
		expect(calls).toBe(2);

		calls = 0;
		const dead = {
			async fetch() {
				calls++;
				throw new Error('no route');
			}
		};
		expect(
			await engineCountsReaders(configOf(dead)).views.monthViews(id, '2026-11')
		).toBeNull();
		expect(calls).toBe(2);
	});

	it('gives every site of a failed chunk null and still reads the next chunk', async () => {
		const r = await rig([]);
		const ids = Array.from({ length: BATCH_MAX_SITES + 2 }, () => newSiteId());
		let chunk = 0;
		const binding = {
			async fetch(input: string | Request, init?: RequestInit) {
				const body = JSON.parse(String(init?.body)) as { reads: unknown[] };
				if (body.reads.length === BATCH_MAX_SITES) {
					chunk++;
					return new Response('down', { status: 503 });
				}
				return bindingOf(r.deps).fetch(input, init);
			}
		};
		const out = await engineCountsReaders(configOf(binding)).views.monthViewsMany!(
			ids,
			'2026-11'
		);
		expect(chunk).toBe(2);
		expect(ids.slice(0, BATCH_MAX_SITES).every((id) => out.get(id) === null)).toBe(true);
		expect(ids.slice(BATCH_MAX_SITES).map((id) => out.get(id))).toEqual([7, 7]);
	});

	it('does not read without a binding or a usable counts secret', async () => {
		const reads = engineCountsReaders(configOf(undefined)).views;
		expect(await reads.monthViews(newSiteId(), '2026-11')).toBeNull();
		const r = await rig([]);
		const short = engineCountsReaders(configOf(bindingOf(r.deps), { countsSecret: 'short' }));
		expect(await short.views.monthViews(newSiteId(), '2026-11')).toBeNull();
	});

	it('signs with the counts secret, so the budget secret cannot read', async () => {
		const r = await rig([]);
		const reads = engineCountsReaders(
			configOf(bindingOf(r.deps), { countsSecret: BUDGET_SECRET })
		).views;
		expect(await reads.monthViews(newSiteId(), '2026-11')).toBeNull();
	});
});

describe('the budget writer', () => {
	it('writes a batch in one round trip and maps each answer', async () => {
		const a = newSiteId();
		const b = newSiteId();
		const gone = newSiteId();
		const r = await rig([a, b]);
		const log: { path: string; body: unknown }[] = [];
		const writer = engineBudgetWriter(configOf(bindingOf(r.deps, log)));
		const out = await writer.applyBudgetStates!([
			{ siteId: a, state: 'over-budget', blockAtViews: null },
			{ siteId: b, state: 'ok', blockAtViews: 400 },
			{ siteId: gone, state: 'over-budget', blockAtViews: null }
		]);
		expect(log).toHaveLength(1);
		expect(log[0]?.path).toBe('/budget');
		expect(out.get(a)).toEqual({ outcome: 'written', generation: 2 });
		expect(out.get(b)).toEqual({ outcome: 'written', generation: 2 });
		expect(out.get(gone)).toEqual({ outcome: 'unknown-site' });
		expect((await r.stubs.get(a)!.read())?.state).toBe('over-budget');
		expect((await r.stubs.get(b)!.read())?.limits.blockAtViews).toBe(400);
	});

	it('sends the lease words the engine knows and never a key', async () => {
		const a = newSiteId();
		const r = await rig([a]);
		const log: { path: string; body: unknown }[] = [];
		const writer = engineBudgetWriter(configOf(bindingOf(r.deps, log)));
		await writer.applyBudgetState(a, { state: 'ok', blockAtViews: null });
		expect(log[0]?.body).toEqual({
			writes: [{ siteId: a, state: 'active', blockAtViews: null }]
		});
		expect(JSON.stringify(log)).not.toMatch(/seed|private|secret/i);
	});

	it('reports a site the engine could not write as an error, and the rest as written', async () => {
		const a = newSiteId();
		const b = newSiteId();
		const r = await rig([a, b]);
		r.broken.add(a);
		const writer = engineBudgetWriter(configOf(bindingOf(r.deps)));
		const out = await writer.applyBudgetStates!([
			{ siteId: a, state: 'over-budget', blockAtViews: null },
			{ siteId: b, state: 'over-budget', blockAtViews: null }
		]);
		expect(out.get(a)).toBeInstanceOf(Error);
		expect(out.get(b)).toEqual({ outcome: 'written', generation: 2 });
		await expect(
			writer.applyBudgetState(a, { state: 'over-budget', blockAtViews: null })
		).rejects.toThrow();
	});

	it('returns an error for every site of a chunk that could not be sent', async () => {
		const ids = Array.from({ length: 3 }, () => newSiteId());
		const dead = {
			async fetch() {
				throw new Error('no route');
			}
		};
		const out = await engineBudgetWriter(configOf(dead)).applyBudgetStates!(
			ids.map((siteId) => ({ siteId, state: 'over-budget' as const, blockAtViews: null }))
		);
		expect(ids.every((id) => out.get(id) instanceof Error)).toBe(true);
	});

	it('is refused when signed with the counts secret', async () => {
		const a = newSiteId();
		const r = await rig([a]);
		const writer = engineBudgetWriter(
			configOf(bindingOf(r.deps), { budgetSecret: COUNTS_SECRET })
		);
		const out = await writer.applyBudgetStates!([
			{ siteId: a, state: 'over-budget', blockAtViews: null }
		]);
		expect(out.get(a)).toBeInstanceOf(Error);
		expect((await r.stubs.get(a)!.read())?.state).toBe('active');
	});
});
