import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { upsertInterval, type IntervalRow } from '../../../src/server/db/repos/usage';
import { monthBounds } from '../../../src/server/domain/cost-centers';
import type { Entitlement } from '../../../src/server/domain/entitlements';
import {
	orgMonthUsage,
	siteMonthUsage,
	usageReadsOf,
	type UsageServices
} from '../../../src/server/services/usage';
import { openBindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env);
});

afterAll(() => open.close());

const NOW = Date.parse('2026-11-10T03:30:00Z');
const hour = (h: number) =>
	new Date(Date.parse('2026-11-10T00:00:00Z') + h * 3_600_000).toISOString();
const MONTH = monthBounds('2026-11');

const org = () => `org-${crypto.randomUUID()}`;

function deps(): UsageServices {
	return {
		getDb: async () => db,
		now: () => NOW,
		planOf: async () => ({ views: 1000, viewsPooled: true }) as unknown as Entitlement
	};
}

async function site(orgId: string, id: string, name: string) {
	await db.run(
		orgId,
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES (?, ?, ?, 'managed', 'active', 0, 0)`,
		[id, orgId, name]
	);
}

function row(
	orgId: string,
	siteId: string,
	h: number,
	over: Partial<IntervalRow> = {}
): IntervalRow {
	return {
		organizationId: orgId,
		siteId,
		hourStart: hour(h),
		issued: 10,
		acked: 10,
		accounting: 'exact',
		settlement: 'closed',
		invoiceRef: null,
		closedAt: NOW,
		...over
	};
}

async function world() {
	const orgId = org();
	const otherOrg = org();
	await site(orgId, `site-a-${orgId}`, 'Alpha');
	await site(orgId, `site-b-${orgId}`, 'Beta');
	const [a, b] = [`site-a-${orgId}`, `site-b-${orgId}`];
	await upsertInterval(db, row(orgId, a, 0));
	await upsertInterval(db, row(orgId, a, 1));
	await upsertInterval(db, row(orgId, a, 2));
	await upsertInterval(db, row(orgId, b, 0, { issued: 5, acked: 5 }));
	await upsertInterval(db, row(orgId, b, 1, { issued: 0, acked: 0, accounting: 'unaccounted' }));
	await site(otherOrg, `site-x-${otherOrg}`, 'Other');
	return { orgId, otherOrg, a, b };
}

describe('usage ports', () => {
	it('gives the cost centers the hours of each site in the month', async () => {
		const { orgId, a, b } = await world();
		const { reads } = usageReadsOf(async () => db);
		const found = await reads.intervals(orgId, [a, b], MONTH);
		expect(found.get(a)).toHaveLength(3);
		expect(found.get(b)?.map((i) => i.accuracy)).toEqual(['exact', 'unaccounted']);
		expect(found.get(b)?.[1]).toMatchObject({ views: 0, lowerBound: 0 });
	});

	it('gives the client export the sampled hours with only the fields it writes', async () => {
		const { orgId, a } = await world();
		const { samples } = usageReadsOf(async () => db);
		const rows = await samples({ orgId, siteIds: [a], from: hour(0), to: hour(2) });
		expect(rows).toEqual([
			{ siteId: a, start: hour(0), accuracy: 'exact', views: 10, lowerBound: 10 },
			{ siteId: a, start: hour(1), accuracy: 'exact', views: 10, lowerBound: 10 }
		]);
	});
});

describe('usage screens', () => {
	it('totals the organisation, lists its sites, and shows the plan allowance', async () => {
		const { orgId, a, b } = await world();
		const usage = await orgMonthUsage(deps(), orgId, '2026-11');
		expect(usage.allowance).toEqual({ views: 1000, pooled: true });
		expect(usage.total).toMatchObject({
			views: 35,
			lowerBound: 35,
			state: 'unaccounted',
			closed: false,
			// Nov 1 00:00 to Nov 10 03:30 is 220 started hours per site
			expectedHours: 440,
			presentHours: 5
		});
		expect(usage.sites.map((s) => [s.siteId, s.views, s.state])).toEqual([
			[a, 30, 'unaccounted'],
			[b, 5, 'unaccounted']
		]);
		expect(usage.days).toHaveLength(10);
		expect(usage.days.at(-1)).toEqual({
			day: '2026-11-10',
			views: 35,
			lowerBound: 35,
			state: 'unaccounted',
			unaccountedHours: 3
		});
		expect(usage.days[0]).toMatchObject({ day: '2026-11-01', views: 0, state: 'unaccounted' });
	});

	it('shows a site of the organisation, and says not found for a site of another organisation', async () => {
		const { orgId, otherOrg, a } = await world();
		const mine = await siteMonthUsage(deps(), orgId, a, '2026-11');
		expect(mine).toMatchObject({ siteId: a, views: 30, state: 'unaccounted', presentHours: 3 });
		await expect(siteMonthUsage(deps(), otherOrg, a, '2026-11')).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('shows an organisation with no sites an empty month, without another organisation data', async () => {
		await world();
		const empty = org();
		const usage = await orgMonthUsage(deps(), empty, '2026-11');
		expect(usage.sites).toEqual([]);
		expect(usage.total).toMatchObject({ views: 0, state: 'exact' });
	});
});
