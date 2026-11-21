import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_MAX_SITES } from '../../../../contracts/src/engine-batch';
import type { CountedHour } from '../../../../dispatch/src/counting';
import type { IntervalRow } from '../../../../src/server/db/repos/usage';
import { billableViews } from '../../../../src/server/domain/usage-ledger';
import { intervalOf } from '../../../../src/server/domain/usage-views';
import {
	engineCountsReaders,
	type EngineBatchConfig
} from '../../../../src/server/integrations/engine-batch';
import {
	collectUsage,
	SETTLE_GRACE_MS,
	type UsageCollectDeps
} from '../../../../src/server/services/usage-collect';
import {
	bindingOf,
	BUDGET_SECRET,
	COUNTS_SECRET,
	rig as engineRig,
	freezeClock,
	NOW
} from '../../engine/batch-support';

const HOUR = 3_600_000;
const ORG = 'org_one';
const SITE = 'site_a';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const ELEVEN = at('2026-11-10T11:00:00Z');
const TWELVE = at('2026-11-10T12:00:00Z');

function counted(start: number, over: Partial<CountedHour> = {}): CountedHour {
	return {
		siteId: SITE,
		start: iso(start),
		end: iso(start + HOUR),
		observedViews: null,
		settlement: 'open',
		issued: 10,
		batches: [{ from: 1, to: 10 }],
		accountingAvailable: true,
		origins: 1,
		...over
	};
}

// the same rule as the repository: a row is replaced only while it is open
function memory() {
	const rows = new Map<string, IntervalRow>();
	const key = (siteId: string, hourStart: string) => `${siteId}|${hourStart}`;
	return {
		rows,
		at: (hour: number) => rows.get(key(SITE, iso(hour))),
		store: {
			async open(_orgId: string, siteId: string, fromHour: string) {
				return [...rows.values()]
					.filter(
						(r) =>
							r.siteId === siteId &&
							r.settlement === 'open' &&
							r.hourStart >= fromHour
					)
					.sort((a, b) => a.hourStart.localeCompare(b.hourStart));
			},
			async upsert(row: IntervalRow) {
				const prior = rows.get(key(row.siteId, row.hourStart));
				if (prior && prior.settlement !== 'open') return;
				rows.set(key(row.siteId, row.hourStart), row);
			}
		}
	};
}

function world(now: number, readings: Map<number, CountedHour>) {
	const table = memory();
	const state = { failing: false, failingSites: new Set<string>(), now };
	const deps: UsageCollectDeps = {
		now: () => state.now,
		sites: async () => [{ id: SITE, organizationId: ORG }],
		hours: {
			async read(siteId, hours) {
				if (state.failingSites.has(siteId)) throw new Error('counter unreachable');
				if (state.failing) return null;
				return hours.map((hour) => readings.get(hour) ?? null);
			}
		},
		store: table.store
	};
	return { deps, table, state, readings };
}

describe('usage collection', () => {
	it('closes an hour once it has ended and its grace has passed, and not before', async () => {
		const readings = new Map([[ELEVEN, counted(ELEVEN)]]);
		const w = world(at('2026-11-10T11:30:00Z'), readings);
		await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)).toMatchObject({
			settlement: 'open',
			accounting: 'exact',
			issued: 10
		});

		w.state.now = TWELVE + SETTLE_GRACE_MS - 1;
		await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)?.settlement).toBe('open');

		w.state.now = TWELVE + SETTLE_GRACE_MS;
		const summary = await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)).toMatchObject({ settlement: 'closed', accounting: 'exact' });
		expect(summary.closed).toBe(1);
	});

	it('writes nothing on a rerun and never counts a view twice', async () => {
		const readings = new Map([[ELEVEN, counted(ELEVEN)]]);
		const w = world(at('2026-11-10T11:30:00Z'), readings);
		await collectUsage(w.deps);
		const again = await collectUsage(w.deps);
		expect(again.written).toBe(0);
		expect(w.table.at(ELEVEN)).toMatchObject({ issued: 10, acked: 10 });
	});

	it('marks an hour with a gap in acknowledgements estimated, and bills its issued views', async () => {
		const gap = counted(ELEVEN, {
			batches: [
				{ from: 1, to: 4 },
				{ from: 7, to: 10 }
			]
		});
		const w = world(at('2026-11-10T11:30:00Z'), new Map([[ELEVEN, gap]]));
		await collectUsage(w.deps);
		w.state.now = TWELVE + SETTLE_GRACE_MS;
		await collectUsage(w.deps);
		const row = w.table.at(ELEVEN);
		expect(row).toMatchObject({
			accounting: 'estimated',
			issued: 10,
			acked: 8,
			settlement: 'closed'
		});
		expect(billableViews(intervalOf(row!))).toEqual({
			basis: 'estimated',
			views: 10,
			lowerBound: 8
		});
	});

	it('leaves a stored hour as it was when the counter cannot be read', async () => {
		const w = world(at('2026-11-10T11:30:00Z'), new Map([[ELEVEN, counted(ELEVEN)]]));
		await collectUsage(w.deps);
		const before = { ...w.table.at(ELEVEN)! };
		w.state.failing = true;
		w.state.now = TWELVE + SETTLE_GRACE_MS;
		const summary = await collectUsage(w.deps);
		expect(summary.unreadable).toEqual([SITE]);
		expect(summary.written).toBe(0);
		expect(w.table.at(ELEVEN)).toEqual(before);
	});

	it('marks an hour whose counter has no usable acknowledgements unaccounted, and bills it at zero', async () => {
		const lost = counted(ELEVEN, { issued: 5, batches: [], accountingAvailable: false });
		const w = world(at('2026-11-10T11:30:00Z'), new Map([[ELEVEN, lost]]));
		await collectUsage(w.deps);
		w.state.now = TWELVE + SETTLE_GRACE_MS;
		await collectUsage(w.deps);
		const row = w.table.at(ELEVEN);
		expect(row).toMatchObject({
			accounting: 'unaccounted',
			issued: 0,
			acked: 0,
			settlement: 'closed'
		});
		expect(billableViews(intervalOf(row!))).toEqual({ basis: 'unaccounted', views: 0 });
	});

	it('stores an exact zero for a readable hour with no record, and keeps a stored hour when its record goes missing', async () => {
		const readings = new Map<number, CountedHour>();
		const w = world(at('2026-11-10T11:30:00Z'), readings);
		await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)).toMatchObject({
			accounting: 'exact',
			issued: 0,
			settlement: 'open'
		});

		readings.set(ELEVEN, counted(ELEVEN, { issued: 3, batches: [{ from: 1, to: 3 }] }));
		await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)).toMatchObject({ issued: 3, acked: 3 });

		readings.delete(ELEVEN);
		const summary = await collectUsage(w.deps);
		expect(w.table.at(ELEVEN)).toMatchObject({ issued: 3, acked: 3 });
		expect(summary.unchanged).toBeGreaterThan(0);
	});

	it('refuses a reading for another hour and writes nothing for it', async () => {
		const misplaced = counted(ELEVEN, { start: iso(TWELVE) });
		const w = world(at('2026-11-10T11:30:00Z'), new Map([[ELEVEN, misplaced]]));
		const summary = await collectUsage(w.deps);
		expect(summary.invalid).toBe(1);
		expect(w.table.at(ELEVEN)).toBeUndefined();
	});

	it('keeps the other sites going when one site throws', async () => {
		const other = 'site_b';
		const w = world(at('2026-11-10T11:30:00Z'), new Map([[ELEVEN, counted(ELEVEN)]]));
		w.state.failingSites.add(SITE);
		const deps: UsageCollectDeps = {
			...w.deps,
			sites: async () => [
				{ id: SITE, organizationId: ORG },
				{ id: other, organizationId: ORG }
			]
		};
		const summary = await collectUsage(deps);
		expect(summary.failed).toEqual([{ siteId: SITE, message: 'Error' }]);
		expect(summary.checked).toBe(2);
	});
});

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

describe('usage collection through the engine', () => {
	beforeEach(freezeClock);
	afterEach(() => vi.useRealTimers());

	// the real counts route over a fake counter; `table` is what each site's counter holds
	async function engineWorld(siteIds: string[], now: number) {
		const r = await engineRig([]);
		const log: { path: string; body: unknown }[] = [];
		const held = new Map<string, Map<number, CountedHour>>();
		r.deps.counts = async (read) => {
			const table = held.get(read.siteId);
			if (table === undefined) return null;
			return {
				ok: true,
				hours: read.hours.map((hour) => table.get(hour) ?? null),
				months: []
			};
		};
		const config: EngineBatchConfig = {
			binding: bindingOf(r.deps, log),
			budgetSecret: BUDGET_SECRET,
			countsSecret: COUNTS_SECRET,
			now: () => NOW,
			newId: () => `req_${crypto.randomUUID()}`
		};
		const table = memory();
		const deps: UsageCollectDeps = {
			now: () => now,
			sites: async () => siteIds.map((id) => ({ id, organizationId: ORG })),
			hours: engineCountsReaders(config).hours,
			store: table.store
		};
		return { deps, table, log, held, r };
	}

	const readingFor = (siteId: string, hour: number, over: Partial<CountedHour> = {}) =>
		counted(hour, { siteId, ...over });

	it('collects every site in one round trip a chunk and writes the hours', async () => {
		const ids = Array.from({ length: BATCH_MAX_SITES + 2 }, (_, i) => `site_${i}`);
		const w = await engineWorld(ids, at('2026-11-10T11:30:00Z'));
		for (const id of ids) w.held.set(id, new Map([[ELEVEN, readingFor(id, ELEVEN)]]));
		const summary = await collectUsage(w.deps);
		expect(w.log.map((entry) => entry.path)).toEqual(['/counts', '/counts']);
		expect(summary).toMatchObject({ checked: ids.length, written: ids.length, unreadable: [] });
		expect(w.table.rows.size).toBe(ids.length);
	});

	it('writes nothing on a rerun and never counts a view twice', async () => {
		const w = await engineWorld(['site_a'], at('2026-11-10T11:30:00Z'));
		w.held.set('site_a', new Map([[ELEVEN, readingFor('site_a', ELEVEN)]]));
		await collectUsage(w.deps);
		const again = await collectUsage(w.deps);
		expect(again).toMatchObject({ written: 0, unchanged: 1 });
		expect(w.table.rows.size).toBe(1);
	});

	it('reports a site unreadable when its counter throws, and collects it on the next run', async () => {
		const w = await engineWorld(['site_a'], at('2026-11-10T11:30:00Z'));
		w.held.set('site_a', new Map([[ELEVEN, readingFor('site_a', ELEVEN)]]));
		let failures = 1;
		const real = w.r.deps.counts;
		w.r.deps.counts = async (read) => {
			if (failures > 0) {
				failures--;
				throw new Error('counter down');
			}
			return real(read);
		};
		const first = await collectUsage(w.deps);
		expect(first.unreadable).toEqual(['site_a']);
		expect(w.table.rows.size).toBe(0);
		const second = await collectUsage(w.deps);
		expect(second).toMatchObject({ written: 1, unreadable: [] });
	});

	it('keeps an hour unaccounted when the counter could not be read, and fills it in on a later run', async () => {
		const w = await engineWorld(['site_a', 'site_b'], at('2026-11-10T11:30:00Z'));
		w.held.set('site_b', new Map([[ELEVEN, readingFor('site_b', ELEVEN)]]));
		const first = await collectUsage(w.deps);
		expect(first.unreadable).toEqual(['site_a']);
		expect([...w.table.rows.values()].map((row) => row.siteId)).toEqual(['site_b']);
		w.held.set('site_a', new Map([[ELEVEN, readingFor('site_a', ELEVEN)]]));
		const second = await collectUsage(w.deps);
		expect(second.unreadable).toEqual([]);
		expect(w.table.rows.size).toBe(2);
	});

	it('goes on with the sites of another chunk when one chunk fails both tries', async () => {
		const ids = Array.from({ length: BATCH_MAX_SITES + 1 }, (_, i) => `site_${i}`);
		const w = await engineWorld(ids, at('2026-11-10T11:30:00Z'));
		for (const id of ids) w.held.set(id, new Map([[ELEVEN, readingFor(id, ELEVEN)]]));
		const dead = {
			async fetch(input: string | Request, init?: RequestInit) {
				const body = JSON.parse(String(init?.body)) as { reads: unknown[] };
				if (body.reads.length === BATCH_MAX_SITES) throw new Error('no route');
				return bindingOf(w.r.deps).fetch(input, init);
			}
		};
		const deps: UsageCollectDeps = {
			...w.deps,
			hours: engineCountsReaders({
				binding: dead,
				budgetSecret: BUDGET_SECRET,
				countsSecret: COUNTS_SECRET,
				now: () => NOW,
				newId: () => `req_${crypto.randomUUID()}`
			}).hours
		};
		const summary = await collectUsage(deps);
		expect(summary.unreadable).toHaveLength(BATCH_MAX_SITES);
		expect(summary.written).toBe(1);
	});
});
