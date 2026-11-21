import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	insertAdjustment,
	listIntervals,
	listManagedSites,
	listOpenIntervals,
	upsertInterval,
	type IntervalRow
} from '../../../src/server/db/repos/usage';
import { openBindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env);
});

afterAll(() => open.close());

const org = () => `org-${crypto.randomUUID()}`;
const hour = (h: number) =>
	new Date(Date.parse('2026-11-10T00:00:00Z') + h * 3_600_000).toISOString();

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
		settlement: 'open',
		invoiceRef: null,
		closedAt: null,
		...over
	};
}

async function site(orgId: string, id: string, plane: string, state = 'active') {
	await db.run(
		orgId,
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 0, 0)`,
		[id, orgId, id, plane, state]
	);
}

describe('usage intervals', () => {
	it('rewrites an open hour in place and never rewrites a closed one', async () => {
		const orgId = org();
		await upsertInterval(db, row(orgId, 'site-open', 1, { issued: 4, acked: 4 }));
		await upsertInterval(db, row(orgId, 'site-open', 1, { issued: 9, acked: 9 }));
		const [open1] = await listOpenIntervals(db, orgId, 'site-open', hour(0));
		expect(open1).toMatchObject({ issued: 9, acked: 9, settlement: 'open' });

		await upsertInterval(
			db,
			row(orgId, 'site-open', 1, { issued: 9, acked: 9, settlement: 'closed', closedAt: 5 })
		);
		await upsertInterval(db, row(orgId, 'site-open', 1, { issued: 99, acked: 99 }));
		expect(await listOpenIntervals(db, orgId, 'site-open', hour(0))).toEqual([]);
		const [closed] = await listIntervals(db, orgId, ['site-open'], hour(1), hour(2));
		expect(closed).toMatchObject({ issued: 9, settlement: 'closed', closedAt: 5 });
	});

	it('lists open hours from a start hour, in order', async () => {
		const orgId = org();
		await upsertInterval(db, row(orgId, 'site-order', 3));
		await upsertInterval(db, row(orgId, 'site-order', 2));
		await upsertInterval(db, row(orgId, 'site-order', 1, { settlement: 'closed' }));
		const open2 = await listOpenIntervals(db, orgId, 'site-order', hour(2));
		expect(open2.map((r) => r.hourStart)).toEqual([hour(2), hour(3)]);
	});

	it('reads the hours of many sites in range, past the parameter chunk size', async () => {
		const orgId = org();
		const ids = Array.from({ length: 120 }, (_, i) => `site-many-${i}`);
		for (const id of ids) await upsertInterval(db, row(orgId, id, 5));
		await upsertInterval(db, row(orgId, ids[0]!, 6));
		const rows = await listIntervals(db, orgId, ids, hour(5), hour(6));
		expect(rows).toHaveLength(120);
		expect(rows.every((r) => r.hourStart === hour(5))).toBe(true);
	});

	it('never returns the hours of a site that belongs to another organisation', async () => {
		const mine = org();
		const theirs = org();
		await upsertInterval(db, row(theirs, 'site-theirs', 1));
		await upsertInterval(db, row(mine, 'site-mine', 1));
		expect(await listIntervals(db, mine, ['site-theirs'], hour(0), hour(5))).toEqual([]);
		expect(await listOpenIntervals(db, mine, 'site-theirs', hour(0))).toEqual([]);
		const both = await listIntervals(db, mine, ['site-theirs', 'site-mine'], hour(0), hour(5));
		expect(both.map((r) => r.siteId)).toEqual(['site-mine']);
	});

	it('refuses an adjustment of zero', async () => {
		const orgId = org();
		await expect(
			insertAdjustment(db, {
				id: crypto.randomUUID(),
				organizationId: orgId,
				siteId: 'site-adj',
				intervalStart: hour(1),
				delta: 0,
				reason: 'no change',
				invoiceRef: null,
				setBy: 'admin',
				at: 1
			})
		).rejects.toThrow();
	});
});

describe('managed sites for the collector', () => {
	it('lists active managed sites only, from every shard', async () => {
		const orgId = org();
		const managed = `managed-${crypto.randomUUID()}`;
		await site(orgId, managed, 'managed');
		await site(orgId, `self-${crypto.randomUUID()}`, 'self-managed');
		await site(orgId, `gone-${crypto.randomUUID()}`, 'managed', 'tombstoned');
		const sites = await listManagedSites(db);
		expect(sites).toContainEqual({ id: managed, organizationId: orgId });
		expect(sites.every((s) => !s.id.startsWith('self-'))).toBe(true);
	});
});
