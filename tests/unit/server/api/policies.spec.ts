import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import policyAssign from '../../../../src/server/api/v1/orgs/[orgId]/policies/[policyId]/assignments.post';
import policyUnassign from '../../../../src/server/api/v1/orgs/[orgId]/policies/[policyId]/assignments/[kind]/[targetId].delete';
import policyDelete from '../../../../src/server/api/v1/orgs/[orgId]/policies/[policyId]/index.delete';
import policyUpdate from '../../../../src/server/api/v1/orgs/[orgId]/policies/[policyId]/index.put';
import classificationLabel from '../../../../src/server/api/v1/orgs/[orgId]/policies/classifications/[label].put';
import policyList from '../../../../src/server/api/v1/orgs/[orgId]/policies/index.get';
import policyCreate from '../../../../src/server/api/v1/orgs/[orgId]/policies/index.post';
import siteClassRead from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/classification.get';
import siteClassSet from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/classification.put';
import { getDepartment } from '../../../../src/server/db/repos/departments';
import { getMember } from '../../../../src/server/db/repos/organization';
import { loadPolicyFor } from '../../../../src/server/db/repos/policies';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import { factsLoader, type FactsStore } from '../../../../src/server/services/facts';
import { setPolicyServices, type PolicyServices } from '../../../../src/server/services/policies';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG, OTHER_ORG, SITE } from '../../domain/fixtures';
import { asUser, send, setup } from '../fixtures/harness';

const BASE = `/api/v1/orgs/${ORG}`;
const R = '/api/v1/orgs/:orgId';
const P = `${R}/policies/:policyId`;

function world(role: 'owner' | 'admin' | 'developer' | 'viewer' | null = 'owner') {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) {
		if (
			/department|policy|classification|TABLE IF NOT EXISTS (sites|members|users) /.test(
				statement
			)
		) {
			sql.exec(statement);
		}
	}
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
	const exec = (text: string, ...bindings: unknown[]) =>
		sql.prepare(text).run(...(bindings as never[]));
	for (const [id, email] of [
		['user-1', 'one@example.test'],
		['user-2', 'two@example.test']
	]) {
		exec(
			'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)',
			id,
			email
		);
	}
	const member = (org: string, user: string, r: string) =>
		exec(
			'INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
			`m-${org}-${user}`,
			org,
			user,
			r
		);
	if (role !== null) member(ORG, 'user-1', role);
	member(OTHER_ORG, 'user-2', 'owner');
	exec(
		'INSERT INTO departments (id, organization_id, parent_id, name, kind, created_at) VALUES (?, ?, NULL, ?, ?, 1)',
		'd-a',
		ORG,
		'Campus',
		'department'
	);
	exec(
		'INSERT INTO departments (id, organization_id, parent_id, name, kind, created_at) VALUES (?, ?, NULL, ?, ?, 1)',
		'd-x',
		OTHER_ORG,
		'Foreign',
		'department'
	);
	exec(
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES (?, ?, 'one', 'managed', 'active', 1, 1)`,
		SITE,
		ORG
	);
	exec(
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES ('site-2', ?, 'two', 'managed', 'active', 1, 1)`,
		OTHER_ORG
	);
	exec(
		`INSERT INTO policy_groups (id, organization_id, name, rules, created_at) VALUES ('pol-x', ?, 'Foreign', '{}', 1)`,
		OTHER_ORG
	);

	const store: FactsStore = {
		organization: async (id) => ([ORG, OTHER_ORG].includes(id) ? { id } : null),
		site: async (id) =>
			id === SITE ? { id, orgId: ORG } : id === 'site-2' ? { id, orgId: OTHER_ORG } : null,
		member: async (orgId, userId) => {
			const row = await getMember(db, orgId, userId);
			return row ? { orgId: row.organizationId, role: row.role } : null;
		},
		siteGrants: async () => [],
		delegations: async () => [],
		department: async (orgId, id) => {
			const row = await getDepartment(db, orgId, id);
			return row ? { id: row.id } : null;
		}
	};
	const trail: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
	const services: PolicyServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, ...input });
		},
		newId: () => `n${trail.length}${Math.random().toString(36).slice(2, 8)}`,
		now: () => 7000
	};
	setPolicyServices(services);
	const harness = setup({
		deps: {
			load: factsLoader({ store, policy: (input) => loadPolicyFor(db, input) })
		}
	});
	return { sql, db, trail, exec, harness };
}

afterEach(() => {
	setPolicyServices(null);
	resetApiDeps();
});

const rows = (w: ReturnType<typeof world>, text: string, ...b: unknown[]) =>
	w.sql.prepare(text).all(...(b as never[])) as Record<string, unknown>[];

const create = (json: unknown, headers: Record<string, string> = asUser) =>
	send(policyCreate, `${R}/policies`, {
		method: 'POST',
		path: `${BASE}/policies`,
		headers,
		json
	});

describe('GET policies', () => {
	it('lists groups and the four labels for a viewer', async () => {
		const w = world('viewer');
		w.exec(
			`INSERT INTO policy_groups (id, organization_id, name, rules, created_at) VALUES ('pol-a', ?, 'A', '{"maxPreviewHours":24}', 1)`,
			ORG
		);
		const reply = await send(policyList, `${R}/policies`, {
			path: `${BASE}/policies`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const body = reply.json as {
			items: { id: string }[];
			classifications: { label: string }[];
		};
		expect(body.items.map((i) => i.id)).toEqual(['pol-a']);
		expect(body.classifications.map((c) => c.label)).toEqual([
			'public',
			'internal',
			'restricted',
			'regulated'
		]);
	});

	it('answers not found with no tie, and for another organisation', async () => {
		world(null);
		const none = await send(policyList, `${R}/policies`, {
			path: `${BASE}/policies`,
			headers: asUser
		});
		expect(none.status).toBe(404);
		world();
		const other = await send(policyList, `${R}/policies`, {
			path: `/api/v1/orgs/${OTHER_ORG}/policies`,
			headers: asUser
		});
		expect(other.status).toBe(404);
	});
});

describe('POST policies', () => {
	it('creates for an admin and audits it', async () => {
		const w = world('admin');
		const reply = await create({
			name: 'Regulated',
			rules: { stepUpActions: ['site.delete'] }
		});
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({ name: 'Regulated', assignments: [] });
		expect(w.trail.at(-1)).toMatchObject({ orgId: ORG, action: 'policy.created' });
	});

	it('refuses a developer and a viewer', async () => {
		world('developer');
		expect((await create({ name: 'X', rules: {} })).status).toBe(403);
		world('viewer');
		expect((await create({ name: 'X', rules: {} })).status).toBe(403);
	});

	it('refuses unknown fields, an action that does not exist and a block on policy management', async () => {
		world();
		expect((await create({ name: 'X', rules: { nope: 1 } })).status).toBe(400);
		expect((await create({ name: 'X', rules: { stepUpActions: ['site.fly'] } })).status).toBe(
			400
		);
		expect((await create({ name: 'X', rules: { blockedActions: ['*'] } })).status).toBe(400);
		expect((await create({ name: '  ', rules: {} })).status).toBe(400);
		expect((await create({ name: 'X', rules: {}, organizationId: OTHER_ORG })).status).toBe(
			400
		);
	});

	it('refuses a duplicate name', async () => {
		world();
		await create({ name: 'Same', rules: {} });
		expect((await create({ name: 'same', rules: {} })).status).toBe(409);
	});
});

describe('PUT and DELETE a policy group', () => {
	const update = (id: string, json: unknown) =>
		send(policyUpdate, `${P}`, {
			method: 'PUT',
			path: `${BASE}/policies/${id}`,
			headers: asUser,
			json
		});
	const remove = (id: string) =>
		send(policyDelete, `${P}`, {
			method: 'DELETE',
			path: `${BASE}/policies/${id}`,
			headers: asUser
		});

	it('updates its own group and answers not found for one that belongs to another organisation', async () => {
		const w = world();
		const made = (await create({ name: 'Mine', rules: {} })).json as { id: string };
		expect(
			(await update(made.id, { name: 'Mine 2', rules: { maxPreviewHours: 12 } })).status
		).toBe(200);
		expect(w.trail.at(-1)).toMatchObject({ action: 'policy.updated', target: made.id });
		expect((await update('pol-x', { name: 'Hijacked', rules: {} })).status).toBe(404);
		expect(rows(w, `SELECT name FROM policy_groups WHERE id = 'pol-x'`)[0]?.name).toBe(
			'Foreign'
		);
	});

	it('refuses a delete while assigned and deletes after, and cannot delete another organisation group', async () => {
		const w = world();
		const made = (await create({ name: 'Busy', rules: {} })).json as { id: string };
		const assign = await send(policyAssign, `${P}/assignments`, {
			method: 'POST',
			path: `${BASE}/policies/${made.id}/assignments`,
			headers: asUser,
			json: { kind: 'organization', targetId: ORG }
		});
		expect(assign.status).toBe(200);
		const refused = await remove(made.id);
		expect(refused.status).toBe(409);
		expect(refused.json).toMatchObject({ details: { reason: 'assigned' } });
		const off = await send(policyUnassign, `${P}/assignments/:kind/:targetId`, {
			method: 'DELETE',
			path: `${BASE}/policies/${made.id}/assignments/organization/${ORG}`,
			headers: asUser
		});
		expect(off.status).toBe(204);
		expect((await remove(made.id)).status).toBe(204);
		expect((await remove('pol-x')).status).toBe(404);
		expect(w.trail.map((t) => t.action)).toEqual([
			'policy.created',
			'policy.assigned',
			'policy.unassigned',
			'policy.deleted'
		]);
	});
});

describe('assignments', () => {
	const assign = (id: string, json: unknown) =>
		send(policyAssign, `${P}/assignments`, {
			method: 'POST',
			path: `${BASE}/policies/${id}/assignments`,
			headers: asUser,
			json
		});

	it('refuses targets from another organisation and a group from another organisation', async () => {
		world();
		const made = (await create({ name: 'Local', rules: {} })).json as { id: string };
		expect((await assign(made.id, { kind: 'department', targetId: 'd-x' })).status).toBe(400);
		expect((await assign(made.id, { kind: 'site', targetId: 'site-2' })).status).toBe(400);
		expect((await assign(made.id, { kind: 'organization', targetId: OTHER_ORG })).status).toBe(
			400
		);
		expect((await assign('pol-x', { kind: 'organization', targetId: ORG })).status).toBe(404);
		const ok = await assign(made.id, { kind: 'department', targetId: 'd-a' });
		expect(ok.status).toBe(200);
		expect(ok.json).toMatchObject({ assignments: [{ kind: 'department', targetId: 'd-a' }] });
	});

	it('answers not found when unassigning something that is not assigned', async () => {
		world();
		const made = (await create({ name: 'Local', rules: {} })).json as { id: string };
		const reply = await send(policyUnassign, `${P}/assignments/:kind/:targetId`, {
			method: 'DELETE',
			path: `${BASE}/policies/${made.id}/assignments/site/${SITE}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('classification', () => {
	it('names a label', async () => {
		const w = world();
		const reply = await send(classificationLabel, `${R}/policies/classifications/:label`, {
			method: 'PUT',
			path: `${BASE}/policies/classifications/regulated`,
			headers: asUser,
			json: { displayName: 'DISC 3' }
		});
		expect(reply.status).toBe(200);
		expect(rows(w, 'SELECT label, display_name FROM org_classification_map')).toEqual([
			{ label: 'regulated', display_name: 'DISC 3' }
		]);
		const bad = await send(classificationLabel, `${R}/policies/classifications/:label`, {
			method: 'PUT',
			path: `${BASE}/policies/classifications/secret`,
			headers: asUser,
			json: { displayName: 'x' }
		});
		expect(bad.status).toBe(400);
	});

	const set = (site: string, org: string, json: unknown, headers = asUser) =>
		send(siteClassSet, `${R}/sites/:id/classification`, {
			method: 'PUT',
			path: `/api/v1/orgs/${org}/sites/${site}/classification`,
			headers,
			json
		});

	it('labels a site for an admin and reads it back', async () => {
		const w = world('admin');
		expect((await set(SITE, ORG, { classification: 'restricted' })).json).toEqual({
			siteId: SITE,
			classification: 'restricted'
		});
		const read = await send(siteClassRead, `${R}/sites/:id/classification`, {
			path: `${BASE}/sites/${SITE}/classification`,
			headers: asUser
		});
		expect(read.json).toEqual({ siteId: SITE, classification: 'restricted' });
		expect(w.trail.at(-1)).toMatchObject({ action: 'site.classification.set', target: SITE });
		expect((await set(SITE, ORG, { classification: 'secret' })).status).toBe(400);
	});

	it('refuses a developer, and a site of another organisation', async () => {
		world('developer');
		expect((await set(SITE, ORG, { classification: 'public' })).status).toBe(403);
		world('owner');
		expect((await set('site-2', ORG, { classification: 'public' })).status).toBe(404);
		expect((await set('site-2', OTHER_ORG, { classification: 'public' })).status).toBe(404);
	});

	it('names the policy group and rule when a policy blocks the change', async () => {
		const w = world('admin');
		w.exec(
			`INSERT INTO policy_groups (id, organization_id, name, rules, created_at) VALUES ('pol-b', ?, 'Lockdown', '{"blockedActions":["site.classification.set"]}', 1)`,
			ORG
		);
		w.exec(
			`INSERT INTO policy_assignments (organization_id, group_id, target_kind, target_id, assigned_by, assigned_at) VALUES (?, 'pol-b', 'organization', ?, 'u', 1)`,
			ORG,
			ORG
		);
		const reply = await set(SITE, ORG, { classification: 'public' });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			details: {
				requires: 'policy',
				policy: 'pol-b',
				policyName: 'Lockdown',
				rule: 'blocked-actions'
			}
		});
		const list = await send(policyList, `${R}/policies`, {
			path: `${BASE}/policies`,
			headers: asUser
		});
		expect(list.status).toBe(200);
	});
});
