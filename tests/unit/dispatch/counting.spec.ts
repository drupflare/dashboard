import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKey, siteId } from '../../../contracts/src/common';
import { APPLY_MAX_AGE_MS, signApply } from '../../../dispatch/src/authority';
import {
	HOUR_MS,
	MAX_ORIGINS,
	MECHANISMS,
	addRange,
	applyIn,
	createAccounting,
	hourOf,
	isView,
	mechanism,
	mergeRanges,
	overlap,
	readHourIn,
	removeRange,
	sizeOf,
	type ApplyAnswer,
	type CountWrite,
	type CountingOptions,
	type MechanismName,
	type Range
} from '../../../dispatch/src/counting';
import {
	allocatePastLimit,
	createSpike,
	parseMechanism,
	randomOrigin,
	signSpike,
	verifySpike,
	type SpikeBody
} from '../../../dispatch/src/spike';
import { closeInterval, type OpenInterval } from '../../../src/server/domain/usage-ledger';
import { authorityState, counterDouble, fakeClock, makeRig, memoryKv } from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const SITE = 'site_countspec0001';
const HOUR0 = Date.UTC(2026, 10, 6, 12);
const HTML = 'text/html; charset=utf-8';

function permutations<T>(items: T[]): T[][] {
	if (items.length <= 1) return [items];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
	);
}

// #region ranges

describe('ranges', () => {
	const parts: Range[] = [
		{ from: 1, to: 3 },
		{ from: 4, to: 4 },
		{ from: 8, to: 10 },
		{ from: 9, to: 12 },
		{ from: 20, to: 21 }
	];

	it('merge to the same ranges in every arrival order', () => {
		const expected = [
			{ from: 1, to: 4 },
			{ from: 8, to: 12 },
			{ from: 20, to: 21 }
		];
		for (const order of permutations(parts)) expect(mergeRanges(order)).toEqual(expected);
	});

	it('keep a hole between ranges that are not adjacent', () => {
		expect(
			mergeRanges([
				{ from: 1, to: 2 },
				{ from: 4, to: 5 }
			])
		).toHaveLength(2);
		expect(addRange([{ from: 1, to: 2 }], { from: 3, to: 5 })).toEqual([{ from: 1, to: 5 }]);
	});

	it('cut, size and intersect', () => {
		expect(removeRange([{ from: 1, to: 10 }], { from: 4, to: 6 })).toEqual([
			{ from: 1, to: 3 },
			{ from: 7, to: 10 }
		]);
		expect(removeRange([{ from: 1, to: 3 }], { from: 5, to: 6 })).toEqual([{ from: 1, to: 3 }]);
		expect(removeRange([{ from: 1, to: 3 }], { from: 1, to: 3 })).toEqual([]);
		expect(sizeOf(mergeRanges(parts))).toBe(4 + 5 + 2);
		expect(
			overlap(
				[
					{ from: 1, to: 5 },
					{ from: 8, to: 9 }
				],
				{ from: 4, to: 8 }
			)
		).toBe(3);
	});
});

describe('isView', () => {
	it('counts a 2xx text/html response, whatever its parameters or case', () => {
		expect(isView(200, 'text/html')).toBe(true);
		expect(isView(299, 'TEXT/HTML; charset=utf-8')).toBe(true);
	});

	it('refuses other statuses and other content types', () => {
		for (const status of [100, 199, 300, 304, 404, 500]) {
			expect(isView(status, 'text/html')).toBe(false);
		}
		for (const type of [null, '', 'application/json', 'text/htmlx', 'text/plain']) {
			expect(isView(200, type)).toBe(false);
		}
	});
});

// #endregion

// #region rig

type Plan = {
	fail?: (attempt: number, write: CountWrite) => boolean;
	failAfterApply?: (attempt: number) => boolean;
	replay?: boolean;
	options?: Partial<CountingOptions>;
	limit?: number | null;
	origin?: string;
};

// one isolate counting one site against a real counter store, with a fake clock
function rig(name: MechanismName, plan: Plan = {}) {
	const kv = memoryKv();
	const clock = fakeClock(HOUR0 + 1000);
	const options = { batchSize: 2, flushMs: 1000, maxAttempts: 3, ...plan.options };
	const sent: CountWrite[] = [];
	const answers: ApplyAnswer[] = [];
	const replays: ApplyAnswer[] = [];
	const pending: Promise<unknown>[] = [];
	let attempts = 0;
	const send = async (write: CountWrite): Promise<ApplyAnswer> => {
		const attempt = attempts++;
		sent.push(structuredClone(write));
		if (plan.fail?.(attempt, write)) throw new Error('counter down');
		const answer = applyIn(kv, write, clock.now(), SITE);
		answers.push(answer);
		if (plan.replay) replays.push(applyIn(kv, write, clock.now(), SITE));
		if (plan.failAfterApply?.(attempt)) throw new Error('ack lost');
		return answer;
	};
	const accounting = createAccounting({
		counting: mechanism(name, options),
		origin: plan.origin ?? 'originone01',
		now: clock.now,
		send,
		waitUntil: (promise) => void pending.push(promise),
		timeoutMs: 50
	});
	const drain = async () => void (await Promise.all(pending.splice(0)));
	const view = (status = 200, contentType: string | null = HTML) =>
		accounting.count({ siteId: SITE, status, contentType, limit: plan.limit ?? null });
	return {
		kv,
		clock,
		sent,
		answers,
		replays,
		accounting,
		async views(n: number, stepMs = 100) {
			for (let i = 0; i < n; i++) {
				clock.advance(stepMs);
				await view();
				await drain();
			}
		},
		view,
		drain,
		async settle() {
			for (let i = 0; i < 8; i++) {
				clock.advance(options.flushMs + 1);
				accounting.tick();
				await drain();
			}
		},
		dropped: () => [...accounting.state().entries.values()].reduce((n, e) => n + e.dropped, 0),
		hour: () => readHourIn(kv, SITE, HOUR0),
		closed() {
			const hour = readHourIn(kv, SITE, HOUR0);
			if (!hour) throw new Error('no row for the hour');
			const open: OpenInterval = { ...hour, siteId: siteId.parse(hour.siteId) };
			const result = closeInterval(open, HOUR0 + HOUR_MS);
			if (!result.ok) throw new Error(result.reason);
			return result.interval;
		}
	};
}

// #endregion

describe.each(MECHANISMS)('%s', (name) => {
	it('applies every counted view once when each batch is replayed', async () => {
		const r = rig(name, { replay: true });
		await r.views(37);
		await r.settle();
		const first = r.answers.reduce((n, a) => n + (a.ok ? a.applied : 0), 0);
		const again = r.replays.reduce((n, a) => n + (a.ok ? a.applied : 0), 0);
		expect(first).toBe(37);
		expect(again).toBe(0);
		expect(r.closed()).toMatchObject({ accuracy: 'exact', views: 37, lowerBound: 37 });
	});

	it('resends a batch whose acknowledgement was lost without counting it twice', async () => {
		const r = rig(name, { failAfterApply: (n) => n % 2 === 0 });
		await r.views(25);
		await r.settle();
		expect(r.closed()).toMatchObject({ accuracy: 'exact', views: 25, lowerBound: 25 });
		const applied = r.answers.reduce((n, a) => n + (a.ok ? a.applied : 0), 0);
		expect(applied).toBe(25);
		expect(r.answers.some((a) => a.ok && a.duplicate > 0)).toBe(true);
	});

	it('shows a batch that was given up as a gap, never as a duplicate', async () => {
		const r = rig(name, { fail: (n) => n >= 1 && n <= 3 });
		await r.views(12);
		await r.settle();
		const closed = r.closed();
		expect(r.dropped()).toBeGreaterThan(0);
		expect(closed.accuracy).toBe('estimated');
		expect(closed.views).toBe(12);
		expect(closed.lowerBound + r.dropped()).toBe(12);
		const applied = r.answers.reduce((n, a) => n + (a.ok ? a.applied : 0), 0);
		expect(applied).toBe(closed.lowerBound);
	});

	it('serves through a failed counter and marks the hour unaccounted once the report lands', async () => {
		const r = rig(name, { options: { batchSize: 1 }, fail: (n) => n < 3 });
		for (let i = 0; i < 3; i++) {
			r.clock.advance(100);
			await expect(r.view()).resolves.toBeUndefined();
			await r.drain();
		}
		expect(r.hour()).toBeNull();
		await r.settle();
		expect(r.hour()).toMatchObject({ issued: 3, accountingAvailable: false });
		expect(r.closed()).toMatchObject({ accuracy: 'unaccounted', views: 0, lowerBound: 0 });
	});

	it('does not reject when the counter throws at once or never answers', async () => {
		for (const send of [
			() => {
				throw new Error('sync');
			},
			() => new Promise<ApplyAnswer>(() => {})
		]) {
			const waits: Promise<unknown>[] = [];
			const accounting = createAccounting({
				counting: mechanism(name, { batchSize: 1 }),
				origin: 'originone01',
				now: () => HOUR0 + 1000,
				send,
				waitUntil: (p) => void waits.push(p),
				timeoutMs: 5
			});
			await expect(
				accounting.count({ siteId: SITE, status: 200, contentType: HTML })
			).resolves.toBeUndefined();
			await expect(Promise.all(waits)).resolves.toBeDefined();
		}
	});

	it('treats a typed refusal from the counter as a failure and keeps serving', async () => {
		const accounting = createAccounting({
			counting: mechanism(name, { batchSize: 1 }),
			origin: 'originone01',
			now: () => HOUR0 + 1000,
			send: async () => ({ ok: false, reason: 'too_many_origins' }),
			waitUntil: () => {}
		});
		await expect(
			accounting.count({ siteId: SITE, status: 200, contentType: HTML })
		).resolves.toBeUndefined();
		expect([...accounting.state().entries.values()][0]?.unavailable).toBe(true);
	});

	it('never counts a non-2xx or non-html response', async () => {
		const r = rig(name, { options: { batchSize: 1 } });
		for (const [status, type] of [
			[301, HTML],
			[404, HTML],
			[500, HTML],
			[200, 'application/json'],
			[200, null],
			[304, 'text/html']
		] as const) {
			r.clock.advance(100);
			await r.view(status, type);
		}
		await r.settle();
		expect(r.sent).toHaveLength(0);
		expect(r.hour()).toBeNull();
		await r.view(200, HTML);
		await r.settle();
		expect(r.hour()).toMatchObject({ issued: 1 });
	});

	it('leaves views invisible to the counter until a flush, and flushes when the hour ends', async () => {
		const r = rig(name, { options: { batchSize: 50, flushMs: 10 * HOUR_MS } });
		await r.views(3);
		if (name === 'write-through') expect(r.hour()).toMatchObject({ issued: 3 });
		else expect(r.hour()).toBeNull();
		r.clock.set(HOUR0 + HOUR_MS + 1);
		r.accounting.tick();
		await r.drain();
		expect(r.closed()).toMatchObject({ accuracy: 'exact', views: 3 });
	});

	it('forgets an hour only after it has ended, flushed and aged', async () => {
		const r = rig(name);
		await r.views(2);
		await r.settle();
		expect(r.accounting.state().entries.size).toBe(1);
		r.clock.set(HOUR0 + 2 * HOUR_MS + 1);
		r.accounting.tick();
		await r.drain();
		expect(r.accounting.state().entries.size).toBe(0);
	});
});

describe('when each mechanism asks for an acknowledged write', () => {
	const view = (at: number, limit: number | null, siteIdValue = SITE) => ({
		kind: 'view' as const,
		siteId: siteIdValue,
		at,
		status: 200,
		contentType: HTML,
		limit
	});

	function drive(name: MechanismName, limit: number | null, others = 0) {
		const counting = mechanism(name, { batchSize: 1000, flushMs: 10 * HOUR_MS });
		let state = counting.init('originone01');
		const sync: boolean[] = [];
		for (let n = 1; n <= 8; n++) {
			const out = counting.step(state, view(HOUR0 + n, limit));
			state = out.state;
			sync.push(out.writes.some((w) => w.sync));
			for (const w of out.writes) {
				const total = others + n;
				state = counting.step(state, {
					kind: 'ack',
					siteId: SITE,
					hour: w.hour,
					ranges: w.ranges,
					total
				}).state;
			}
		}
		return sync;
	}

	it('write-through always does and batched never does', () => {
		expect(drive('write-through', null)).toEqual(Array(8).fill(true));
		expect(drive('batched', 3)).toEqual(Array(8).fill(false));
	});

	it('hybrid learns the total on the first view, batches below the limit and writes through from it', () => {
		// view 1 learns the total; views 2 to 4 batch; view 5 reaches the limit of 5 and every view after it writes through
		expect(drive('hybrid', 5)).toEqual([true, false, false, false, true, true, true, true]);
	});

	it('hybrid counts views the other isolates added, as the last acknowledgement reported them', () => {
		expect(drive('hybrid', 5, 2)).toEqual([true, false, true, true, true, true, true, true]);
	});

	it('hybrid never writes through for a site with no limit, after the first view', () => {
		expect(drive('hybrid', null)).toEqual(Array(8).fill(false));
	});

	it('hybrid sends the whole pending tail with the write that reaches the limit', () => {
		const counting = mechanism('hybrid', { batchSize: 1000, flushMs: 10 * HOUR_MS });
		let state = counting.init('originone01');
		let last: CountWrite | undefined;
		for (let n = 1; n <= 5; n++) {
			const out = counting.step(state, view(HOUR0 + n, 5));
			state = out.state;
			for (const w of out.writes) {
				last = w;
				state = counting.step(state, {
					kind: 'ack',
					siteId: SITE,
					hour: w.hour,
					ranges: w.ranges,
					total: n
				}).state;
			}
		}
		expect(last).toMatchObject({ sync: true, ranges: [{ from: 2, to: 5 }], issued: 5 });
	});

	it('batched flushes on size and on time', () => {
		const counting = mechanism('batched', { batchSize: 3, flushMs: 1000 });
		let state = counting.init('originone01');
		const writes: CountWrite[] = [];
		const feed = (at: number) => {
			const out = counting.step(state, view(HOUR0 + at, null));
			state = out.state;
			writes.push(...out.writes);
		};
		feed(1);
		feed(2);
		expect(writes).toHaveLength(0);
		feed(3);
		expect(writes.map((w) => w.ranges)).toEqual([[{ from: 1, to: 3 }]]);
		feed(4);
		feed(1500);
		expect(writes.map((w) => w.ranges)).toEqual([[{ from: 1, to: 3 }], [{ from: 4, to: 5 }]]);
		expect(writes.every((w) => !w.sync)).toBe(true);
	});

	it('merges acknowledgements that arrive out of order', () => {
		const counting = mechanism('write-through');
		let state = counting.init('originone01');
		const writes: CountWrite[] = [];
		for (let n = 1; n <= 4; n++) {
			const out = counting.step(state, view(HOUR0 + n, null));
			state = out.state;
			writes.push(...out.writes);
		}
		for (const order of permutations(writes)) {
			let s = counting.init('originone01');
			for (let n = 1; n <= 4; n++) s = counting.step(s, view(HOUR0 + n, null)).state;
			for (const w of order) {
				s = counting.step(s, {
					kind: 'ack',
					siteId: SITE,
					hour: w.hour,
					ranges: w.ranges,
					total: 4
				}).state;
			}
			expect([...s.entries.values()][0]?.acked).toEqual([{ from: 1, to: 4 }]);
		}
	});
});

describe('the counter', () => {
	const write = (patch: Partial<CountWrite> = {}): CountWrite => ({
		siteId: SITE,
		hour: HOUR0,
		origin: 'originone01',
		ranges: [{ from: 1, to: 10 }],
		issued: 10,
		unavailable: false,
		sync: false,
		...patch
	});
	const NOW = HOUR0 + 5000;

	it('changes nothing when a batch repeats', () => {
		const kv = memoryKv();
		const puts: string[] = [];
		const logged = {
			get: kv.get,
			put: (k: string, v: unknown) => (puts.push(k), kv.put(k, v))
		};
		expect(applyIn(logged, write(), NOW, SITE)).toEqual({
			ok: true,
			applied: 10,
			duplicate: 0,
			total: 10
		});
		const before = puts.length;
		const snapshot = structuredClone(readHourIn(kv, SITE, HOUR0));
		expect(applyIn(logged, write(), NOW, SITE)).toEqual({
			ok: true,
			applied: 0,
			duplicate: 10,
			total: 10
		});
		expect(puts).toHaveLength(before);
		expect(readHourIn(kv, SITE, HOUR0)).toEqual(snapshot);
	});

	it('counts only the part of an overlapping batch it has not seen', () => {
		const kv = memoryKv();
		applyIn(kv, write(), NOW);
		const answer = applyIn(kv, write({ ranges: [{ from: 8, to: 14 }], issued: 14 }), NOW);
		expect(answer).toEqual({ ok: true, applied: 4, duplicate: 3, total: 14 });
	});

	it('ends in the same row for every arrival order of the same batches', () => {
		const batches = [
			write({ ranges: [{ from: 1, to: 3 }], issued: 3 }),
			write({ ranges: [{ from: 4, to: 6 }], issued: 6 }),
			write({ ranges: [{ from: 9, to: 9 }], issued: 9 }),
			write({ ranges: [{ from: 2, to: 5 }], issued: 5 })
		];
		const rows = permutations(batches).map((order) => {
			const kv = memoryKv();
			for (const b of order) applyIn(kv, b, NOW);
			return readHourIn(kv, SITE, HOUR0);
		});
		for (const row of rows) expect(row).toEqual(rows[0]);
		expect(rows[0]).toMatchObject({
			issued: 9,
			batches: [
				{ from: 1, to: 6 },
				{ from: 9, to: 9 }
			]
		});
	});

	it('keeps one row per hour and one running total per month', () => {
		const kv = memoryKv();
		applyIn(kv, write(), NOW);
		const next = applyIn(
			kv,
			write({ hour: HOUR0 + HOUR_MS, ranges: [{ from: 1, to: 5 }], issued: 5 }),
			HOUR0 + HOUR_MS + 5000
		);
		expect(next).toMatchObject({ ok: true, applied: 5, total: 15 });
		expect(readHourIn(kv, SITE, HOUR0)).toMatchObject({ issued: 10 });
		expect(readHourIn(kv, SITE, HOUR0 + HOUR_MS)).toMatchObject({ issued: 5 });
		expect(readHourIn(kv, SITE, HOUR0 + 2 * HOUR_MS)).toBeNull();
	});

	it('produces the shape the usage ledger closes, across isolates', () => {
		const kv = memoryKv();
		applyIn(
			kv,
			write({ origin: 'originaaaa', ranges: [{ from: 1, to: 10 }], issued: 10 }),
			NOW
		);
		applyIn(kv, write({ origin: 'originbbbb', ranges: [{ from: 1, to: 3 }], issued: 5 }), NOW);
		const hour = readHourIn(kv, SITE, HOUR0);
		expect(hour).toMatchObject({
			issued: 15,
			batches: [{ from: 1, to: 13 }],
			accountingAvailable: true,
			observedViews: null,
			start: '2026-11-06T12:00:00.000Z',
			end: '2026-11-06T13:00:00.000Z'
		});
		const open: OpenInterval = { ...hour!, siteId: siteId.parse(SITE) };
		const closed = closeInterval(open, HOUR0 + HOUR_MS);
		expect(closed).toMatchObject({
			ok: true,
			interval: { accuracy: 'estimated', views: 15, lowerBound: 13, settlement: 'closed' }
		});
	});

	it('reports an hour as exact when every issued view was acknowledged', () => {
		const kv = memoryKv();
		applyIn(kv, write({ origin: 'originaaaa' }), NOW);
		applyIn(kv, write({ origin: 'originbbbb', ranges: [{ from: 1, to: 5 }], issued: 5 }), NOW);
		const open: OpenInterval = { ...readHourIn(kv, SITE, HOUR0)!, siteId: siteId.parse(SITE) };
		expect(closeInterval(open, HOUR0 + HOUR_MS)).toMatchObject({
			ok: true,
			interval: { accuracy: 'exact', views: 15, lowerBound: 15 }
		});
	});

	it('marks an hour unaccounted only when it holds a flag and no acknowledged view', () => {
		const kv = memoryKv();
		applyIn(kv, write({ ranges: [], issued: 4, unavailable: true }), NOW);
		expect(readHourIn(kv, SITE, HOUR0)).toMatchObject({
			issued: 4,
			accountingAvailable: false
		});
		applyIn(kv, write({ origin: 'originbbbb', ranges: [{ from: 1, to: 2 }], issued: 2 }), NOW);
		expect(readHourIn(kv, SITE, HOUR0)).toMatchObject({ accountingAvailable: true });
	});

	it('refuses each malformed write with a typed reason', () => {
		const kv = memoryKv();
		const bad = (patch: Partial<CountWrite>) => applyIn(kv, write(patch), NOW, SITE);
		const expected = { ok: false, reason: 'bad_write' };
		expect(bad({ siteId: '' })).toEqual(expected);
		expect(bad({ origin: '__proto__' })).toEqual(expected);
		expect(bad({ origin: 'UPPERCASE01' })).toEqual(expected);
		expect(bad({ ranges: [{ from: 0, to: 3 }] })).toEqual(expected);
		expect(bad({ ranges: [{ from: 5, to: 3 }] })).toEqual(expected);
		expect(bad({ ranges: [{ from: 1.5, to: 3 }] })).toEqual(expected);
		expect(bad({ issued: 9 })).toEqual(expected);
		expect(bad({ issued: -1, ranges: [] })).toEqual(expected);
		expect(bad({ unavailable: 'yes' as never })).toEqual(expected);
		expect(bad({ ranges: 'x' as never })).toEqual(expected);
		expect(applyIn(kv, null as never, NOW)).toEqual(expected);
		expect(readHourIn(kv, SITE, HOUR0)).toBeNull();
	});

	it('refuses a write for another site', () => {
		expect(applyIn(memoryKv(), write({ siteId: 'site_other000001' }), NOW, SITE)).toEqual({
			ok: false,
			reason: 'wrong_site'
		});
	});

	it('refuses an hour that is not whole, negative or too far ahead', () => {
		const kv = memoryKv();
		const refused = { ok: false, reason: 'bad_hour' };
		expect(applyIn(kv, write({ hour: HOUR0 + 1 }), NOW)).toEqual(refused);
		expect(applyIn(kv, write({ hour: -HOUR_MS }), NOW)).toEqual(refused);
		expect(applyIn(kv, write({ hour: HOUR0 + 2 * HOUR_MS }), NOW)).toEqual(refused);
		expect(applyIn(kv, write({ hour: HOUR0 + HOUR_MS }), NOW)).toMatchObject({ ok: true });
	});

	it('refuses an origin past the cap, and still takes writes from the origins it holds', () => {
		const kv = memoryKv();
		const name = (i: number) => `origin${String(i).padStart(4, '0')}`;
		for (let i = 0; i < MAX_ORIGINS; i++) {
			expect(applyIn(kv, write({ origin: name(i) }), NOW)).toMatchObject({ ok: true });
		}
		expect(applyIn(kv, write({ origin: name(MAX_ORIGINS) }), NOW)).toEqual({
			ok: false,
			reason: 'too_many_origins'
		});
		expect(applyIn(kv, write({ origin: name(0) }), NOW)).toMatchObject({
			ok: true,
			applied: 0
		});
	});

	it('takes the hour from a clock a little ahead and puts it in the right month', () => {
		const kv = memoryKv();
		const lastHour = Date.UTC(2026, 10, 30, 23);
		applyIn(kv, write({ hour: lastHour }), lastHour + 1000);
		const first = Date.UTC(2026, 11, 1, 0);
		const answer = applyIn(kv, write({ hour: first }), first + 1000);
		expect(answer).toMatchObject({ ok: true, total: 10 });
		expect(hourOf(first + 5)).toBe(first);
	});
});

describe('counterFor', () => {
	it('asks the namespace for the object named by the site id', async () => {
		const { counterFor } = await import('../../../dispatch/src/usage');
		const names: string[] = [];
		const stub = {
			apply: async () => ({ ok: true as const, applied: 0, duplicate: 0, total: 0 })
		};
		const client = counterFor(
			{
				idFromName: (name) => (names.push(name), `id:${name}`),
				get: (id) => (id === `id:${SITE}` ? stub : null)
			},
			SITE
		);
		expect(names).toEqual([SITE]);
		expect(client).toBe(stub);
	});
});

describe('the UsageCounter object', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(HOUR0 + 5000);
	});
	afterEach(() => vi.useRealTimers());

	async function make() {
		const { UsageCounter } = await import('../../../dispatch/src/counter');
		const kv = memoryKv();
		return {
			kv,
			counter: new UsageCounter({ id: { name: SITE }, storage: { kv } } as never, {})
		};
	}
	const write = (patch: Partial<CountWrite> = {}): CountWrite => ({
		siteId: SITE,
		hour: HOUR0,
		origin: 'originone01',
		ranges: [{ from: 1, to: 6 }],
		issued: 6,
		unavailable: false,
		sync: true,
		...patch
	});

	it('applies, reads and counts its own calls', async () => {
		const { counter } = await make();
		expect(counter.apply(write())).toMatchObject({ ok: true, applied: 6, total: 6 });
		expect(counter.apply(write())).toMatchObject({ ok: true, applied: 0, duplicate: 6 });
		expect(counter.apply(write({ siteId: 'site_other000001' }))).toMatchObject({ ok: false });
		expect(counter.read(HOUR0)).toMatchObject({ siteId: SITE, issued: 6 });
		expect(counter.read(HOUR0 + HOUR_MS)).toBeNull();
		expect(counter.counts()).toMatchObject({
			since: HOUR0 + 5000,
			calls: 3,
			refused: 1,
			puts: 2,
			appliedViews: 6,
			duplicateViews: 6
		});
	});
});

// #region the stage switch and mechanism per site

describe('mechanism per site', () => {
	it('reads the three names and treats anything else as off', () => {
		for (const name of MECHANISMS) expect(parseMechanism(name)).toBe(name);
		for (const bad of [null, '', 'off', 'Hybrid', 'hybrid ', 'write_through', '1']) {
			expect(parseMechanism(bad)).toBeNull();
		}
	});

	it('makes an origin id of lowercase letters and digits, a new one each time', () => {
		const ids = new Set(Array.from({ length: 20 }, randomOrigin));
		expect(ids.size).toBe(20);
		for (const id of ids) expect(id).toMatch(/^[0-9a-z]{8,32}$/);
	});

	it('allocates in chunks up to a cap and reports what it reached', () => {
		expect(allocatePastLimit(1, 4)).toBe(4);
		expect(allocatePastLimit(2, 5)).toBe(6);
	});
});

describe('createSpike', () => {
	function make(options: Partial<CountingOptions> = {}) {
		const clock = fakeClock(HOUR0 + 1000);
		const counter = counterDouble(clock.now);
		const gates: (() => void)[] = [];
		const bound: Promise<unknown>[] = [];
		const lookups: string[] = [];
		const store = new Map<string, string | Error>();
		const spike = createSpike({
			controlKey: 'unused',
			origin: 'isolateone01',
			now: clock.now,
			sleep: () => new Promise<void>((resolve) => void gates.push(resolve)),
			readMechanism: async (id) => {
				lookups.push(id);
				const value = store.get(id) ?? null;
				if (value instanceof Error) throw value;
				return value;
			},
			counter: counter.stub,
			evict: () => 0,
			options: { flushMs: 1000, ...options }
		});
		spike.bind((promise) => void bound.push(promise));
		const view = (id = SITE) => ({ siteId: id, status: 200, contentType: HTML, limit: null });
		const wake = async () => {
			gates.shift()?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		};
		return { clock, counter, gates, bound, lookups, store, spike, view, wake };
	}

	it('looks a site up once and keeps a bad value as off', async () => {
		const m = make();
		m.store.set(SITE, 'not-a-mechanism');
		expect(await m.spike.mechanismFor(SITE)).toBeNull();
		m.store.set(SITE, 'hybrid');
		expect(await m.spike.mechanismFor(SITE)).toBeNull();
		expect(m.lookups).toEqual([SITE]);
		m.store.set('site_other0000001', 'batched');
		expect(await m.spike.mechanismFor('site_other0000001')).toBe('batched');
	});

	it('does not keep a failed lookup', async () => {
		const m = make();
		m.store.set(SITE, new Error('kv down'));
		expect(await m.spike.mechanismFor(SITE)).toBeNull();
		m.store.set(SITE, 'hybrid');
		expect(await m.spike.mechanismFor(SITE)).toBe('hybrid');
		expect(m.lookups).toEqual([SITE, SITE]);
	});

	it('sends every mechanism under the isolate origin id', async () => {
		const m = make({ batchSize: 1 });
		await m.spike.count('write-through', m.view('site_aaaaaaaa0001'));
		await m.spike.count('batched', m.view('site_bbbbbbbb0002'));
		await m.spike.count('hybrid', m.view('site_cccccccc0003'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(m.counter.applies.map((w) => w.origin)).toEqual([
			'isolateone01',
			'isolateone01',
			'isolateone01'
		]);
	});

	it('keeps one timer for the isolate and flushes a small batch when it fires', async () => {
		const m = make();
		for (let i = 0; i < 3; i++) await m.spike.count('batched', m.view());
		expect(m.counter.applies).toHaveLength(0);
		expect(m.bound).toHaveLength(1);
		m.clock.advance(1001);
		await m.wake();
		expect(m.counter.applies.map((w) => w.ranges)).toEqual([[{ from: 1, to: 3 }]]);
		await m.wake();
		await m.bound[0];
		expect(m.gates).toHaveLength(0);
	});

	it('flushes again on the next cycle after a failed tail write', async () => {
		const m = make();
		await m.spike.count('batched', m.view());
		m.counter.mode.fail = true;
		m.clock.advance(1001);
		await m.wake();
		expect(m.counter.applies).toHaveLength(1);
		m.counter.mode.fail = false;
		m.clock.advance(1001);
		await m.wake();
		expect(m.counter.applies).toHaveLength(2);
		await m.wake();
		await m.bound[0];
		expect(m.counter.applies[1]?.ranges).toEqual([{ from: 1, to: 1 }]);
	});

	it('never rejects when the counter fails', async () => {
		const m = make();
		m.counter.mode.fail = true;
		await expect(m.spike.count('write-through', m.view())).resolves.toBeUndefined();
	});

	it('reads the counter row for each hour asked, null where there is none', async () => {
		const m = make();
		await m.spike.count('write-through', m.view());
		const out = await m.spike.counts(SITE, [HOUR0, HOUR0 + HOUR_MS]);
		expect(out.hours[0]).toMatchObject({ issued: 1, origins: 1 });
		expect(out.hours[1]).toBeNull();
		expect(out.counts.calls).toBe(1);
	});
});

describe('signed stage requests', () => {
	const NOW = 1_790_000_000_000;

	it('round-trips a signed message and refuses a wrong key, a stale time and a changed body', async () => {
		const key = await generateSigningKey();
		const other = await generateSigningKey();
		const body = { op: 'counts' as const, siteId: SITE, hours: [HOUR0] };
		const message = await signSpike(body, NOW, key.privateKey);
		expect(await verifySpike(message, key.publicKey, NOW)).toEqual({
			ok: true,
			value: message
		});
		expect(await verifySpike(message, other.publicKey, NOW)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		expect(
			await verifySpike({ ...message, hours: [HOUR0 + HOUR_MS] }, key.publicKey, NOW)
		).toEqual({ ok: false, code: 'bad_signature' });
		expect(await verifySpike(message, key.publicKey, NOW + APPLY_MAX_AGE_MS)).toMatchObject({
			ok: true
		});
		expect(await verifySpike(message, key.publicKey, NOW + APPLY_MAX_AGE_MS + 1)).toEqual({
			ok: false,
			code: 'stale_message'
		});
		expect(await verifySpike(message, key.publicKey, NOW - APPLY_MAX_AGE_MS - 1)).toEqual({
			ok: false,
			code: 'stale_message'
		});
	});

	it('refuses a body the schema does not allow', async () => {
		const key = await generateSigningKey();
		const good = await signSpike({ op: 'evict' }, NOW, key.privateKey);
		for (const bad of [
			null,
			'text',
			{},
			{ ...good, op: 'other' },
			{ ...good, extra: 1 },
			{ ...good, v: 2 },
			{ ...good, sig: 'short' },
			{ v: 1, op: 'counts', iat: NOW, sig: good.sig, siteId: SITE },
			{
				v: 1,
				op: 'counts',
				iat: NOW,
				sig: good.sig,
				siteId: SITE,
				hours: new Array(49).fill(0)
			}
		]) {
			expect(await verifySpike(bad, key.publicKey, NOW)).toEqual({
				ok: false,
				code: 'malformed'
			});
		}
	});

	it('does not accept an apply write signed with the same key', async () => {
		const key = await generateSigningKey();
		const apply = await signApply(await authorityState(), NOW, key.privateKey);
		expect(await verifySpike(apply, key.publicKey, NOW)).toMatchObject({ ok: false });
	});
});

describe('the Worker entry', () => {
	const HOST = 'calm-river-stone.drupflare.app';
	const CONTROL = 'control.drupflare.test';

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	});
	afterEach(() => vi.useRealTimers());

	type EntryWorker = { fetch(request: Request, env: never, ctx: never): Promise<Response> };

	async function worker(mode: string | undefined, mech?: string) {
		vi.resetModules();
		// a variable path keeps the worker-only types out of the unit project
		const entryPath = '../../../dispatch/src/index';
		const { default: entry } = (await import(/* @vite-ignore */ entryPath)) as {
			default: EntryWorker;
		};
		const rig = await makeRig();
		const state = await authorityState();
		await rig.commit(state);
		vi.setSystemTime(rig.clock.now());
		const data = new Map<string, string>([
			[
				HOST,
				JSON.stringify({ v: 1, siteId: state.siteId, script: 'tenant', epoch: state.epoch })
			]
		]);
		if (mech) data.set(`mech:${state.siteId}`, mech);
		const reads: string[] = [];
		const touched: string[] = [];
		const counter = counterDouble(Date.now);
		const env = {
			HOSTS_KV: {
				get: async (key: string) => (reads.push(key), data.get(key) ?? null)
			},
			SITE_AUTH: { idFromName: (name: string) => name, get: () => rig.client },
			USAGE_COUNTER: {
				idFromName: (name: string) => name,
				get: (id: string) => (touched.push(id), counter.stub(id))
			},
			DISPATCH: {
				get: () => ({
					fetch: async () => new Response('ok', { headers: { 'content-type': HTML } })
				})
			},
			LEASE_PUBLIC_KEY: rig.lease.publicKey,
			CONTROL_PUBLIC_KEY: rig.control.publicKey,
			CONTROL_HOST: CONTROL,
			SPIKE_MODE: mode
		};
		const ctx = { waitUntil: () => undefined };
		const call = (request: Request) => entry.fetch(request, env as never, ctx as never);
		const signed = async (body: SpikeBody) =>
			call(
				new Request(`https://${CONTROL}/__spike/${body.op}`, {
					method: 'POST',
					body: JSON.stringify(await signSpike(body, Date.now(), rig.control.privateKey))
				})
			);
		return { state, reads, touched, counter, call, signed };
	}

	it.each([undefined, '', '0', 'true', 'yes'])(
		'with the switch at %j nothing counts, no mechanism is read and no spike route exists',
		async (mode) => {
			const w = await worker(mode, 'write-through');
			const response = await w.call(new Request(`https://${HOST}/`));
			expect(response.status).toBe(200);
			expect(w.reads).toEqual([HOST]);
			const unknown = await w.call(new Request('https://nobody.drupflare.app/'));
			const counts = await w.signed({ op: 'counts', siteId: w.state.siteId, hours: [HOUR0] });
			expect(counts.status).toBe(unknown.status);
			expect(await counts.text()).toBe(await unknown.text());
			const evict = await w.call(
				new Request(`https://${CONTROL}/__spike/evict`, { method: 'POST', body: '{}' })
			);
			expect(evict.status).toBe(404);
			expect(w.touched).toEqual([]);
			expect(w.counter.applies).toHaveLength(0);
		}
	);

	it("with the switch at '1' it reads the mechanism, counts and answers a signed read", async () => {
		const w = await worker('1', 'write-through');
		expect((await w.call(new Request(`https://${HOST}/`))).status).toBe(200);
		expect(w.reads).toEqual([HOST, `mech:${w.state.siteId}`]);
		expect(w.counter.applies).toHaveLength(1);
		const hour = hourOf(Date.now());
		const response = await w.signed({ op: 'counts', siteId: w.state.siteId, hours: [hour] });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			counts: { calls: 1 },
			hours: [{ issued: 1 }]
		});
	});

	it("with the switch at '1' a site with no mechanism is served and not counted", async () => {
		const w = await worker('1');
		expect((await w.call(new Request(`https://${HOST}/`))).status).toBe(200);
		expect(w.counter.applies).toHaveLength(0);
	});

	it("with the switch at '1' an unsigned request is still refused", async () => {
		const w = await worker('1', 'write-through');
		const response = await w.call(
			new Request(`https://${CONTROL}/__spike/counts`, { method: 'POST', body: '{}' })
		);
		expect(response.status).toBe(400);
		expect(w.touched).toEqual([]);
	});
});

// #endregion
