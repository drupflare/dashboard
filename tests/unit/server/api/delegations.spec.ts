import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import delegationAccept from '../../../../src/server/api/v1/orgs/[orgId]/delegations/[id]/accept.post';
import delegationRevoke from '../../../../src/server/api/v1/orgs/[orgId]/delegations/[id]/revoke.post';
import delegationList from '../../../../src/server/api/v1/orgs/[orgId]/delegations/index.get';
import delegationCreate from '../../../../src/server/api/v1/orgs/[orgId]/delegations/index.post';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setDelegationServices,
	type DelegationServices
} from '../../../../src/server/services/delegations';
import type { LoadInput } from '../../../../src/server/utils/define-api';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup } from '../fixtures/harness';

const CREATE = '/api/v1/orgs/:orgId/delegations';
const LIST = '/api/v1/orgs/:orgId/delegations';
const ACCEPT = '/api/v1/orgs/:orgId/delegations/:id/accept';
const REVOKE = '/api/v1/orgs/:orgId/delegations/:id/revoke';
const NOW = 1_800_000_000_000;

function world() {
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
		},
		async allAllShards(text: string, bindings: unknown[] = []) {
			return [{ success: true, results: sql.prepare(text).all(...(bindings as never[])) }];
		}
	} as unknown as CollegeDBClient;
	const trail: { orgId: string; action: string; target: string }[] = [];
	const services: DelegationServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, action: input.action, target: input.target });
		},
		now: () => NOW
	};
	setDelegationServices(services);
	for (const id of [ORG, OTHER_ORG]) {
		sql.prepare(
			'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
		).run(id, id, 'seed');
	}
	sql.prepare(
		"INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at) VALUES ('site_aaaa1111', ?, 'one', 'managed', 'active', 1, 1), ('site_bbbb2222', ?, 'two', 'managed', 'active', 1, 1)"
	).run(ORG, OTHER_ORG);
	return { sql, trail };
}

type Options = { suspended?: string[] };

// the client owner acts for ORG; the agency admin acts for OTHER_ORG
function parties(options: Options = {}) {
	const flags = { suspendedOrgIds: options.suspended ?? [] };
	return setup({
		facts: (input: LoadInput) =>
			input.params.orgId === OTHER_ORG
				? facts({ membership: { orgId: OTHER_ORG, role: 'admin' }, ...fresh, flags })
				: facts({ ...member('owner'), ...fresh, flags })
	});
}

const create = (body: unknown) =>
	send(delegationCreate, CREATE, {
		method: 'POST',
		path: `/api/v1/orgs/${ORG}/delegations`,
		headers: asUser,
		json: body
	});

const offer = { agencyOrganizationId: OTHER_ORG, role: 'maintainer', sites: ['site_aaaa1111'] };

afterEach(() => {
	setDelegationServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
	world();
});

describe('POST /api/v1/orgs/:orgId/delegations', () => {
	it('offers the agency access to one site, pending, and audits both organisations', async () => {
		const w = world();
		parties();
		const reply = await create(offer);
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({
			clientOrganizationId: ORG,
			agencyOrganizationId: OTHER_ORG,
			role: 'maintainer',
			sites: ['site_aaaa1111'],
			state: 'pending'
		});
		expect(w.sql.prepare('SELECT state, site_id FROM delegations').all()).toEqual([
			{ state: 'pending', site_id: 'site_aaaa1111' }
		]);
		expect(w.trail.map((entry) => entry.orgId).sort()).toEqual([ORG, OTHER_ORG].sort());
	});

	it('stores all sites as one row with no site, and a batch of sites as one row each', async () => {
		const w = world();
		parties();
		await create({ ...offer, sites: 'all' });
		await create({ ...offer, role: 'viewer', sites: ['site_aaaa1111'] });
		const rows = w.sql.prepare('SELECT site_id, batch_id FROM delegations').all();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ site_id: null });
	});

	it('refuses a site that is not in the client organisation without saying where it is', async () => {
		const w = world();
		parties();
		const reply = await create({ ...offer, sites: ['site_bbbb2222'] });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_not_found' } });
		expect(w.sql.prepare('SELECT id FROM delegations').all()).toEqual([]);
	});

	it('refuses an agency that is the client itself, and an unknown agency the same way', async () => {
		const w = world();
		parties();
		expect((await create({ ...offer, agencyOrganizationId: ORG })).status).toBe(422);
		const unknown = await create({ ...offer, agencyOrganizationId: 'org-nobody' });
		expect(unknown.status).toBe(422);
		expect(unknown.json).toMatchObject({ details: { reason: 'agency_unknown' } });
		expect(w.sql.prepare('SELECT id FROM delegations').all()).toEqual([]);
	});

	it('refuses an expiry that is already past', async () => {
		parties();
		const reply = await create({ ...offer, expiresAt: '2001-01-01T00:00:00.000Z' });
		expect(reply.status).toBe(400);
	});
});

describe('accept, revoke and list', () => {
	async function offered() {
		const reply = await create(offer);
		return (reply.json as { id: string }).id;
	}

	it('lets the agency accept once, and refuses a second answer', async () => {
		const w = world();
		parties();
		const id = await offered();
		const path = `/api/v1/orgs/${OTHER_ORG}/delegations/${id}/accept`;
		const first = await send(delegationAccept, ACCEPT, {
			method: 'POST',
			path,
			headers: asUser,
			json: {}
		});
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ state: 'active' });
		const again = await send(delegationAccept, ACCEPT, {
			method: 'POST',
			path,
			headers: asUser,
			json: {}
		});
		expect(again.status).toBe(409);
		expect(w.trail.filter((entry) => entry.action === 'delegation.accepted')).toHaveLength(2);
	});

	it('keeps the client from accepting its own offer, and answers as not found', async () => {
		parties();
		const id = await offered();
		const reply = await send(delegationAccept, ACCEPT, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/delegations/${id}/accept`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(404);
	});

	it('refuses an agency that is suspended, whatever the offer says', async () => {
		parties({ suspended: [OTHER_ORG] });
		const id = await offered();
		const reply = await send(delegationAccept, ACCEPT, {
			method: 'POST',
			path: `/api/v1/orgs/${OTHER_ORG}/delegations/${id}/accept`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ code: 'forbidden' });
	});

	it('lets either side end the access, and ends it once', async () => {
		parties();
		const id = await offered();
		const byAgency = await send(delegationRevoke, REVOKE, {
			method: 'POST',
			path: `/api/v1/orgs/${OTHER_ORG}/delegations/${id}/revoke`,
			headers: asUser,
			json: {}
		});
		expect(byAgency.status).toBe(200);
		expect(byAgency.json).toMatchObject({ state: 'revoked' });
		const repeat = await send(delegationRevoke, REVOKE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/delegations/${id}/revoke`,
			headers: asUser,
			json: {}
		});
		expect(repeat.status).toBe(200);
		expect(repeat.json).toMatchObject({ state: 'revoked' });
	});

	it('shows the offer under sent for the client and under received for the agency only', async () => {
		parties();
		const id = await offered();
		const sent = await send(delegationList, LIST, {
			path: `/api/v1/orgs/${ORG}/delegations`,
			headers: asUser
		});
		expect(sent.json).toMatchObject({ sent: [{ id }], received: [] });
		const received = await send(delegationList, LIST, {
			path: `/api/v1/orgs/${OTHER_ORG}/delegations`,
			headers: asUser
		});
		expect(received.json).toMatchObject({ sent: [], received: [{ id }] });
	});
});
