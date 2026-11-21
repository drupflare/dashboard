import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	collegeBudgetSource,
	getOrgBudget,
	getSiteBudget,
	listAlertsSent,
	listBudgetRows,
	putBudget,
	recordAlertSent,
	releaseAlert,
	seedOrgBudget,
	type BudgetRow
} from '../../../src/server/db/repos/budgets';
import { derive, type Entitlement } from '../../../src/server/domain/entitlements';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

const orgId = () => `org-${crypto.randomUUID()}`;

const row = (over: Partial<BudgetRow> & { organizationId: string }): BudgetRow => ({
	id: `bg_${crypto.randomUUID()}`,
	scope: 'org',
	siteId: null,
	percent: 500,
	enforcement: 'block',
	setBy: 'user:u1',
	setAt: 1_000,
	...over
});

describe('budget rows', () => {
	it('round trips an organisation row and a site row', async () => {
		const org = orgId();
		await putBudget(db, row({ organizationId: org, percent: 312.5, enforcement: 'alert' }));
		await putBudget(
			db,
			row({ organizationId: org, scope: 'site', siteId: 's1', percent: 150.5 })
		);
		expect(await getOrgBudget(db, org)).toMatchObject({
			scope: 'org',
			siteId: null,
			percent: 312.5,
			enforcement: 'alert',
			setBy: 'user:u1',
			setAt: 1_000
		});
		expect(await getSiteBudget(db, org, 's1')).toMatchObject({ percent: 150.5 });
		expect(await getSiteBudget(db, org, 's2')).toBeNull();
		expect(await listBudgetRows(db, org)).toHaveLength(2);
	});

	it('keeps one organisation row and one row per site, replacing on a second write', async () => {
		const org = orgId();
		await putBudget(db, row({ organizationId: org, percent: 500 }));
		await putBudget(db, row({ organizationId: org, percent: 300, setBy: 'user:u2' }));
		await putBudget(
			db,
			row({ organizationId: org, scope: 'site', siteId: 's1', percent: 200 })
		);
		await putBudget(
			db,
			row({ organizationId: org, scope: 'site', siteId: 's1', percent: 100 })
		);
		expect(await listBudgetRows(db, org)).toHaveLength(2);
		expect(await getOrgBudget(db, org)).toMatchObject({ percent: 300, setBy: 'user:u2' });
		expect(await getSiteBudget(db, org, 's1')).toMatchObject({ percent: 100 });
	});

	it('refuses a second organisation row or site row when the insert does not name the conflict', async () => {
		const org = orgId();
		await putBudget(db, row({ organizationId: org }));
		await putBudget(db, row({ organizationId: org, scope: 'site', siteId: 's1' }));
		await expect(
			db.run(
				org,
				`INSERT INTO budgets (id, organization_id, scope, site_id, percent, enforcement, set_by, set_at)
				 VALUES ('x1', ?, 'org', NULL, 200, 'block', 'u', 1)`,
				[org]
			)
		).rejects.toThrow(/UNIQUE/i);
		await expect(
			db.run(
				org,
				`INSERT INTO budgets (id, organization_id, scope, site_id, percent, enforcement, set_by, set_at)
				 VALUES ('x2', ?, 'site', 's1', 200, 'block', 'u', 1)`,
				[org]
			)
		).rejects.toThrow(/UNIQUE/i);
	});

	it('refuses a site row with no site and an organisation row with a site', async () => {
		const org = orgId();
		await expect(
			db.run(
				org,
				`INSERT INTO budgets (id, organization_id, scope, site_id, percent, enforcement, set_by, set_at)
				 VALUES ('x3', ?, 'site', NULL, 200, 'block', 'u', 1)`,
				[org]
			)
		).rejects.toThrow(/CHECK/i);
		await expect(
			db.run(
				org,
				`INSERT INTO budgets (id, organization_id, scope, site_id, percent, enforcement, set_by, set_at)
				 VALUES ('x4', ?, 'org', 's1', 200, 'block', 'u', 1)`,
				[org]
			)
		).rejects.toThrow(/CHECK/i);
	});

	it('seeds once and never replaces an existing organisation row', async () => {
		const org = orgId();
		expect(await seedOrgBudget(db, row({ organizationId: org, percent: 500 }))).toBe(true);
		await putBudget(db, row({ organizationId: org, percent: 250, enforcement: 'alert' }));
		expect(await seedOrgBudget(db, row({ organizationId: org, percent: 500 }))).toBe(false);
		expect(await getOrgBudget(db, org)).toMatchObject({ percent: 250, enforcement: 'alert' });
	});
});

describe('alerts sent', () => {
	const sent = (
		organizationId: string,
		over: Partial<Parameters<typeof recordAlertSent>[1]> = {}
	) => ({
		organizationId,
		scopeKey: 'org',
		period: '2026-11',
		alertKey: 'allowance-75',
		sentAt: 5,
		...over
	});

	it('records an alert once per scope, period and key', async () => {
		const org = orgId();
		expect(await recordAlertSent(db, sent(org))).toBe(true);
		expect(await recordAlertSent(db, sent(org, { sentAt: 9 }))).toBe(false);
		expect(await recordAlertSent(db, sent(org, { period: '2026-12' }))).toBe(true);
		expect(await recordAlertSent(db, sent(org, { scopeKey: 'site:s1' }))).toBe(true);
		expect(await recordAlertSent(db, sent(org, { alertKey: 'budget-90' }))).toBe(true);
		const november = await listAlertsSent(db, org, '2026-11');
		expect(november.map((r) => `${r.scopeKey}:${r.alertKey}`).sort()).toEqual([
			'org:allowance-75',
			'org:budget-90',
			'site:s1:allowance-75'
		]);
		expect(
			november.find((r) => r.alertKey === 'allowance-75' && r.scopeKey === 'org')?.sentAt
		).toBe(5);
	});

	it('gives a claim back so it can be taken again', async () => {
		const org = orgId();
		await recordAlertSent(db, sent(org));
		await releaseAlert(db, {
			organizationId: org,
			scopeKey: 'org',
			period: '2026-11',
			alertKey: 'allowance-75'
		});
		expect(await listAlertsSent(db, org, '2026-11')).toEqual([]);
		expect(await recordAlertSent(db, sent(org))).toBe(true);
	});
});

describe('budget source', () => {
	const entitlement = (id: string): Entitlement => {
		const result = derive(id);
		if (!result.ok) throw new Error(result.reason);
		return result.entitlement;
	};

	it('lists organisations that hold an organisation budget, and only those', async () => {
		const withBudget = orgId();
		const siteOnly = orgId();
		await putBudget(db, row({ organizationId: withBudget, percent: 400 }));
		await putBudget(db, row({ organizationId: siteOnly, scope: 'site', siteId: 's1' }));
		const source = collegeBudgetSource(
			async () => db,
			async () => entitlement('managed-pro')
		);
		const listed = (await source.organizations()).map((o) => o.orgId);
		expect(listed).toContain(withBudget);
		expect(listed).not.toContain(siteOnly);
		expect(await source.organization(siteOnly)).toBeNull();
		expect(await source.organization(withBudget)).toMatchObject({
			orgId: withBudget,
			allowanceViews: 1_000_000,
			budget: { percent: 400, enforcement: 'block' },
			sites: []
		});
	});

	it('reads a free organisation as having no budget', async () => {
		const org = orgId();
		await putBudget(db, row({ organizationId: org }));
		const source = collegeBudgetSource(
			async () => db,
			async () => entitlement('managed-free')
		);
		expect(await source.organization(org)).toMatchObject({
			allowanceViews: null,
			budget: null
		});
	});
});
