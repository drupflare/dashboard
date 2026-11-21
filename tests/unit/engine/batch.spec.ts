import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_HEADERS } from '../../../contracts/src/engine-start';
import { signApply } from '../../../dispatch/src/authority';
import type { CountedHour } from '../../../dispatch/src/counting';
import { counterFor } from '../../../dispatch/src/usage';
import { usageCountsOf } from '../../../engine/src/adapters/counts';
import {
	BATCH_MAX_SITES,
	BATCH_WINDOW_MS,
	handleBatch,
	signBatch,
	type BatchDeps,
	type BatchKind,
	type BudgetBatchAnswer,
	type CountsBatchAnswer
} from '../../../engine/src/batch';
import { authorityState, newSiteId } from '../dispatch/fakes';
import { BUDGET_SECRET, COUNTS_SECRET, NOW, freezeClock, rig as makeRig } from './batch-support';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const A = newSiteId();
const B = newSiteId();
const C = newSiteId();
const GONE = newSiteId();
const START_SECRET = 'start-secret-'.repeat(3);
const newRequestId = () => `req_${crypto.randomUUID()}`;

beforeEach(freezeClock);
afterEach(() => vi.useRealTimers());

const rig = (siteIds: string[] = [A, B]) => makeRig(siteIds);

async function post(
	deps: BatchDeps,
	kind: BatchKind,
	payload: unknown,
	options: {
		secret?: string;
		now?: number;
		id?: string;
		method?: string;
		drop?: string;
		path?: string;
	} = {}
) {
	const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
	const secret = options.secret ?? (kind === 'budget' ? BUDGET_SECRET : COUNTS_SECRET);
	const signed = await signBatch(kind, body, {
		secret,
		now: options.now ?? NOW,
		id: options.id ?? `req_${crypto.randomUUID()}`
	});
	const headers = new Headers(signed);
	if (options.drop !== undefined) headers.delete(options.drop);
	const method = options.method ?? 'POST';
	return handleBatch(
		new Request(
			`https://engine.example${options.path ?? (kind === 'budget' ? '/budget' : '/counts')}`,
			{
				method,
				headers,
				body: method === 'GET' ? undefined : body
			}
		),
		deps
	);
}

const write = (siteId: string, state: string, blockAtViews: number | null = null) => ({
	siteId,
	state,
	blockAtViews
});
const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

describe('the budget route', () => {
	it('blocks one site and lifts another, and answers for each', async () => {
		const r = await rig();
		const res = await post(r.deps, 'budget', {
			writes: [write(A, 'over-budget'), write(B, 'active', 900)]
		});
		expect(res.status).toBe(200);
		const answer = (await res.json()) as BudgetBatchAnswer;
		expect(answer.results).toEqual([
			{ siteId: A, outcome: 'written', generation: 2 },
			{ siteId: B, outcome: 'written', generation: 2 }
		]);
		expect((await r.stubs.get(A)!.read())?.state).toBe('over-budget');
		expect((await r.stubs.get(B)!.read())?.limits.blockAtViews).toBe(900);
		const lift = await post(r.deps, 'budget', { writes: [write(A, 'active')] });
		expect(((await lift.json()) as BudgetBatchAnswer).results[0]).toMatchObject({
			outcome: 'written'
		});
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
	});

	it('reports a repeat of the same answer as unchanged', async () => {
		const r = await rig([A]);
		await post(r.deps, 'budget', { writes: [write(A, 'over-budget')] });
		const again = await post(r.deps, 'budget', { writes: [write(A, 'over-budget')] });
		expect(((await again.json()) as BudgetBatchAnswer).results).toEqual([
			{ siteId: A, outcome: 'unchanged', generation: 2 }
		]);
	});

	it('never replaces a security state with an availability state', async () => {
		const r = await rig([A]);
		const state = await authorityState({
			siteId: A,
			epoch: 1,
			generation: 2,
			state: 'suspended'
		});
		await r.stubs.get(A)!.apply(await signApply(state, NOW, r.control.privateKey));
		for (const next of ['active', 'over-budget', 'plan-grace']) {
			const res = await post(r.deps, 'budget', { writes: [write(A, next, 5)] });
			expect(((await res.json()) as BudgetBatchAnswer).results).toEqual([
				{ siteId: A, outcome: 'security-state' }
			]);
		}
		const read = await r.stubs.get(A)!.read();
		expect(read?.state).toBe('suspended');
		expect(read?.generation).toBe(2);
	});

	it('reports a site with no authority record and goes on with the rest', async () => {
		const r = await rig([A]);
		const res = await post(r.deps, 'budget', {
			writes: [write(GONE, 'over-budget'), write(A, 'over-budget')]
		});
		expect(((await res.json()) as BudgetBatchAnswer).results).toEqual([
			{ siteId: GONE, outcome: 'unknown-site' },
			{ siteId: A, outcome: 'written', generation: 2 }
		]);
	});

	it('isolates a site that throws', async () => {
		const r = await rig();
		r.broken.add(A);
		const res = await post(r.deps, 'budget', {
			writes: [write(A, 'over-budget'), write(B, 'over-budget')]
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as BudgetBatchAnswer).results).toEqual([
			{ siteId: A, outcome: 'failed' },
			{ siteId: B, outcome: 'written', generation: 2 }
		]);
	});

	it('refuses an unsigned request, a wrong secret and a stale time', async () => {
		const r = await rig();
		const body = { writes: [write(A, 'over-budget')] };
		const unsigned = await post(r.deps, 'budget', body, { drop: START_HEADERS.signature });
		expect([unsigned.status, await codeOf(unsigned)]).toEqual([401, 'unsigned']);
		const wrong = await post(r.deps, 'budget', body, { secret: 'another-secret-'.repeat(3) });
		expect([wrong.status, await codeOf(wrong)]).toEqual([401, 'bad_signature']);
		const stale = await post(r.deps, 'budget', body, { now: NOW - BATCH_WINDOW_MS - 1 });
		expect([stale.status, await codeOf(stale)]).toEqual([401, 'stale']);
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
	});

	it('refuses a replayed id, and the replay changes nothing', async () => {
		const r = await rig([A]);
		const body = { writes: [write(A, 'over-budget')] };
		expect((await post(r.deps, 'budget', body, { id: 'req_same_00001' })).status).toBe(200);
		await post(r.deps, 'budget', { writes: [write(A, 'active')] });
		const replay = await post(r.deps, 'budget', body, { id: 'req_same_00001' });
		expect([replay.status, await codeOf(replay)]).toEqual([409, 'replayed']);
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
	});

	it('claims no id for a request that failed its signature', async () => {
		const r = await rig();
		await post(
			r.deps,
			'budget',
			{ writes: [write(A, 'over-budget')] },
			{
				secret: 'another-secret-'.repeat(3),
				id: 'req_unclaimed_1'
			}
		);
		expect(r.replays.ids.size).toBe(0);
	});

	it('refuses a batch over the cap before it touches a site', async () => {
		const r = await rig();
		const writes = Array.from({ length: BATCH_MAX_SITES + 1 }, (_, i) =>
			write(`s${i}`, 'active')
		);
		const res = await post(r.deps, 'budget', { writes });
		expect([res.status, await codeOf(res)]).toEqual([413, 'too_many']);
		expect(r.replays.ids.size).toBe(0);
	});

	it('refuses a state it may not write, a wrong method and an unset secret', async () => {
		const r = await rig();
		const bad = await post(r.deps, 'budget', { writes: [write(A, 'suspended')] });
		expect([bad.status, await codeOf(bad)]).toEqual([400, 'malformed']);
		const put = await post(
			r.deps,
			'budget',
			{ writes: [write(A, 'active')] },
			{ method: 'PUT' }
		);
		expect([put.status, await codeOf(put)]).toEqual([405, 'wrong_method']);
		const open = await post({ ...r.deps, budgetSecret: undefined }, 'budget', {
			writes: [write(A, 'active')]
		});
		expect([open.status, await codeOf(open)]).toEqual([500, 'unconfigured']);
	});

	it('cannot be driven with the counts secret', async () => {
		const r = await rig();
		const res = await post(
			r.deps,
			'budget',
			{ writes: [write(A, 'over-budget')] },
			{ secret: COUNTS_SECRET }
		);
		expect(res.status).toBe(401);
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
	});
});

describe('the usage counter read', () => {
	const read = (siteId: string, hours: number[] = [], months: string[] = ['2026-11']) => ({
		siteId,
		hours,
		months
	});

	const hourOf = (siteId: string): CountedHour => ({
		siteId,
		start: new Date(NOW).toISOString(),
		end: new Date(NOW + 3_600_000).toISOString(),
		observedViews: null,
		settlement: 'open',
		issued: 3,
		batches: [{ from: 1, to: 3 }],
		accountingAvailable: true,
		origins: 1
	});

	// stands in for the dispatch namespace: `asked` records each object id read, and an id in `down` throws
	function usageNamespace(
		counters: Record<
			string,
			{ hours?: Record<number, CountedHour>; months?: Record<string, number> }
		> = {},
		down = new Set<string>()
	) {
		const asked: string[] = [];
		const namespace = {
			idFromName: (name: string) => name,
			get(id: string) {
				asked.push(id);
				const counter = counters[id] ?? {};
				return {
					async read(hour: number) {
						if (down.has(id)) throw new Error('the object is down');
						return counter.hours?.[hour] ?? null;
					},
					async month(month: string) {
						if (down.has(id)) throw new Error('the object is down');
						return counter.months?.[month] ?? 0;
					}
				};
			}
		} as unknown as Parameters<typeof usageCountsOf>[0];
		return { namespace, asked };
	}

	it('answers each site with its hour records and month totals', async () => {
		const { namespace } = usageNamespace({
			[A]: { hours: { [NOW]: hourOf(A) }, months: { '2026-11': 42 } }
		});
		const r = await rig([A, B]);
		const res = await post({ ...r.deps, counts: usageCountsOf(namespace) }, 'counts', {
			reads: [read(A, [NOW]), read(B)]
		});
		expect(((await res.json()) as CountsBatchAnswer).results).toEqual([
			{ siteId: A, ok: true, hours: [hourOf(A)], months: [{ month: '2026-11', views: 42 }] },
			{ siteId: B, ok: true, hours: [], months: [{ month: '2026-11', views: 0 }] }
		]);
	});

	it('answers a site the counter has never seen with no hour records and zero views', async () => {
		const { namespace } = usageNamespace();
		const r = await rig([A]);
		const res = await post({ ...r.deps, counts: usageCountsOf(namespace) }, 'counts', {
			reads: [read(A, [NOW])]
		});
		expect(((await res.json()) as CountsBatchAnswer).results).toEqual([
			{ siteId: A, ok: true, hours: [null], months: [{ month: '2026-11', views: 0 }] }
		]);
	});

	it('marks a counter object that throws as failed for its site and answers the rest', async () => {
		const { namespace } = usageNamespace({ [B]: { months: { '2026-11': 9 } } }, new Set([A]));
		const r = await rig([A, B]);
		const res = await post({ ...r.deps, counts: usageCountsOf(namespace) }, 'counts', {
			reads: [read(A), read(B)]
		});
		expect(((await res.json()) as CountsBatchAnswer).results).toEqual([
			{ siteId: A, ok: false },
			{ siteId: B, ok: true, hours: [], months: [{ month: '2026-11', views: 9 }] }
		]);
	});

	it('asks each site by the object id dispatch writes it under', async () => {
		const ids = [A, B, C];
		const engine = usageNamespace();
		const dispatch = usageNamespace();
		for (const siteId of ids) {
			await usageCountsOf(engine.namespace)({ siteId, hours: [], months: [] });
			counterFor(dispatch.namespace, siteId);
		}
		expect(engine.asked).toEqual(ids);
		expect(engine.asked).toEqual(dispatch.asked);
	});
});

describe('the counts route', () => {
	const read = (siteId: string, hours: number[] = [], months: string[] = ['2026-11']) => ({
		siteId,
		hours,
		months
	});

	it('reads each site through the counter and answers per site', async () => {
		const r = await rig();
		const res = await post(r.deps, 'counts', { reads: [read(A, [NOW]), read(B)] });
		expect(res.status).toBe(200);
		const answer = (await res.json()) as CountsBatchAnswer;
		expect(answer.results).toEqual([
			{ siteId: A, ok: true, hours: [null], months: [{ month: '2026-11', views: 7 }] },
			{ siteId: B, ok: true, hours: [], months: [{ month: '2026-11', views: 7 }] }
		]);
		expect(r.counted.map((c) => c.siteId)).toEqual([A, B]);
	});

	it('marks a site the counter would not answer for, and a site that throws, and goes on', async () => {
		const r = await rig();
		r.countsAnswer.set(A, null);
		r.countsAnswer.set(B, 'throw');
		const res = await post(r.deps, 'counts', {
			reads: [read(A), read(B), read(C)]
		});
		const answer = (await res.json()) as CountsBatchAnswer;
		expect(answer.results.map((x) => [x.siteId, x.ok])).toEqual([
			[A, false],
			[B, false],
			[C, true]
		]);
	});

	it('refuses a replayed id, a stale time, a wrong secret and a batch over the cap', async () => {
		const r = await rig();
		const body = { reads: [read(A)] };
		await post(r.deps, 'counts', body, { id: 'req_counts_0001' });
		const replay = await post(r.deps, 'counts', body, { id: 'req_counts_0001' });
		expect([replay.status, await codeOf(replay)]).toEqual([409, 'replayed']);
		const stale = await post(r.deps, 'counts', body, { now: NOW + BATCH_WINDOW_MS + 1 });
		expect(await codeOf(stale)).toBe('stale');
		const wrong = await post(r.deps, 'counts', body, { secret: BUDGET_SECRET });
		expect(await codeOf(wrong)).toBe('bad_signature');
		const reads = Array.from({ length: BATCH_MAX_SITES + 1 }, (_, i) => read(`s${i}`));
		expect(await codeOf(await post(r.deps, 'counts', { reads }))).toBe('too_many');
	});

	it('keeps the message types apart when both fall back to one start secret', async () => {
		const r = await rig();
		const shared = { ...r.deps, budgetSecret: START_SECRET, countsSecret: START_SECRET };
		const writeBody = JSON.stringify({ writes: [write(A, 'over-budget')] });
		const readBody = JSON.stringify({ reads: [{ siteId: A, hours: [], months: ['2026-11'] }] });
		const send = async (path: string, kind: BatchKind, body: string) => {
			const signed = await signBatch(kind, body, {
				secret: START_SECRET,
				now: NOW,
				id: newRequestId()
			});
			return handleBatch(
				new Request(`https://engine.example${path}`, {
					method: 'POST',
					headers: new Headers(signed),
					body
				}),
				shared
			);
		};
		expect((await send('/counts', 'budget', readBody)).status).toBe(401);
		expect((await send('/budget', 'counts', writeBody)).status).toBe(401);
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
		expect((await send('/budget', 'budget', writeBody)).status).toBe(200);
		expect((await r.stubs.get(A)!.read())?.state).toBe('over-budget');
	});

	it('cannot be driven with the budget secret, so a read capability never writes', async () => {
		const r = await rig();
		// a counts-secret holder signing a write body under the counts context
		const body = JSON.stringify({ writes: [write(A, 'over-budget')] });
		const signed = await signBatch('counts', body, {
			secret: COUNTS_SECRET,
			now: NOW,
			id: 'req_cross_00001'
		});
		const res = await handleBatch(
			new Request('https://engine.example/budget', {
				method: 'POST',
				headers: new Headers(signed),
				body
			}),
			r.deps
		);
		expect(res.status).toBe(401);
		expect((await r.stubs.get(A)!.read())?.state).toBe('active');
	});
});
