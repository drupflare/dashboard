import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { siteId } from '../../../../contracts/src/common';
import clientDelete from '../../../../src/server/api/v1/orgs/[orgId]/clients/[id].delete';
import clientUpdate from '../../../../src/server/api/v1/orgs/[orgId]/clients/[id].put';
import clientUsage from '../../../../src/server/api/v1/orgs/[orgId]/clients/[id]/usage.get';
import clientList from '../../../../src/server/api/v1/orgs/[orgId]/clients/index.get';
import clientCreate from '../../../../src/server/api/v1/orgs/[orgId]/clients/index.post';
import clientSiteRemove from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/clients/[clientId].delete';
import clientSiteAdd from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/clients/[clientId].put';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setClientServices,
	type ClientServices,
	type UsageSampleRead
} from '../../../../src/server/services/client-workspaces';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

const SITE = 'site_aaaa1111';
const FOREIGN = 'site_bbbb2222';
const NOW = 1_800_000_000_000;

function world(usage?: UsageSampleRead) {
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
	const trail: { orgId: string; action: string }[] = [];
	const services: ClientServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, action: input.action });
		},
		now: () => NOW,
		...(usage === undefined ? {} : { usage })
	};
	setClientServices(services);
	for (const id of [ORG, OTHER_ORG]) {
		sql.prepare(
			'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
		).run(id, id, 'seed');
	}
	sql.prepare(
		"INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at) VALUES (?, ?, 'one', 'managed', 'active', 1, 1), (?, ?, 'two', 'managed', 'active', 1, 1)"
	).run(SITE, ORG, FOREIGN, OTHER_ORG);
	SITES[SITE] = ORG;
	SITES[FOREIGN] = OTHER_ORG;
	return { sql, trail };
}

const owner = () => setup({ facts: () => facts({ ...member('owner'), ...fresh }) });

const body = { name: 'Acme Library', contactName: 'Pat', contactEmail: 'pat@example.org' };

async function createClient(): Promise<string> {
	const reply = await send(clientCreate, '/api/v1/orgs/:orgId/clients', {
		method: 'POST',
		path: `/api/v1/orgs/${ORG}/clients`,
		headers: asUser,
		json: body
	});
	return (reply.json as { id: string }).id;
}

afterEach(() => {
	setClientServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
	world();
});

describe('client workspaces', () => {
	it('creates a client with its contacts and lists it with no sites yet', async () => {
		const w = world();
		owner();
		const id = await createClient();
		const listed = await send(clientList, '/api/v1/orgs/:orgId/clients', {
			path: `/api/v1/orgs/${ORG}/clients`,
			headers: asUser
		});
		expect(listed.json).toMatchObject({
			items: [{ id, name: 'Acme Library', contactEmail: 'pat@example.org', siteIds: [] }]
		});
		expect(w.trail).toEqual([{ orgId: ORG, action: 'client.created' }]);
	});

	it('refuses a contact email that is not an address', async () => {
		owner();
		const reply = await send(clientCreate, '/api/v1/orgs/:orgId/clients', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/clients`,
			headers: asUser,
			json: { ...body, contactEmail: 'not-an-address' }
		});
		expect(reply.status).toBe(400);
	});

	it('changes the details and keeps the sites under it', async () => {
		owner();
		const id = await createClient();
		await send(clientSiteAdd, '/api/v1/orgs/:orgId/sites/:id/clients/:clientId', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
			headers: asUser,
			json: {}
		});
		const updated = await send(clientUpdate, '/api/v1/orgs/:orgId/clients/:id', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/clients/${id}`,
			headers: asUser,
			json: { ...body, name: 'Acme Library Consortium', notes: 'Renews in March' }
		});
		expect(updated.json).toMatchObject({
			name: 'Acme Library Consortium',
			notes: 'Renews in March',
			siteIds: [SITE]
		});
	});

	it('groups a site under one client only', async () => {
		owner();
		const first = await createClient();
		const second = await send(clientCreate, '/api/v1/orgs/:orgId/clients', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/clients`,
			headers: asUser,
			json: { name: 'Second' }
		});
		const secondId = (second.json as { id: string }).id;
		const add = (id: string) =>
			send(clientSiteAdd, '/api/v1/orgs/:orgId/sites/:id/clients/:clientId', {
				method: 'PUT',
				path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
				headers: asUser,
				json: {}
			});
		expect((await add(first)).status).toBe(200);
		const clash = await add(secondId);
		expect(clash.status).toBe(409);
		expect(clash.json).toMatchObject({ details: { reason: 'site_grouped' } });
	});

	it('refuses a site of another organisation, without saying more than not in this organisation', async () => {
		owner();
		const id = await createClient();
		const reply = await send(clientSiteAdd, '/api/v1/orgs/:orgId/sites/:id/clients/:clientId', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/sites/${FOREIGN}/clients/${id}`,
			headers: asUser,
			json: {}
		});
		expect([403, 404]).toContain(reply.status);
		expect(reply.json).not.toHaveProperty('siteId');
	});

	it('removes a site from a client, and answers not found for a site not there', async () => {
		owner();
		const id = await createClient();
		await send(clientSiteAdd, '/api/v1/orgs/:orgId/sites/:id/clients/:clientId', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
			headers: asUser,
			json: {}
		});
		const removed = await send(
			clientSiteRemove,
			'/api/v1/orgs/:orgId/sites/:id/clients/:clientId',
			{
				method: 'DELETE',
				path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
				headers: asUser
			}
		);
		expect(removed.json).toEqual({ deleted: true });
		const again = await send(
			clientSiteRemove,
			'/api/v1/orgs/:orgId/sites/:id/clients/:clientId',
			{
				method: 'DELETE',
				path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
				headers: asUser
			}
		);
		expect(again.status).toBe(404);
	});

	it('deletes a client and answers not found for it afterwards', async () => {
		owner();
		const id = await createClient();
		const gone = await send(clientDelete, '/api/v1/orgs/:orgId/clients/:id', {
			method: 'DELETE',
			path: `/api/v1/orgs/${ORG}/clients/${id}`,
			headers: asUser
		});
		expect(gone.json).toEqual({ deleted: true });
		const repeat = await send(clientDelete, '/api/v1/orgs/:orgId/clients/:id', {
			method: 'DELETE',
			path: `/api/v1/orgs/${ORG}/clients/${id}`,
			headers: asUser
		});
		expect(repeat.status).toBe(404);
	});

	it("does not reach another organisation's client through its own path", async () => {
		owner();
		const reply = await send(clientUpdate, '/api/v1/orgs/:orgId/clients/:id', {
			method: 'PUT',
			path: `/api/v1/orgs/${OTHER_ORG}/clients/anything`,
			headers: asUser,
			json: body
		});
		expect(reply.status).toBe(403);
	});
});

describe('client usage export', () => {
	it('answers not built until the per-site usage read is wired', async () => {
		owner();
		const id = await createClient();
		const reply = await send(clientUsage, '/api/v1/orgs/:orgId/clients/:id/usage', {
			path: `/api/v1/orgs/${ORG}/clients/${id}/usage?from=2026-01&to=2026-02`,
			headers: asUser
		});
		expect(reply.status).toBe(501);
	});

	it('writes one row per site and month, with unaccounted hours counted apart', async () => {
		world(async ({ siteIds }) => [
			{
				siteId: siteId.parse(siteIds[0] as string),
				start: '2026-01-15T10:00:00.000Z',
				accuracy: 'exact',
				views: 7,
				lowerBound: 7
			},
			{
				siteId: siteId.parse(siteIds[0] as string),
				start: '2026-01-15T11:00:00.000Z',
				accuracy: 'unaccounted',
				views: 0,
				lowerBound: 0
			}
		]);
		owner();
		const id = await createClient();
		await send(clientSiteAdd, '/api/v1/orgs/:orgId/sites/:id/clients/:clientId', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/sites/${SITE}/clients/${id}`,
			headers: asUser,
			json: {}
		});
		const reply = await send(clientUsage, '/api/v1/orgs/:orgId/clients/:id/usage', {
			path: `/api/v1/orgs/${ORG}/clients/${id}/usage?from=2026-01&to=2026-02`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.headers.get('content-type')).toContain('text/csv');
		expect(reply.text).toBe(
			`month,site_id,views,lower_bound,unaccounted_hours\n2026-01,${SITE},7,7,1\n`
		);
	});

	it('refuses a range longer than twenty four months, and a reversed one', async () => {
		owner();
		const id = await createClient();
		const long = await send(clientUsage, '/api/v1/orgs/:orgId/clients/:id/usage', {
			path: `/api/v1/orgs/${ORG}/clients/${id}/usage?from=2024-01&to=2026-02`,
			headers: asUser
		});
		expect(long.status).toBe(400);
		const reversed = await send(clientUsage, '/api/v1/orgs/:orgId/clients/:id/usage', {
			path: `/api/v1/orgs/${ORG}/clients/${id}/usage?from=2026-05&to=2026-03`,
			headers: asUser
		});
		expect(reversed.status).toBe(400);
	});
});
