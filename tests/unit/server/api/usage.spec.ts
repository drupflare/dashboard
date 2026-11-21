import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import siteUsage from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/usage.get';
import orgUsage from '../../../../src/server/api/v1/orgs/[orgId]/usage.get';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import type { Entitlement } from '../../../../src/server/domain/entitlements';
import { setUsageServices, type UsageServices } from '../../../../src/server/services/usage';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

const SITE = 'site_aaaa1111';
const FOREIGN = 'site_bbbb2222';
const NOW = Date.parse('2026-11-10T03:30:00Z');

function world(planViews: number | null = 1000) {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
	const db = {
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	const services: UsageServices = {
		getDb: async () => db,
		now: () => NOW,
		planOf: async () => ({ views: planViews, viewsPooled: null }) as unknown as Entitlement
	};
	setUsageServices(services);
	for (const id of [ORG, OTHER_ORG]) {
		sql.prepare(
			'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
		).run(id, id, 'seed');
	}
	sql.prepare(
		"INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at) VALUES (?, ?, 'one', 'managed', 'active', 1, 1), (?, ?, 'two', 'managed', 'active', 1, 1)"
	).run(SITE, ORG, FOREIGN, OTHER_ORG);
	sql.prepare(
		`INSERT INTO usage_intervals (organization_id, site_id, hour_start, issued, acked, accounting, settlement, closed_at)
		 VALUES (?, ?, '2026-11-10T00:00:00.000Z', 4, 4, 'exact', 'closed', 1), (?, ?, '2026-11-10T00:00:00.000Z', 90, 90, 'exact', 'closed', 1)`
	).run(ORG, SITE, OTHER_ORG, FOREIGN);
	SITES[SITE] = ORG;
	SITES[FOREIGN] = OTHER_ORG;
	return sql;
}

const owner = () => setup({ facts: () => facts({ ...member('owner'), ...fresh }) });

afterEach(() => {
	setUsageServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
});

describe('organisation usage', () => {
	it('shows the sites of the organisation for the month, with the plan allowance', async () => {
		world();
		owner();
		const reply = await send(orgUsage, '/api/v1/orgs/:orgId/usage', {
			path: `/api/v1/orgs/${ORG}/usage?month=2026-11`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			month: '2026-11',
			allowance: { views: 1000, pooled: false },
			total: { views: 4 }
		});
		expect((reply.json as { sites: { siteId: string }[] }).sites.map((s) => s.siteId)).toEqual([
			SITE
		]);
	});

	it('shows a free organisation its own sites only, and no allowance when none is listed', async () => {
		world(null);
		owner();
		const reply = await send(orgUsage, '/api/v1/orgs/:orgId/usage', {
			path: `/api/v1/orgs/${ORG}/usage?month=2026-11`,
			headers: asUser
		});
		expect(reply.json).toMatchObject({ allowance: { views: null } });
		expect(JSON.stringify(reply.json)).not.toContain(FOREIGN);
	});

	it('refuses another organisation through its own path', async () => {
		world();
		owner();
		const reply = await send(orgUsage, '/api/v1/orgs/:orgId/usage', {
			path: `/api/v1/orgs/${OTHER_ORG}/usage?month=2026-11`,
			headers: asUser
		});
		expect(reply.status).toBe(403);
	});

	it('refuses a month that is not YYYY-MM', async () => {
		world();
		owner();
		const reply = await send(orgUsage, '/api/v1/orgs/:orgId/usage', {
			path: `/api/v1/orgs/${ORG}/usage?month=2026-13`,
			headers: asUser
		});
		expect(reply.status).toBeGreaterThanOrEqual(400);
	});
});

describe('site usage', () => {
	it('shows one site of the organisation for the month, per day', async () => {
		world();
		owner();
		const reply = await send(siteUsage, '/api/v1/orgs/:orgId/sites/:id/usage', {
			path: `/api/v1/orgs/${ORG}/sites/${SITE}/usage?month=2026-11`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ siteId: SITE, views: 4, presentHours: 1 });
		expect((reply.json as { days: unknown[] }).days).toHaveLength(10);
	});

	it('does not show a site of another organisation, and does not say more than not found', async () => {
		world();
		owner();
		const reply = await send(siteUsage, '/api/v1/orgs/:orgId/sites/:id/usage', {
			path: `/api/v1/orgs/${ORG}/sites/${FOREIGN}/usage?month=2026-11`,
			headers: asUser
		});
		expect([403, 404]).toContain(reply.status);
		expect(reply.json).not.toHaveProperty('views');
	});
});
