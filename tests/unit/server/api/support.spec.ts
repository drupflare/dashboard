import type { CollegeDBClient } from '@earth-app/collegedb';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import suspend from '../../../../src/server/api/v1/admin/abuse/[id]/suspend.post';
import breakGlass from '../../../../src/server/api/v1/admin/break-glass/index.post';
import unsuspend from '../../../../src/server/api/v1/admin/sites/[id]/unsuspend.post';
import adminGrants from '../../../../src/server/api/v1/admin/support-grants/index.get';
import revoke from '../../../../src/server/api/v1/orgs/[orgId]/support-grants/[grantId].delete';
import orgGrantsList from '../../../../src/server/api/v1/orgs/[orgId]/support-grants/index.get';
import orgGrantsCreate from '../../../../src/server/api/v1/orgs/[orgId]/support-grants/index.post';
import { insertAbuseReport } from '../../../../src/server/db/repos/abuse';
import { createOrganization } from '../../../../src/server/db/repos/organization';
import { setSupportServices, type SupportServices } from '../../../../src/server/services/support';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { admin, facts, fresh, ORG } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const SITE = 'site_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REASON = 'Site down and the owner is unreachable';
const CREATE = { scope: 'act', hours: 24, reason: 'Help with the upgrade' };

interface Statement {
	key: string;
	sql: string;
	bindings?: SQLInputValue[];
}

function world() {
	const { raw, client } = sqliteClient();
	Object.assign(client, {
		async batch(statements: Statement[]) {
			return statements.map((s) => ({
				success: true,
				results: [],
				meta: { changes: Number(raw.prepare(s.sql).run(...(s.bindings ?? [])).changes) }
			}));
		},
		async allAllShards(sql: string, params: SQLInputValue[] = []) {
			return [{ success: true, results: raw.prepare(sql).all(...params) }];
		}
	});
	let n = 0;
	const mails: string[] = [];
	const started: unknown[] = [];
	const services: SupportServices = {
		getDb: async () => client as CollegeDBClient,
		audit: async () => undefined,
		ownerEmails: async () => ['a@example.test', 'b@example.test'],
		notify: async (to) => void mails.push(to),
		startOperation: async (request) => void started.push(request),
		newId: () => `sg_${++n}`,
		now: () => Date.now()
	};
	setSupportServices(services);
	return { raw, client: client as CollegeDBClient, mails, started };
}

afterEach(() => {
	resetApiDeps();
	setSupportServices(null);
});

const orgPath = `/api/v1/orgs/${ORG}/support-grants`;
const createGrant = (headers: Record<string, string> = asUser) =>
	send(orgGrantsCreate, '/api/v1/orgs/:orgId/support-grants', {
		method: 'POST',
		path: orgPath,
		headers,
		json: CREATE
	});

describe('support grant routes for a customer', () => {
	it('lets an owner grant, list and revoke support access', async () => {
		world();
		setup({ role: 'owner' });
		const made = await createGrant();
		expect(made.status).toBe(201);
		const id = (made.json as { id: string }).id;

		const list = await send(orgGrantsList, '/api/v1/orgs/:orgId/support-grants', {
			path: orgPath,
			headers: asUser
		});
		expect((list.json as { items: { id: string; live: boolean }[] }).items).toEqual([
			expect.objectContaining({ id, live: true })
		]);

		const gone = await send(revoke, '/api/v1/orgs/:orgId/support-grants/:grantId', {
			method: 'DELETE',
			path: `${orgPath}/${id}`,
			headers: asUser
		});
		expect(gone.status).toBe(204);
		const after = await send(orgGrantsList, '/api/v1/orgs/:orgId/support-grants', {
			path: orgPath,
			headers: asUser
		});
		expect((after.json as { items: { live: boolean }[] }).items[0]?.live).toBe(false);
	});

	it('refuses a role below admin, a key, and a grant without step-up', async () => {
		world();
		setup({ role: 'developer' });
		expect((await createGrant()).status).toBe(403);
		setup({ role: 'owner', facts: () => facts({ membership: { orgId: ORG, role: 'owner' } }) });
		expect((await createGrant()).status).toBe(403);
		setup({ role: 'owner' });
		expect((await createGrant(asKey)).status).toBe(403);
	});

	it('answers an organization the person does not belong to as missing', async () => {
		world();
		setup({ role: 'owner' });
		const reply = await send(orgGrantsList, '/api/v1/orgs/:orgId/support-grants', {
			path: '/api/v1/orgs/org-unknown/support-grants',
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});

	it('rejects a grant of more than seven days at the door', async () => {
		world();
		setup({ role: 'owner' });
		const reply = await send(orgGrantsCreate, '/api/v1/orgs/:orgId/support-grants', {
			method: 'POST',
			path: orgPath,
			headers: asUser,
			json: { ...CREATE, hours: 169 }
		});
		expect(reply.status).toBe(400);
	});
});

describe('admin support routes', () => {
	const adminFacts = (stepUp: boolean) => () => facts({ ...admin, ...(stepUp ? fresh : {}) });

	it('lists live grants and break-glass starts for a platform admin only', async () => {
		world();
		setup({ facts: adminFacts(false) });
		const ok = await send(adminGrants, '/api/v1/admin/support-grants', {
			path: '/api/v1/admin/support-grants',
			headers: asUser
		});
		expect(ok.status).toBe(200);
		expect(ok.json).toEqual({ grants: [], breakGlass: [] });
		setup({ role: 'owner' });
		const refused = await send(adminGrants, '/api/v1/admin/support-grants', {
			path: '/api/v1/admin/support-grants',
			headers: asUser
		});
		expect(refused.status).toBe(403);
	});

	const start = (json: unknown) =>
		send(breakGlass, '/api/v1/admin/break-glass', {
			method: 'POST',
			path: '/api/v1/admin/break-glass',
			headers: asUser,
			json
		});

	it('starts break-glass access after step-up and tells the owners', async () => {
		const w = world();
		const org = await createOrganization(w.client, {
			name: 'Campus',
			personal: false,
			createdBy: 'user-1'
		});
		setup({ facts: adminFacts(true) });
		const reply = await start({ organizationId: org.id, reason: REASON });
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({ organizationId: org.id, ownersNotified: 2, live: true });
		expect(w.mails).toHaveLength(2);
	});

	it('refuses a missing or short reason, a missing step-up and an unknown organization', async () => {
		const w = world();
		const org = await createOrganization(w.client, {
			name: 'Campus',
			personal: false,
			createdBy: 'user-1'
		});
		setup({ facts: adminFacts(true) });
		expect((await start({ organizationId: org.id })).status).toBe(400);
		expect((await start({ organizationId: org.id, reason: 'no' })).status).toBe(400);
		expect((await start({ organizationId: org.id, reason: '          ' })).status).toBe(400);
		expect((await start({ organizationId: 'org_none', reason: REASON })).status).toBe(404);
		setup({ facts: adminFacts(false) });
		expect((await start({ organizationId: org.id, reason: REASON })).status).toBe(403);
		expect(w.mails).toEqual([]);
	});

	it('answers 429 once one admin has started too many in a day', async () => {
		const w = world();
		const org = await createOrganization(w.client, {
			name: 'Campus',
			personal: false,
			createdBy: 'user-1'
		});
		setup({ facts: adminFacts(true) });
		for (let i = 0; i < 3; i++) {
			expect((await start({ organizationId: org.id, reason: REASON })).status).toBe(201);
		}
		expect((await start({ organizationId: org.id, reason: REASON })).status).toBe(429);
	});
});

describe('suspension routes', () => {
	const adminFacts = (stepUp: boolean) => () => facts({ ...admin, ...(stepUp ? fresh : {}) });
	const siteWorld = async () => {
		const w = world();
		addReadySite(w.raw, ORG, SITE);
		w.raw.prepare("UPDATE sites SET account_id = 'acct_1'").run();
		await insertAbuseReport(w.client, {
			id: 'abuse_1',
			siteId: SITE,
			organizationId: ORG,
			source: 'report',
			reason: 'phishing',
			now: 1
		});
		return w;
	};
	const doSuspend = () =>
		send(suspend, '/api/v1/admin/abuse/:id/suspend', {
			method: 'POST',
			path: '/api/v1/admin/abuse/abuse_1/suspend',
			headers: asUser,
			json: {}
		});

	it('suspends from a report, closes it and returns the operation', async () => {
		const w = await siteWorld();
		setup({ facts: adminFacts(false) });
		const reply = await doSuspend();
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({
			report: { state: 'actioned' },
			operation: { type: 'config.apply' },
			ownersNotified: 2
		});
		expect(w.started).toHaveLength(1);
	});

	it('refuses an admin who lacks the support permission and a person who is no admin', async () => {
		const w = await siteWorld();
		setup({
			facts: () => facts({ platform: { admin: true, access: true, permissions: ['read'] } })
		});
		expect((await doSuspend()).status).toBe(403);
		setup({ role: 'owner' });
		expect((await doSuspend()).status).toBe(403);
		expect(w.started).toEqual([]);
	});

	it('needs step-up to lift a suspension', async () => {
		const w = await siteWorld();
		w.raw.prepare("UPDATE sites SET state = 'suspended'").run();
		const lift = () =>
			send(unsuspend, '/api/v1/admin/sites/:id/unsuspend', {
				method: 'POST',
				path: `/api/v1/admin/sites/${SITE}/unsuspend`,
				headers: asUser,
				json: {}
			});
		setup({ facts: adminFacts(false) });
		expect((await lift()).status).toBe(403);
		setup({ facts: adminFacts(true) });
		const reply = await lift();
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ ownersNotified: 2 });
		expect(w.started).toHaveLength(1);
	});
});
