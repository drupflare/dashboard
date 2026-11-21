import { afterEach, describe, expect, it } from 'vitest';
import orgGet from '../../../../src/server/api/v1/orgs/[orgId]/budget.get';
import orgPut from '../../../../src/server/api/v1/orgs/[orgId]/budget.put';
import siteGet from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/budget.get';
import sitePut from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/budget.put';
import { FREE_PLAN_ID } from '../../../../src/server/domain/entitlements';
import { seedOrgBudgetFor, setBudgetServices } from '../../../../src/server/services/budgets';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup, SITES } from '../fixtures/harness';
import { world } from '../services/budgets-support';

const SITE_A = 'site_budget0001';
const SITE_B = 'site_budget0002';
const FOREIGN = 'site_budget0003';
SITES[SITE_A] = ORG;
SITES[SITE_B] = ORG;
SITES[FOREIGN] = OTHER_ORG;

afterEach(() => {
	resetApiDeps();
	setBudgetServices(null);
});

const ORG_ROUTE = '/api/v1/orgs/:orgId/budget';
const SITE_ROUTE = '/api/v1/orgs/:orgId/sites/:id/budget';

async function ready(options: Parameters<typeof world>[0] = {}) {
	const w = world({ sites: [SITE_A, SITE_B], ...options });
	setBudgetServices(w.services);
	await seedOrgBudgetFor(w.services, ORG);
	return w;
}

const putOrg = (
	json: unknown,
	path = `/api/v1/orgs/${ORG}/budget`,
	headers: Record<string, string> = asUser
) => send(orgPut, ORG_ROUTE, { method: 'PUT', path, json, headers });

const putSite = (
	json: unknown,
	siteId = SITE_A,
	orgId = ORG,
	headers: Record<string, string> = asUser
) =>
	send(sitePut, SITE_ROUTE, {
		method: 'PUT',
		path: `/api/v1/orgs/${orgId}/sites/${siteId}/budget`,
		json,
		headers
	});

const notFresh = () => facts({ ...member('owner') });
const keyOwner = (input: { principal: { kind: string } }) => ({
	...facts({ ...member('owner'), ...fresh }),
	...(input.principal.kind === 'key' ? { key: { id: 'key-1', scopes: ['billing.manage'] } } : {})
});

describe('GET budget', () => {
	it('reads the organisation budget with state, counts and the flag', async () => {
		setup();
		await ready();
		const reply = await send(orgGet, ORG_ROUTE, {
			path: `/api/v1/orgs/${ORG}/budget`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			status: 'ok',
			scope: 'org',
			percent: 500,
			enforcement: 'block',
			allowanceViews: 1_000_000,
			accounting: 'counted',
			state: 'ok',
			enforcementFlag: 'shadow',
			alertsSent: [],
			dollars: { kind: 'unreviewed' }
		});
		expect((reply.json as { appliesWithin: string }).appliesWithin).not.toMatch(/instant/i);
	});

	it('says whether overage is billed, from the billing flag, on the organisation and the site', async () => {
		setup();
		await ready();
		const off = await send(orgGet, ORG_ROUTE, {
			path: `/api/v1/orgs/${ORG}/budget`,
			headers: asUser
		});
		expect(off.json).toMatchObject({ overageBilled: false });

		setup();
		await ready({ overageBilled: true });
		const on = await send(orgGet, ORG_ROUTE, {
			path: `/api/v1/orgs/${ORG}/budget`,
			headers: asUser
		});
		expect(on.json).toMatchObject({ overageBilled: true });
		const site = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/${SITE_A}/budget`,
			headers: asUser
		});
		expect(site.json).toMatchObject({ overageBilled: true });
	});

	it('reads a site budget with the default share', async () => {
		setup();
		await ready();
		const reply = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/${SITE_A}/budget`,
			headers: asUser
		});
		expect(reply.json).toMatchObject({
			scope: 'site',
			siteId: SITE_A,
			percent: 250,
			ownerSet: false
		});
	});

	it('answers not_applicable for a free organisation', async () => {
		setup();
		await ready({ plan: FREE_PLAN_ID });
		const org = await send(orgGet, ORG_ROUTE, {
			path: `/api/v1/orgs/${ORG}/budget`,
			headers: asUser
		});
		const site = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/${SITE_A}/budget`,
			headers: asUser
		});
		expect(org.json).toEqual({ status: 'not_applicable' });
		expect(site.json).toEqual({ status: 'not_applicable' });
	});

	it('refuses a viewer and a developer, and allows the owner and a billing member', async () => {
		for (const [role, status] of [
			['viewer', 403],
			['developer', 403],
			['admin', 403],
			['billing', 200],
			['owner', 200]
		] as const) {
			setup({ role });
			await ready();
			const reply = await send(orgGet, ORG_ROUTE, {
				path: `/api/v1/orgs/${ORG}/budget`,
				headers: asUser
			});
			expect(reply.status, role).toBe(status);
			resetApiDeps();
		}
	});

	it('does not read another organisation or its site', async () => {
		setup();
		await ready();
		const otherOrg = await send(orgGet, ORG_ROUTE, {
			path: `/api/v1/orgs/${OTHER_ORG}/budget`,
			headers: asUser
		});
		expect([403, 404]).toContain(otherOrg.status);
		const foreignSite = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/${FOREIGN}/budget`,
			headers: asUser
		});
		expect([403, 404]).toContain(foreignSite.status);
		const crossed = await send(siteGet, SITE_ROUTE, {
			path: `/api/v1/orgs/${OTHER_ORG}/sites/${SITE_A}/budget`,
			headers: asUser
		});
		expect([403, 404]).toContain(crossed.status);
	});
});

describe('PUT organisation budget', () => {
	it('lowers with the permission alone and tells the caller when it applies', async () => {
		setup({ facts: notFresh });
		const w = await ready();
		const reply = await putOrg({ percent: 300, enforcement: 'block' });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ percent: 300, changed: true });
		expect(w.reevaluated()).toEqual([ORG]);
		expect(w.audits.at(-1)?.input.action).toBe('budget.set');
	});

	it('refuses a raise without a fresh session and allows it with one', async () => {
		setup({ facts: notFresh });
		const w = await ready();
		const refused = await putOrg({ percent: 800, enforcement: 'block' });
		expect(refused.status).toBe(403);
		expect(refused.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(w.rows[0]?.percent).toBe(500);
		resetApiDeps();
		setup();
		const raised = await putOrg({ percent: 800, enforcement: 'block' });
		expect(raised.status).toBe(200);
		expect(w.rows[0]?.percent).toBe(800);
	});

	it('refuses block to alert without a fresh session', async () => {
		setup({ facts: notFresh });
		await ready();
		const reply = await putOrg({ percent: 500, enforcement: 'alert' });
		expect(reply.status).toBe(403);
	});

	it('refuses a key that raises, since a key never has a fresh session, and lets it lower', async () => {
		setup({ facts: keyOwner });
		const w = await ready();
		const raise = await putOrg({ percent: 900, enforcement: 'block' }, undefined, asKey);
		expect(raise.status).toBe(403);
		const lower = await putOrg({ percent: 200, enforcement: 'block' }, undefined, asKey);
		expect(lower.status).toBe(200);
		expect(w.rows[0]?.percent).toBe(200);
		expect(w.rows[0]?.setBy).toBe('key:key-1');
	});

	it('refuses a percent out of range with a plain reason, and unknown fields', async () => {
		setup();
		await ready();
		const low = await putOrg({ percent: 50, enforcement: 'block' });
		expect(low.status).toBe(400);
		expect((low.json as { message: string }).message).toContain('lowest budget is 100 percent');
		const extra = await putOrg({ percent: 300, enforcement: 'block', owner: 'x' });
		expect(extra.status).toBe(400);
	});

	it('refuses a viewer and another organisation', async () => {
		setup({ role: 'viewer' });
		await ready();
		expect((await putOrg({ percent: 300, enforcement: 'block' })).status).toBe(403);
		resetApiDeps();
		setup();
		const other = await putOrg(
			{ percent: 300, enforcement: 'block' },
			`/api/v1/orgs/${OTHER_ORG}/budget`
		);
		expect([403, 404]).toContain(other.status);
	});

	it('writes nothing for a free organisation', async () => {
		setup();
		const w = await ready({ plan: FREE_PLAN_ID });
		const reply = await putOrg({ percent: 300, enforcement: 'block' });
		expect(reply.json).toEqual({ status: 'not_applicable' });
		expect(w.rows).toEqual([]);
	});
});

describe('PUT site budget', () => {
	it('sets a site budget under the organisation percent', async () => {
		setup({ facts: notFresh });
		const w = await ready();
		const reply = await putSite({ percent: 200, enforcement: 'block' });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ scope: 'site', percent: 200, ownerSet: true });
		expect(w.audits.at(-1)?.input).toMatchObject({ target: SITE_A });
	});

	it('refuses a percent above the organisation percent with a reason', async () => {
		setup();
		await ready();
		await putOrg({ percent: 400, enforcement: 'block' });
		const reply = await putSite({ percent: 450, enforcement: 'block' });
		expect(reply.status).toBe(400);
		expect((reply.json as { message: string }).message).toContain('400 percent');
	});

	it('refuses a raise without a fresh session', async () => {
		setup({ facts: notFresh });
		await ready();
		await putSite({ percent: 200, enforcement: 'block' });
		const reply = await putSite({ percent: 300, enforcement: 'block' });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
	});

	it('does not write to a site of another organisation or through another organisation path', async () => {
		setup();
		const w = await ready();
		const foreign = await putSite({ percent: 200, enforcement: 'block' }, FOREIGN);
		expect([403, 404]).toContain(foreign.status);
		const crossed = await putSite({ percent: 200, enforcement: 'block' }, SITE_A, OTHER_ORG);
		expect([403, 404]).toContain(crossed.status);
		expect(w.rows.filter((row) => row.scope === 'site')).toEqual([]);
	});

	it('refuses a viewer', async () => {
		setup({ role: 'viewer' });
		await ready();
		expect((await putSite({ percent: 200, enforcement: 'block' })).status).toBe(403);
	});
});
