import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import deptDelete from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/index.delete';
import deptUpdate from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/index.put';
import memberRemove from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/members/[userId].delete';
import memberRole from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/members/[userId]/role.put';
import memberList from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/members/index.get';
import memberAdd from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/members/index.post';
import deptQuota from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/quota.put';
import deptSiteCreate from '../../../../src/server/api/v1/orgs/[orgId]/departments/[deptId]/sites.post';
import deptList from '../../../../src/server/api/v1/orgs/[orgId]/departments/index.get';
import deptCreate from '../../../../src/server/api/v1/orgs/[orgId]/departments/index.post';
import deptSites from '../../../../src/server/api/v1/orgs/[orgId]/departments/sites.get';
import siteDepartment from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/department.put';
import {
	getDepartment,
	getSiteDepartment,
	listUserDepartmentGrants
} from '../../../../src/server/db/repos/departments';
import { getMember } from '../../../../src/server/db/repos/organization';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setDepartmentServices,
	type DepartmentServices
} from '../../../../src/server/services/departments';
import { factsLoader, lookupKey, type FactsStore } from '../../../../src/server/services/facts';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG, OTHER_ORG, SITE } from '../../domain/fixtures';
import { asKey, asOtherUser, asUser, send, setup } from '../fixtures/harness';

vi.mock('../../../../src/server/services/sites', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/services/sites')>()),
	siteServices: () => ({}),
	createSite: vi.fn(async () => ({
		operation: { id: 'op_1', targetIds: ['site-new'] },
		version: 1
	}))
}));

const BASE = `/api/v1/orgs/${ORG}`;
const R = '/api/v1/orgs/:orgId';
const D = `${R}/departments/:deptId`;
const asBoth = { ...asUser, 'idempotency-key': 'create-0001' };

interface Seed {
	role?: 'owner' | 'admin' | 'developer' | 'viewer' | null;
	grants?: [string, 'admin' | 'developer' | 'viewer'][];
}

function world(seed: Seed = {}) {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) {
		if (/department|TABLE IF NOT EXISTS (sites|members|users) /.test(statement)) {
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
		['user-2', 'two@example.test'],
		['user-3', 'three@example.test'],
		['user-4', 'four@example.test']
	]) {
		exec(
			'INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, 1, 1)',
			id,
			email
		);
	}
	const member = (org: string, user: string, role: string) =>
		exec(
			'INSERT INTO members (id, organization_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
			`m-${org}-${user}`,
			org,
			user,
			role
		);
	if (seed.role !== null) member(ORG, 'user-1', seed.role ?? 'owner');
	member(ORG, 'user-3', 'viewer');
	member(OTHER_ORG, 'user-2', 'owner');
	const dept = (
		id: string,
		org: string,
		parent: string | null,
		name: string,
		kind = 'department'
	) =>
		exec(
			'INSERT INTO departments (id, organization_id, parent_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?, 1)',
			id,
			org,
			parent,
			name,
			kind
		);
	dept('d-a', ORG, null, 'Campus', 'division');
	dept('d-b', ORG, 'd-a', 'Library');
	dept('d-c', ORG, null, 'Athletics');
	dept('d-x', OTHER_ORG, null, 'Foreign');
	for (const [target, role] of seed.grants ?? []) {
		exec(
			'INSERT INTO department_members (organization_id, department_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, 1)',
			ORG,
			target,
			'user-1',
			role,
			'x'
		);
	}
	exec(
		`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
		 VALUES (?, ?, 'one', 'managed', 'active', 1, 1)`,
		SITE,
		ORG
	);

	const store: FactsStore = {
		organization: async (id) => ([ORG, OTHER_ORG].includes(id) ? { id } : null),
		site: async (id) => (id === SITE ? { id, orgId: ORG } : null),
		member: async (orgId, userId) => {
			const row = await getMember(db, orgId, userId);
			return row ? { orgId: row.organizationId, role: row.role } : null;
		},
		siteGrants: async () => [],
		delegations: async () => [],
		department: async (orgId, id) => {
			const row = await getDepartment(db, orgId, id);
			return row ? { id: row.id } : null;
		},
		departments: async (orgId) =>
			(
				sql
					.prepare(
						'SELECT id, parent_id, kind FROM departments WHERE organization_id = ?'
					)
					.all(orgId) as {
					id: string;
					parent_id: string | null;
					kind: 'division' | 'department';
				}[]
			).map((r) => ({ id: r.id, parentId: r.parent_id, kind: r.kind })),
		departmentGrants: (orgId, userId) => listUserDepartmentGrants(db, orgId, userId),
		siteDepartment: async (orgId, id) =>
			(await getSiteDepartment(db, orgId, id))?.departmentId ?? null
	};
	const trail: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
	const services: DepartmentServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, ...input });
		},
		newId: () => `n${trail.length}${Math.random().toString(36).slice(2, 8)}`,
		now: () => 7000
	};
	setDepartmentServices(services);
	const harness = setup({ deps: { load: factsLoader({ store }) } });
	return { sql, db, trail, exec, harness };
}

afterEach(() => {
	setDepartmentServices(null);
	resetApiDeps();
});

const q = (w: ReturnType<typeof world>, text: string, ...b: unknown[]) =>
	w.sql.prepare(text).all(...(b as never[])) as Record<string, unknown>[];

describe('GET departments', () => {
	it('lists the tree with counts for any member', async () => {
		const w = world({ role: 'viewer' });
		w.exec(`UPDATE sites SET department_id = 'd-b' WHERE id = ?`, SITE);
		const reply = await send(deptList, `${R}/departments`, {
			path: `${BASE}/departments`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const items = (reply.json as { items: { id: string; subtreeSites: number }[] }).items;
		expect(items.map((i) => i.id).sort()).toEqual(['d-a', 'd-b', 'd-c']);
		expect(items.find((i) => i.id === 'd-a')?.subtreeSites).toBe(1);
		expect((reply.json as { central: boolean }).central).toBe(false);
		expect(items.every((i) => (i as { canManage?: boolean }).canManage === false)).toBe(true);
	});

	it('answers not found to someone with no tie to the organization', async () => {
		world({ role: null });
		const reply = await send(deptList, `${R}/departments`, {
			path: `${BASE}/departments`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});

	it('does not show another organization its departments', async () => {
		world();
		const reply = await send(deptList, `${R}/departments`, {
			path: `/api/v1/orgs/${OTHER_ORG}/departments`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('POST departments', () => {
	const create = (headers: Record<string, string>, json: unknown) =>
		send(deptCreate, `${R}/departments`, {
			method: 'POST',
			path: `${BASE}/departments`,
			headers,
			json
		});

	it('creates for central IT and audits it', async () => {
		const w = world({ role: 'admin' });
		const reply = await create(asUser, {
			name: 'Registrar',
			kind: 'department',
			parentId: 'd-a'
		});
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({ name: 'Registrar', parentId: 'd-a', siteQuota: null });
		expect(w.trail.at(-1)).toMatchObject({ orgId: ORG, action: 'department.created' });
	});

	it('refuses a developer, and a department admin who is only a viewer of the organization', async () => {
		world({ role: 'developer' });
		expect((await create(asUser, { name: 'X', kind: 'department' })).status).toBe(403);
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await create(asUser, { name: 'X', kind: 'department' })).status).toBe(403);
	});

	it('refuses a parent from another organization as not valid', async () => {
		world();
		const reply = await create(asUser, { name: 'X', kind: 'department', parentId: 'd-x' });
		expect(reply.status).toBe(400);
	});

	it('refuses a body with a field it does not name and a blank name', async () => {
		world();
		expect((await create(asUser, { name: 'X', kind: 'department', siteQuota: 5 })).status).toBe(
			400
		);
		expect((await create(asUser, { name: '   ', kind: 'department' })).status).toBe(400);
	});
});

describe('PUT and DELETE a department', () => {
	const rename = (id: string, json: unknown, org = ORG, headers = asUser) =>
		send(deptUpdate, D, {
			method: 'PUT',
			path: `/api/v1/orgs/${org}/departments/${id}`,
			headers,
			json
		});
	const remove = (id: string, org = ORG) =>
		send(deptDelete, D, {
			method: 'DELETE',
			path: `/api/v1/orgs/${org}/departments/${id}`,
			headers: asUser
		});

	it('lets a department admin rename their own department and not another', async () => {
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await rename('d-b', { name: 'Libraries' })).status).toBe(200);
		expect((await rename('d-c', { name: 'Teams' })).status).toBe(403);
		expect((await rename('d-a', { name: 'Whole Campus' })).status).toBe(403);
	});

	it('lets a department admin of a parent rename a department inside it', async () => {
		world({ role: 'viewer', grants: [['d-a', 'admin']] });
		expect((await rename('d-b', { name: 'Stacks' })).status).toBe(200);
	});

	it('refuses a department admin moving a department in the tree', async () => {
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await rename('d-b', { parentId: null })).status).toBe(403);
	});

	it('answers not found for a department of another organization, by either path', async () => {
		world();
		expect((await rename('d-x', { name: 'Mine Now' })).status).toBe(404);
		expect((await rename('d-x', { name: 'Mine Now' }, OTHER_ORG)).status).toBe(404);
		expect((await remove('d-x')).status).toBe(404);
	});

	it('refuses a cycle and a duplicate name', async () => {
		world();
		expect((await rename('d-a', { parentId: 'd-b' })).status).toBe(422);
		expect((await rename('d-c', { name: 'campus' })).status).toBe(409);
	});

	it('deletes an empty department and refuses one with a site or a child', async () => {
		const w = world();
		expect((await remove('d-a')).status).toBe(409);
		w.exec(`UPDATE sites SET department_id = 'd-b' WHERE id = ?`, SITE);
		expect((await remove('d-b')).status).toBe(409);
		expect((await remove('d-c')).status).toBe(204);
		expect(q(w, `SELECT id FROM departments WHERE id = 'd-c'`)).toEqual([]);
		expect(w.trail.at(-1)).toMatchObject({ action: 'department.deleted', target: 'd-c' });
	});

	it('refuses a department admin deleting their department', async () => {
		world({ role: 'viewer', grants: [['d-c', 'admin']] });
		expect((await remove('d-c')).status).toBe(403);
	});

	it('answers not found to a key whose issuer has no tie to the organization', async () => {
		world({ role: null });
		const reply = await send(deptUpdate, D, {
			method: 'PUT',
			path: `${BASE}/departments/d-b`,
			headers: asKey,
			json: { name: 'Nope' }
		});
		expect([401, 403, 404]).toContain(reply.status);
	});
});

describe('PUT quota', () => {
	const set = (id: string, json: unknown) =>
		send(deptQuota, `${D}/quota`, {
			method: 'PUT',
			path: `${BASE}/departments/${id}/quota`,
			headers: asUser,
			json
		});

	it('lets central IT set and clear a limit', async () => {
		const w = world({ role: 'admin' });
		expect(((await set('d-b', { siteQuota: 3 })).json as { siteQuota: number }).siteQuota).toBe(
			3
		);
		expect(
			((await set('d-b', { siteQuota: null })).json as { siteQuota: null }).siteQuota
		).toBeNull();
		expect(w.trail.filter((t) => t.action === 'department.quota.set')).toHaveLength(2);
	});

	it('refuses a department admin, a negative limit and a foreign department', async () => {
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await set('d-b', { siteQuota: 3 })).status).toBe(403);
		world();
		expect((await set('d-b', { siteQuota: -1 })).status).toBe(400);
		expect((await set('d-b', { siteQuota: 1.5 })).status).toBe(400);
		expect((await set('d-x', { siteQuota: 3 })).status).toBe(404);
	});
});

describe('department members', () => {
	const base = (id: string) => `${BASE}/departments/${id}/members`;
	const add = (id: string, json: unknown) =>
		send(memberAdd, `${D}/members`, { method: 'POST', path: base(id), headers: asUser, json });

	it('lets a department admin add, change and remove a member of their department', async () => {
		const w = world({ role: 'viewer', grants: [['d-a', 'admin']] });
		const added = await add('d-b', { email: 'three@example.test', role: 'developer' });
		expect(added.status).toBe(201);
		expect(w.trail.at(-1)).toMatchObject({ action: 'department.member.added', target: 'd-b' });
		const changed = await send(memberRole, `${D}/members/:userId/role`, {
			method: 'PUT',
			path: `${base('d-b')}/user-3/role`,
			headers: asUser,
			json: { role: 'viewer' }
		});
		expect(changed.json).toMatchObject({ role: 'viewer' });
		const listed = await send(memberList, `${D}/members`, {
			path: base('d-b'),
			headers: asUser
		});
		expect((listed.json as { items: unknown[] }).items).toHaveLength(1);
		const removed = await send(memberRemove, `${D}/members/:userId`, {
			method: 'DELETE',
			path: `${base('d-b')}/user-3`,
			headers: asUser
		});
		expect(removed.status).toBe(204);
		expect(q(w, 'SELECT * FROM department_members WHERE user_id = ?', 'user-3')).toEqual([]);
	});

	it('refuses an admin of department A touching department B or the parent above', async () => {
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await add('d-c', { email: 'three@example.test', role: 'viewer' })).status).toBe(
			403
		);
		expect((await add('d-a', { email: 'three@example.test', role: 'viewer' })).status).toBe(
			403
		);
		const role = await send(memberRole, `${D}/members/:userId/role`, {
			method: 'PUT',
			path: `${base('d-c')}/user-3/role`,
			headers: asUser,
			json: { role: 'viewer' }
		});
		expect(role.status).toBe(403);
	});

	it('refuses a department developer', async () => {
		world({ role: 'viewer', grants: [['d-b', 'developer']] });
		expect((await add('d-b', { email: 'three@example.test', role: 'viewer' })).status).toBe(
			403
		);
	});

	it('refuses an owner role and an address outside the organization', async () => {
		world();
		expect((await add('d-b', { email: 'three@example.test', role: 'owner' })).status).toBe(400);
		expect((await add('d-b', { email: 'two@example.test', role: 'viewer' })).status).toBe(400);
	});

	it('answers not found for a foreign department id on every member route', async () => {
		world();
		expect((await add('d-x', { email: 'three@example.test', role: 'viewer' })).status).toBe(
			404
		);
		expect(
			(await send(memberList, `${D}/members`, { path: base('d-x'), headers: asUser })).status
		).toBe(404);
		const gone = await send(memberRemove, `${D}/members/:userId`, {
			method: 'DELETE',
			path: `${base('d-x')}/user-3`,
			headers: asUser
		});
		expect(gone.status).toBe(404);
	});

	it('does not let the other organization owner read this one', async () => {
		world();
		const reply = await send(memberList, `${D}/members`, {
			path: base('d-b'),
			headers: asOtherUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('sites and departments', () => {
	const move = (json: unknown, org = ORG) =>
		send(siteDepartment, `${R}/sites/:id/department`, {
			method: 'PUT',
			path: `/api/v1/orgs/${org}/sites/${SITE}/department`,
			headers: asUser,
			json
		});

	it('moves a site for central IT and audits it', async () => {
		const w = world();
		const reply = await move({ departmentId: 'd-b' });
		expect(reply.json).toEqual({ siteId: SITE, departmentId: 'd-b' });
		expect(w.trail.at(-1)).toMatchObject({ action: 'site.department.set', target: SITE });
		const placed = await send(deptSites, `${R}/departments/sites`, {
			path: `${BASE}/departments/sites`,
			headers: asUser
		});
		expect(placed.json).toEqual({ items: [{ id: SITE, name: 'one', departmentId: 'd-b' }] });
	});

	it('refuses a move into a department from another organization', async () => {
		world();
		expect((await move({ departmentId: 'd-x' })).status).toBe(400);
		expect((await move({ departmentId: 'd-b' }, OTHER_ORG)).status).toBe(404);
	});

	it('refuses a move over the Site Limit', async () => {
		const w = world();
		w.exec(`UPDATE departments SET site_quota = 0 WHERE id = 'd-a'`);
		const reply = await move({ departmentId: 'd-b' });
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({
			details: { reason: 'site_quota', departmentId: 'd-a' }
		});
	});

	it('lets a department admin move a site only into a department they can add to', async () => {
		const w = world({ role: 'viewer', grants: [['d-b', 'admin']] });
		w.exec(`UPDATE sites SET department_id = 'd-b' WHERE id = ?`, SITE);
		expect((await move({ departmentId: 'd-c' })).status).toBe(403);
		expect((await move({ departmentId: null })).status).toBe(403);
	});

	it('refuses a department admin of another department the whole move', async () => {
		const w = world({ role: 'viewer', grants: [['d-c', 'admin']] });
		w.exec(`UPDATE sites SET department_id = 'd-b' WHERE id = ?`, SITE);
		expect((await move({ departmentId: 'd-c' })).status).toBe(403);
	});
});

describe('POST a site in a department', () => {
	const create = (id: string, headers: Record<string, string> = asBoth) =>
		send(deptSiteCreate, `${D}/sites`, {
			method: 'POST',
			path: `${BASE}/departments/${id}/sites`,
			headers,
			json: { kind: 'drupal', name: 'newsite' }
		});

	it('places the new site in the department', async () => {
		const w = world({ role: 'viewer', grants: [['d-a', 'admin']] });
		w.exec(
			`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
			 VALUES ('site-new', ?, 'newsite', 'managed', 'active', 1, 1)`,
			ORG
		);
		const reply = await create('d-b');
		expect(reply.status).toBe(202);
		expect(q(w, `SELECT department_id FROM sites WHERE id = 'site-new'`)).toEqual([
			{ department_id: 'd-b' }
		]);
	});

	it('refuses a create over a limit on the department or above it', async () => {
		const w = world({ role: 'viewer', grants: [['d-a', 'admin']] });
		w.exec(`UPDATE departments SET site_quota = 1 WHERE id = 'd-a'`);
		w.exec(`UPDATE sites SET department_id = 'd-b' WHERE id = ?`, SITE);
		const reply = await create('d-b');
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'site_quota', limit: 1, used: 1 } });
	});

	it('refuses a department the person holds nothing in, and one from another organization', async () => {
		world({ role: 'viewer', grants: [['d-b', 'admin']] });
		expect((await create('d-c')).status).toBe(403);
		expect((await create('d-x')).status).toBe(404);
	});

	it('refuses a developer-less viewer and a missing Idempotency-Key', async () => {
		world({ role: 'viewer' });
		expect((await create('d-b')).status).toBe(403);
		world();
		expect((await create('d-b', asUser)).status).toBe(400);
	});
});

describe('lookup keys', () => {
	it('trims and lowers a path value', () => {
		expect(lookupKey(' D-B ')).toBe('d-b');
	});
});
