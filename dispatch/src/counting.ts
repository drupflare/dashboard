import type { SyncKv } from './storage';

export const HOUR_MS = 3_600_000;

export const hourOf = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

// #region ranges

// inclusive view sequence numbers
export type Range = { from: number; to: number };

// ranges stay sorted, disjoint and non-adjacent
export function addRange(ranges: readonly Range[], add: Range): Range[] {
	const out: Range[] = [];
	let cur = { ...add };
	let placed = false;
	for (const r of ranges) {
		if (r.to + 1 < cur.from) out.push(r);
		else if (cur.to + 1 < r.from) {
			if (!placed) out.push(cur);
			placed = true;
			out.push(r);
		} else cur = { from: Math.min(cur.from, r.from), to: Math.max(cur.to, r.to) };
	}
	if (!placed) out.push(cur);
	return out;
}

export const mergeRanges = (ranges: readonly Range[]): Range[] =>
	ranges.reduce<Range[]>((merged, r) => addRange(merged, r), []);

export function removeRange(ranges: readonly Range[], cut: Range): Range[] {
	const out: Range[] = [];
	for (const r of ranges) {
		if (r.to < cut.from || r.from > cut.to) {
			out.push(r);
			continue;
		}
		if (r.from < cut.from) out.push({ from: r.from, to: cut.from - 1 });
		if (r.to > cut.to) out.push({ from: cut.to + 1, to: r.to });
	}
	return out;
}

export const sizeOf = (ranges: readonly Range[]): number =>
	ranges.reduce((n, r) => n + r.to - r.from + 1, 0);

export function overlap(ranges: readonly Range[], r: Range): number {
	let n = 0;
	for (const have of ranges) {
		const from = Math.max(have.from, r.from);
		const to = Math.min(have.to, r.to);
		if (to >= from) n += to - from + 1;
	}
	return n;
}

// #endregion

// a view is a 2xx text/html response whose status is already known
export function isView(status: number, contentType: string | null): boolean {
	if (status < 200 || status > 299) return false;
	return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'text/html';
}

// #region mechanisms

export type CounterStats = {
	since: number;
	calls: number;
	refused: number;
	puts: number;
	appliedViews: number;
	duplicateViews: number;
};

export const MECHANISMS = ['write-through', 'batched', 'hybrid'] as const;
export type MechanismName = (typeof MECHANISMS)[number];

export type CountingOptions = {
	batchSize: number;
	flushMs: number;
	maxAttempts: number;
};

export const DEFAULT_OPTIONS: CountingOptions = { batchSize: 50, flushMs: 5_000, maxAttempts: 3 };

// what one isolate sends the counter: sequence ranges for one hour, plus how far it has issued
export type CountWrite = {
	siteId: string;
	hour: number;
	origin: string;
	ranges: Range[];
	issued: number;
	unavailable: boolean;
	sync: boolean;
};

export type HourEntry = {
	siteId: string;
	hour: number;
	issued: number;
	sentTo: number;
	retry: Range[];
	acked: Range[];
	dropped: number;
	failures: number;
	unavailable: boolean;
	reportDue: boolean;
	dueAt: number | null;
};

export type CountingState = {
	origin: string;
	entries: ReadonlyMap<string, HourEntry>;
	totals: ReadonlyMap<string, number>;
};

export type CountEvent =
	| {
			kind: 'view';
			siteId: string;
			at: number;
			status: number;
			contentType: string | null;
			limit?: number | null;
	  }
	| { kind: 'ack'; siteId: string; hour: number; ranges: Range[]; total: number }
	| { kind: 'fail'; siteId: string; hour: number; ranges: Range[]; at: number }
	| { kind: 'tick'; at: number };

export type CountStep = { state: CountingState; writes: CountWrite[] };

export type Counting = {
	name: MechanismName;
	init(origin: string): CountingState;
	step(state: CountingState, event: CountEvent): CountStep;
};

const keyOf = (siteId: string, hour: number) => `${siteId}:${hour}`;

const hasWork = (e: HourEntry) => e.issued > e.sentTo || e.retry.length > 0 || e.reportDue;

function flush(origin: string, e: HourEntry, sync: boolean): [HourEntry, CountWrite] {
	const ranges =
		e.issued > e.sentTo
			? addRange(e.retry, { from: e.sentTo + 1, to: e.issued })
			: [...e.retry];
	const write: CountWrite = {
		siteId: e.siteId,
		hour: e.hour,
		origin,
		ranges,
		issued: e.issued,
		unavailable: e.unavailable,
		sync
	};
	return [{ ...e, sentTo: e.issued, retry: [], reportDue: false, dueAt: null }, write];
}

// views counted here that the counter has not acknowledged, and that were not abandoned
function unacked(entries: ReadonlyMap<string, HourEntry>, siteId: string): number {
	let n = 0;
	for (const e of entries.values()) {
		if (e.siteId === siteId) n += e.issued - sizeOf(e.acked) - e.dropped;
	}
	return n;
}

// a site whose total is unknown counts as at its limit, so the first view learns it
function atLimit(state: CountingState, siteId: string, limit: number | null | undefined) {
	if (limit === null || limit === undefined) return false;
	const known = state.totals.get(siteId);
	if (known === undefined) return true;
	return known + unacked(state.entries, siteId) >= limit;
}

export function mechanism(name: MechanismName, options: Partial<CountingOptions> = {}): Counting {
	const o = { ...DEFAULT_OPTIONS, ...options };

	// copies the entry map per event; fine while an isolate holds a few hundred site-hours
	function step(state: CountingState, event: CountEvent): CountStep {
		const entries = new Map(state.entries);
		const totals = new Map(state.totals);
		const writes: CountWrite[] = [];
		const next = (): CountStep => ({
			state: { origin: state.origin, entries, totals },
			writes
		});

		const flushDue = (at: number) => {
			for (const [key, e] of entries) {
				const ended = e.hour + HOUR_MS <= at;
				if (hasWork(e) && (ended || (e.dueAt !== null && at >= e.dueAt))) {
					const [after, write] = flush(state.origin, e, false);
					entries.set(key, after);
					writes.push(write);
				} else if (!hasWork(e) && at - (e.hour + HOUR_MS) >= HOUR_MS) {
					entries.delete(key);
				}
			}
		};

		if (event.kind === 'tick') {
			flushDue(event.at);
			return next();
		}

		if (event.kind === 'ack') {
			totals.set(event.siteId, event.total);
			const key = keyOf(event.siteId, event.hour);
			const e = entries.get(key);
			if (e) {
				let acked = e.acked;
				let retry = e.retry;
				for (const r of event.ranges) {
					acked = addRange(acked, r);
					retry = removeRange(retry, r);
				}
				const after = { ...e, acked, retry, failures: 0, reportDue: false };
				entries.set(key, hasWork(after) ? after : { ...after, dueAt: null });
			}
			return next();
		}

		if (event.kind === 'fail') {
			const key = keyOf(event.siteId, event.hour);
			const e = entries.get(key);
			if (!e) return next();
			let retry = e.retry;
			for (const r of event.ranges) retry = addRange(retry, r);
			for (const r of e.acked) retry = removeRange(retry, r);
			let failures = e.failures + 1;
			let dropped = e.dropped;
			let reportDue = e.reportDue || event.ranges.length === 0;
			if (failures >= o.maxAttempts) {
				// the views are given up; the report carries how far this isolate got
				reportDue = sizeOf(retry) > 0;
				dropped += sizeOf(retry);
				retry = [];
				failures = 0;
			}
			const after: HourEntry = {
				...e,
				retry,
				failures,
				dropped,
				reportDue,
				unavailable: e.unavailable || sizeOf(e.acked) === 0
			};
			entries.set(key, hasWork(after) ? { ...after, dueAt: event.at + o.flushMs } : after);
			return next();
		}

		if (!isView(event.status, event.contentType)) return next();

		const hour = hourOf(event.at);
		const key = keyOf(event.siteId, hour);
		const base: HourEntry = entries.get(key) ?? {
			siteId: event.siteId,
			hour,
			issued: 0,
			sentTo: 0,
			retry: [],
			acked: [],
			dropped: 0,
			failures: 0,
			unavailable: false,
			reportDue: false,
			dueAt: null
		};
		let e: HourEntry = {
			...base,
			issued: base.issued + 1,
			dueAt: base.dueAt ?? event.at + o.flushMs
		};
		entries.set(key, e);
		const sync =
			name === 'write-through' ||
			(name === 'hybrid' &&
				atLimit({ ...state, entries, totals }, event.siteId, event.limit));
		if (sync || e.issued - e.sentTo >= o.batchSize) {
			const [after, write] = flush(state.origin, e, sync);
			e = after;
			entries.set(key, e);
			writes.push(write);
		}
		flushDue(event.at);
		return next();
	}

	return {
		name,
		init: (origin) => ({ origin, entries: new Map(), totals: new Map() }),
		step
	};
}

// #endregion

// #region counter

export const MAX_ORIGINS = 256;

export type ApplyRefusal = 'bad_write' | 'bad_hour' | 'wrong_site' | 'too_many_origins';

export type ApplyAnswer =
	| { ok: true; applied: number; duplicate: number; total: number }
	| { ok: false; reason: ApplyRefusal };

type OriginRecord = { high: number; unavailable: boolean; acked: Range[] };

export type HourRecord = { origins: Record<string, OriginRecord> };

// the hour as the usage ledger closes it: one numbering across every isolate that reported
export type CountedHour = {
	siteId: string;
	start: string;
	end: string;
	observedViews: null;
	settlement: 'open';
	issued: number;
	batches: Range[];
	accountingAvailable: boolean;
	origins: number;
};

const ORIGIN = /^[0-9a-z]{8,32}$/;
const isCountInt = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1;

const hourKey = (hour: number) => `h:${hour}`;
const monthKey = (hour: number) => `m:${new Date(hour).toISOString().slice(0, 7)}`;

function wellFormed(write: CountWrite): boolean {
	if (typeof write !== 'object' || write === null) return false;
	if (typeof write.siteId !== 'string' || write.siteId === '') return false;
	if (typeof write.origin !== 'string' || !ORIGIN.test(write.origin)) return false;
	if (typeof write.unavailable !== 'boolean' || !Array.isArray(write.ranges)) return false;
	if (!Number.isInteger(write.issued) || write.issued < 0) return false;
	let top = 0;
	for (const r of write.ranges) {
		if (!r || !isCountInt(r.from) || !isCountInt(r.to) || r.to < r.from) return false;
		top = Math.max(top, r.to);
	}
	return write.issued >= top;
}

export function applyIn(
	kv: SyncKv,
	write: CountWrite,
	now: number,
	expectedSiteId?: string
): ApplyAnswer {
	if (!wellFormed(write)) return { ok: false, reason: 'bad_write' };
	if (expectedSiteId !== undefined && write.siteId !== expectedSiteId) {
		return { ok: false, reason: 'wrong_site' };
	}
	if (!Number.isInteger(write.hour) || write.hour % HOUR_MS !== 0 || write.hour < 0) {
		return { ok: false, reason: 'bad_hour' };
	}
	// one hour of slack for an isolate clock a little ahead of the object's
	if (write.hour > hourOf(now) + HOUR_MS) return { ok: false, reason: 'bad_hour' };

	const record = kv.get<HourRecord>(hourKey(write.hour)) ?? { origins: {} };
	const have = record.origins[write.origin];
	if (!have && Object.keys(record.origins).length >= MAX_ORIGINS) {
		return { ok: false, reason: 'too_many_origins' };
	}

	let acked = have?.acked ?? [];
	let applied = 0;
	let duplicate = 0;
	for (const r of mergeRanges(write.ranges)) {
		const already = overlap(acked, r);
		duplicate += already;
		applied += r.to - r.from + 1 - already;
		acked = addRange(acked, r);
	}
	const high = Math.max(have?.high ?? 0, write.issued);
	const unavailable = (have?.unavailable ?? false) || write.unavailable;
	const month = kv.get<number>(monthKey(write.hour)) ?? 0;

	if (!have || applied > 0 || high !== have.high || unavailable !== have.unavailable) {
		const origins = { ...record.origins, [write.origin]: { high, unavailable, acked } };
		kv.put(hourKey(write.hour), { origins });
	}
	if (applied > 0) kv.put(monthKey(write.hour), month + applied);
	return { ok: true, applied, duplicate, total: month + applied };
}

export function readHourIn(kv: SyncKv, siteId: string, hour: number): CountedHour | null {
	const record = kv.get<HourRecord>(hourKey(hour));
	if (!record) return null;
	let issued = 0;
	let batches: Range[] = [];
	let ackedViews = 0;
	let anyUnavailable = false;
	for (const origin of Object.keys(record.origins).sort()) {
		const o = record.origins[origin] as OriginRecord;
		for (const r of o.acked) {
			batches = addRange(batches, { from: r.from + issued, to: r.to + issued });
		}
		ackedViews += sizeOf(o.acked);
		issued += o.high;
		anyUnavailable ||= o.unavailable;
	}
	return {
		siteId,
		start: new Date(hour).toISOString(),
		end: new Date(hour + HOUR_MS).toISOString(),
		observedViews: null,
		settlement: 'open',
		issued,
		batches,
		accountingAvailable: !(anyUnavailable && ackedViews === 0),
		origins: Object.keys(record.origins).length
	};
}

export type CounterClient = {
	apply(write: CountWrite): Promise<ApplyAnswer>;
};

// #endregion

// #region delivery

export type AccountingDeps = {
	counting: Counting;
	origin: string;
	now(): number;
	send(write: CountWrite): Promise<ApplyAnswer>;
	waitUntil(promise: Promise<unknown>): void;
	timeoutMs?: number;
};

export const DEFAULT_COUNTER_TIMEOUT_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('counter timeout')), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export type Accounting = {
	count(view: {
		siteId: string;
		status: number;
		contentType: string | null;
		limit?: number | null;
	}): Promise<void>;
	tick(): void;
	state(): CountingState;
};

// no call here rejects: a failed counter is recorded and the request carries on
export function createAccounting(deps: AccountingDeps): Accounting {
	let state = deps.counting.init(deps.origin);
	const timeoutMs = deps.timeoutMs ?? DEFAULT_COUNTER_TIMEOUT_MS;

	const feed = (event: CountEvent): CountWrite[] => {
		const out = deps.counting.step(state, event);
		state = out.state;
		return out.writes;
	};

	async function deliver(write: CountWrite): Promise<void> {
		let answer: ApplyAnswer | null = null;
		try {
			answer = await withTimeout(
				Promise.resolve().then(() => deps.send(write)),
				timeoutMs
			);
		} catch {
			answer = null;
		}
		const base = { siteId: write.siteId, hour: write.hour, ranges: write.ranges };
		if (answer?.ok) feed({ kind: 'ack', ...base, total: answer.total });
		else feed({ kind: 'fail', ...base, at: deps.now() });
	}

	const run = (writes: CountWrite[]): Promise<void> => {
		const waits: Promise<void>[] = [];
		for (const write of writes) {
			const sent = deliver(write);
			if (write.sync) waits.push(sent);
			else deps.waitUntil(sent);
		}
		return Promise.all(waits).then(() => undefined);
	};

	return {
		count: (view) => run(feed({ kind: 'view', at: deps.now(), ...view })),
		tick: () => void run(feed({ kind: 'tick', at: deps.now() })),
		state: () => state
	};
}

// #endregion
