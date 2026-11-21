import type { UsageInterval } from '@contracts/usage';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import type { OrgUsage, SiteMonthUsage } from '../../shared/usage';
import { listOrgSites } from '../db/repos/cost-centers';
import { listIntervals, type IntervalRow } from '../db/repos/usage';
import { monthBounds, worstState, type MonthBounds } from '../domain/cost-centers';
import type { Entitlement } from '../domain/entitlements';
import { dailyViews, intervalOf, monthView, type Accounting } from '../domain/usage-views';
import type { UsageSampleRead } from './client-workspaces';
import type { UsageReads } from './cost-centers';

export interface UsageServices {
	getDb: () => Promise<CollegeDBClient>;
	now: () => number;
	planOf: (orgId: string) => Promise<Entitlement>;
}

let installed: UsageServices | null = null;

export function setUsageServices(services: UsageServices | null): void {
	installed = services;
}

export function usageServices(): UsageServices {
	if (installed === null) throw new ApiError('not_built', 'Usage is not available yet');
	return installed;
}

const iso = (ms: number) => new Date(ms).toISOString();

interface DayTotal {
	views: number;
	lowerBound: number;
	unaccountedHours: number;
	states: Accounting[];
}

// the read ports the cost centers, the pilots and the client export use; they share one reader
export function usageReadsOf(getDb: () => Promise<CollegeDBClient>): {
	reads: UsageReads;
	samples: UsageSampleRead;
} {
	return {
		reads: {
			async intervals(orgId, siteIds, bounds: MonthBounds) {
				const rows = await listIntervals(
					await getDb(),
					orgId,
					siteIds,
					iso(bounds.start),
					iso(bounds.end)
				);
				const out = new Map<string, UsageInterval[]>();
				for (const row of rows) {
					const list = out.get(row.siteId) ?? [];
					list.push(intervalOf(row));
					out.set(row.siteId, list);
				}
				return out;
			}
		},
		samples: async ({ orgId, siteIds, from, to }) => {
			const rows = await listIntervals(await getDb(), orgId, siteIds, from, to);
			return rows.map((row) => {
				const { siteId, start, accuracy, views, lowerBound } = intervalOf(row);
				return { siteId, start, accuracy, views, lowerBound };
			});
		}
	};
}

const groupBySite = (rows: readonly IntervalRow[]): Map<string, IntervalRow[]> => {
	const map = new Map<string, IntervalRow[]>();
	for (const row of rows) {
		const list = map.get(row.siteId) ?? [];
		list.push(row);
		map.set(row.siteId, list);
	}
	return map;
};

export async function orgMonthUsage(
	deps: UsageServices,
	orgId: string,
	month: string
): Promise<OrgUsage> {
	const db = await deps.getDb();
	const bounds = monthBounds(month);
	const now = deps.now();
	const [sites, entitlement] = await Promise.all([listOrgSites(db, orgId), deps.planOf(orgId)]);
	const rows = await listIntervals(
		db,
		orgId,
		sites.map((site) => site.id),
		iso(bounds.start),
		iso(bounds.end)
	);
	const bySite = groupBySite(rows);
	const siteViews = sites.map((site) => {
		const siteRows = bySite.get(site.id) ?? [];
		return {
			siteId: site.id,
			name: site.name,
			...monthView(siteRows, bounds, now),
			days: dailyViews(siteRows, bounds, now)
		};
	});
	const days = new Map<string, DayTotal>();
	for (const site of siteViews) {
		for (const day of site.days) {
			const entry = days.get(day.day) ?? {
				views: 0,
				lowerBound: 0,
				unaccountedHours: 0,
				states: []
			};
			entry.views += day.views;
			entry.lowerBound += day.lowerBound;
			entry.unaccountedHours += day.unaccountedHours;
			entry.states.push(day.state);
			days.set(day.day, entry);
		}
	}
	return {
		month,
		allowance: { views: entitlement.views, pooled: entitlement.viewsPooled === true },
		total: {
			views: siteViews.reduce((sum, site) => sum + site.views, 0),
			lowerBound: siteViews.reduce((sum, site) => sum + site.lowerBound, 0),
			state:
				siteViews.length === 0 ? 'exact' : worstState(siteViews.map((site) => site.state)),
			closed: siteViews.every((site) => site.closed),
			expectedHours: siteViews.reduce((sum, site) => sum + site.expectedHours, 0),
			presentHours: siteViews.reduce((sum, site) => sum + site.presentHours, 0)
		},
		days: [...days].map(([day, entry]) => ({
			day,
			views: entry.views,
			lowerBound: entry.lowerBound,
			state: worstState(entry.states),
			unaccountedHours: entry.unaccountedHours
		})),
		sites: siteViews
	};
}

// a site that is not in the organisation is not found, so one organisation cannot read another's hours
export async function siteMonthUsage(
	deps: UsageServices,
	orgId: string,
	siteId: string,
	month: string
): Promise<SiteMonthUsage> {
	const db = await deps.getDb();
	if (!(await listOrgSites(db, orgId)).some((site) => site.id === siteId)) {
		throw new ApiError('not_found', 'Not found');
	}
	const bounds = monthBounds(month);
	const rows = await listIntervals(db, orgId, [siteId], iso(bounds.start), iso(bounds.end));
	const now = deps.now();
	return {
		siteId,
		...monthView(rows, bounds, now),
		days: dailyViews(rows, bounds, now)
	};
}
