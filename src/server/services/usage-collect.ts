import type { SiteId } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import type { CountedHour } from '../../../dispatch/src/counting';
import type { ActiveSiteRef } from '../db/repos/repairs';
import {
	listManagedSites,
	listOpenIntervals,
	upsertInterval,
	type IntervalRow
} from '../db/repos/usage';
import { closeInterval, type OpenInterval } from '../domain/usage-ledger';
import { HOUR_MS } from '../domain/usage-views';

// the counter's hour is settled this long after it ends, so a flush that lands late still counts
export const SETTLE_GRACE_MS = 10 * 60_000;
// one counts message reads at most this many hours, so the window is the current hour and 47 before
export const WINDOW_HOURS = 48;

// null: the counter could not be read; an entry is null when the counter holds no record of the hour
export interface HoursReader {
	read(siteId: string, hours: readonly number[]): Promise<(CountedHour | null)[] | null>;
	// one read for many sites; a site missing from the answer is unreadable
	readMany?(
		requests: readonly { siteId: string; hours: readonly number[] }[]
	): Promise<Map<string, (CountedHour | null)[] | null>>;
}

export interface UsageStore {
	open(orgId: string, siteId: string, fromHour: string): Promise<IntervalRow[]>;
	upsert(row: IntervalRow): Promise<void>;
}

export interface UsageCollectDeps {
	now(): number;
	sites(): Promise<ActiveSiteRef[]>;
	hours: HoursReader;
	store: UsageStore;
}

export interface CollectSummary {
	checked: number;
	written: number;
	closed: number;
	unchanged: number;
	invalid: number;
	unreadable: string[];
	failed: { siteId: string; message: string }[];
}

function rowOf(
	orgId: string,
	siteId: string,
	hourStart: string,
	interval: { views: number; lowerBound: number; accuracy: IntervalRow['accounting'] },
	settlement: IntervalRow['settlement'],
	closedAt: number | null
): IntervalRow {
	return {
		organizationId: orgId,
		siteId,
		hourStart,
		issued: interval.views,
		acked: interval.lowerBound,
		accounting: interval.accuracy,
		settlement,
		invoiceRef: null,
		closedAt
	};
}

// the row for one hour as the ledger states it now: closed once the hour and its grace have passed,
// open (provisional accuracy) before that; null when the counter's batches do not add up
function rowFor(
	orgId: string,
	siteId: string,
	hour: number,
	reading: CountedHour | null,
	nowMs: number
): IntervalRow | null {
	const start = new Date(hour).toISOString();
	const end = new Date(hour + HOUR_MS).toISOString();
	if (reading !== null && reading.start !== start) return null;
	const open: OpenInterval = {
		siteId: siteId as SiteId,
		start,
		end,
		observedViews: null,
		settlement: 'open',
		issued: reading?.issued ?? 0,
		batches: reading?.batches ?? [],
		accountingAvailable: reading?.accountingAvailable ?? true
	};
	const closed = closeInterval(open, nowMs - SETTLE_GRACE_MS);
	if (closed.ok) {
		return rowOf(orgId, siteId, start, closed.interval, 'closed', nowMs);
	}
	if (closed.reason !== 'not_ended') return null;
	const provisional = closeInterval(open, hour + HOUR_MS);
	if (!provisional.ok) return null;
	return rowOf(orgId, siteId, start, provisional.interval, 'open', null);
}

const sameState = (a: IntervalRow, b: IntervalRow): boolean =>
	a.issued === b.issued &&
	a.acked === b.acked &&
	a.accounting === b.accounting &&
	a.settlement === b.settlement;

// what to read for one site: the current hour and every open hour of the window, so an hour is read
// until it closes and an hour with no record yet gets its row on the first run that sees it
async function prepare(
	deps: UsageCollectDeps,
	site: ActiveSiteRef,
	nowMs: number
): Promise<{ site: ActiveSiteRef; hours: number[]; stored: Map<string, IntervalRow> }> {
	const current = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
	const from = new Date(current - (WINDOW_HOURS - 1) * HOUR_MS).toISOString();
	const open = await deps.store.open(site.organizationId, site.id, from);
	const hours = [...new Set([current, ...open.map((row) => Date.parse(row.hourStart))])].sort(
		(a, b) => a - b
	);
	return { site, hours, stored: new Map(open.map((row) => [row.hourStart, row])) };
}

async function applySite(
	deps: UsageCollectDeps,
	plan: { site: ActiveSiteRef; hours: number[]; stored: Map<string, IntervalRow> },
	readings: (CountedHour | null)[],
	nowMs: number,
	summary: CollectSummary
): Promise<void> {
	const { site, hours, stored } = plan;
	for (const [index, hour] of hours.entries()) {
		const reading = readings[index] ?? null;
		const prior = stored.get(new Date(hour).toISOString());
		// a missing record for an hour already on file keeps the stored state, never a zero
		if (reading === null && prior !== undefined) {
			summary.unchanged++;
			continue;
		}
		const next = rowFor(site.organizationId, site.id, hour, reading, nowMs);
		if (next === null) {
			summary.invalid++;
			continue;
		}
		if (prior !== undefined && sameState(prior, next)) {
			summary.unchanged++;
			continue;
		}
		await deps.store.upsert(next);
		summary.written++;
		if (next.settlement === 'closed') summary.closed++;
	}
}

// the sites are read in as few round trips as the reader allows; one site that throws never stops
// the rest, and a site whose read fails keeps what it had
export async function collectUsage(deps: UsageCollectDeps): Promise<CollectSummary> {
	const summary: CollectSummary = {
		checked: 0,
		written: 0,
		closed: 0,
		unchanged: 0,
		invalid: 0,
		unreadable: [],
		failed: []
	};
	const nowMs = deps.now();
	const failed = (siteId: string, error: unknown) =>
		summary.failed.push({
			siteId,
			message: error instanceof Error ? error.name : 'unknown'
		});

	const plans: Awaited<ReturnType<typeof prepare>>[] = [];
	for (const site of await deps.sites()) {
		summary.checked++;
		try {
			plans.push(await prepare(deps, site, nowMs));
		} catch (error) {
			failed(site.id, error);
		}
	}

	const readings = new Map<string, (CountedHour | null)[] | null | Error>();
	if (deps.hours.readMany !== undefined) {
		try {
			const answers = await deps.hours.readMany(
				plans.map(({ site, hours }) => ({ siteId: site.id, hours }))
			);
			for (const { site } of plans) readings.set(site.id, answers.get(site.id) ?? null);
		} catch (error) {
			for (const { site } of plans) readings.set(site.id, error as Error);
		}
	} else {
		for (const { site, hours } of plans) {
			try {
				readings.set(site.id, await deps.hours.read(site.id, hours));
			} catch (error) {
				readings.set(site.id, error as Error);
			}
		}
	}

	for (const plan of plans) {
		const reading = readings.get(plan.site.id) ?? null;
		if (reading instanceof Error) {
			failed(plan.site.id, reading);
		} else if (reading === null) {
			summary.unreadable.push(plan.site.id);
		} else {
			try {
				await applySite(deps, plan, reading, nowMs, summary);
			} catch (error) {
				failed(plan.site.id, error);
			}
		}
	}
	return summary;
}

// installed by the boot, which holds the binding and the secret that reach the counter; null while
// either is missing, and the task reports itself skipped
let factory: (() => UsageCollectDeps | null) | null = null;

export function setUsageCollectFactory(next: (() => UsageCollectDeps | null) | null): void {
	factory = next;
}

export const usageCollectInstalled = (): boolean => factory !== null;

export function usageCollectDepsFor(_env?: unknown): UsageCollectDeps | null {
	return factory === null ? null : factory();
}

export function productionUsageStore(getDb: () => Promise<CollegeDBClient>): UsageStore {
	return {
		open: async (orgId, siteId, fromHour) =>
			listOpenIntervals(await getDb(), orgId, siteId, fromHour),
		upsert: async (row) => upsertInterval(await getDb(), row)
	};
}

export function productionSites(
	getDb: () => Promise<CollegeDBClient>
): () => Promise<ActiveSiteRef[]> {
	return async () => listManagedSites(await getDb());
}
