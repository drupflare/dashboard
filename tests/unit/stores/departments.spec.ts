import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DepartmentMemberView, DepartmentView, PlacementSite } from '~/shared/departments';
import { useDepartmentsStore } from '~/stores/departments';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_personal';
const DEPT = 'dept_a';
const listKey = `GET /api/v1/orgs/${ORG}/departments`;
const placeKey = `GET /api/v1/orgs/${ORG}/departments/sites`;
const membersKey = `GET /api/v1/orgs/${ORG}/departments/${DEPT}/members`;

const dept = (id: string, over: Partial<DepartmentView> = {}): DepartmentView => ({
	id,
	parentId: null,
	name: `Department ${id}`,
	kind: 'department',
	siteQuota: null,
	ownSites: 0,
	subtreeSites: 0,
	childCount: 0,
	memberCount: 0,
	canManage: true,
	createdAt: '2026-11-01T10:00:00.000Z',
	...over
});

const person = (userId: string): DepartmentMemberView => ({
	userId,
	email: `${userId}@example.test`,
	displayName: null,
	role: 'viewer',
	grantedAt: '2026-11-01T10:00:00.000Z'
});

const placed = (id: string, departmentId: string | null): PlacementSite => ({
	id,
	name: id,
	departmentId
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useDepartmentsStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('departments store', () => {
	it('stays not loaded until a list is read', () => {
		const store = useDepartmentsStore();
		expect(store.departments.get(ORG)).toBeUndefined();
		expect(store.placements.get(ORG)).toBeUndefined();
		expect(store.members.get(`${ORG}/${DEPT}`)).toBeUndefined();
	});

	it('loads the list once and keeps whether the person is central IT', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [dept(DEPT)], central: true } }
		});
		const store = useDepartmentsStore();
		await store.loadDepartments(ORG);
		await store.loadDepartments(ORG);
		expect(calls.filter((c) => c.path.endsWith('/departments'))).toHaveLength(1);
		expect(store.departments.get(ORG)).toMatchObject({ status: 'ready', central: true });
		expect(store.departments.get(ORG)?.items.map((d) => d.id)).toEqual([DEPT]);
	});

	it('records a missing organization as null and a failure as an error', async () => {
		cleanup = registerApi({
			[listKey]: { status: 404, body: failure('not_found', 'Not found', 'req_1').body }
		});
		const store = useDepartmentsStore();
		await store.loadDepartments(ORG);
		expect(store.departments.get(ORG)).toBeNull();
		cleanup();
		cleanup = registerApi({ [listKey]: failure('internal', 'Something broke', 'req_2') });
		store.$reset();
		await store.loadDepartments(ORG);
		expect(store.departments.get(ORG)).toMatchObject({ status: 'error', central: false });
		expect(store.departments.get(ORG)?.error?.requestId).toBe('req_2');
	});

	it('creates a department and reads the list again', async () => {
		let items = [dept(DEPT)];
		cleanup = registerApi({
			[listKey]: () => ({ body: { items, central: true } }),
			[`POST /api/v1/orgs/${ORG}/departments`]: (call) => {
				const body = call.body as { name: string };
				items = [...items, dept('dept_b', { name: body.name })];
				return { status: 201, body: items[1] };
			}
		});
		const store = useDepartmentsStore();
		await store.loadDepartments(ORG);
		const created = await store.create(ORG, { name: 'Library', kind: 'department' });
		expect(created.id).toBe('dept_b');
		expect(store.departments.get(ORG)?.items).toHaveLength(2);
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
			name: 'Library',
			kind: 'department'
		});
	});

	it('sends a rename, a Site Limit and a delete to the department path', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [dept(DEPT)], central: true } },
			[`PUT /api/v1/orgs/${ORG}/departments/${DEPT}`]: { body: dept(DEPT) },
			[`PUT /api/v1/orgs/${ORG}/departments/${DEPT}/quota`]: { body: dept(DEPT) },
			[`DELETE /api/v1/orgs/${ORG}/departments/${DEPT}`]: { status: 204, body: null }
		});
		const store = useDepartmentsStore();
		await store.edit(ORG, DEPT, { name: 'New Name' });
		await store.setQuota(ORG, DEPT, 5);
		await store.setQuota(ORG, DEPT, null);
		await store.remove(ORG, DEPT);
		const sent = calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);
		expect(sent).toEqual([
			['PUT', `/api/v1/orgs/${ORG}/departments/${DEPT}`, { name: 'New Name' }],
			['PUT', `/api/v1/orgs/${ORG}/departments/${DEPT}/quota`, { siteQuota: 5 }],
			['PUT', `/api/v1/orgs/${ORG}/departments/${DEPT}/quota`, { siteQuota: null }],
			['DELETE', `/api/v1/orgs/${ORG}/departments/${DEPT}`, undefined]
		]);
	});

	it('loads members, changes a role and removes a member in place', async () => {
		cleanup = registerApi({
			[membersKey]: { body: { items: [person('u1'), person('u2')] } },
			[`PUT /api/v1/orgs/${ORG}/departments/${DEPT}/members/u1/role`]: {
				body: { ...person('u1'), role: 'admin' }
			},
			[`DELETE /api/v1/orgs/${ORG}/departments/${DEPT}/members/u2`]: {
				status: 204,
				body: null
			},
			[listKey]: { body: { items: [dept(DEPT)], central: false } }
		});
		const store = useDepartmentsStore();
		await store.loadMembers(ORG, DEPT);
		await store.changeRole(ORG, DEPT, 'u1', 'admin');
		expect(store.members.get(`${ORG}/${DEPT}`)?.items[0]?.role).toBe('admin');
		await store.removeMember(ORG, DEPT, 'u2');
		expect(store.members.get(`${ORG}/${DEPT}`)?.items.map((m) => m.userId)).toEqual(['u1']);
	});

	it('records a department of another organization as null', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/departments/dept_x/members`]: {
				status: 404,
				body: failure('not_found', 'Not found', 'req_3').body
			}
		});
		const store = useDepartmentsStore();
		await store.loadMembers(ORG, 'dept_x');
		expect(store.members.get(`${ORG}/dept_x`)).toBeNull();
	});

	it('moves a site and reads departments and placements again', async () => {
		cleanup = registerApi({
			[listKey]: { body: { items: [dept(DEPT, { ownSites: 1 })], central: true } },
			[placeKey]: { body: { items: [placed('site_one', DEPT)] } },
			[`PUT /api/v1/orgs/${ORG}/sites/site_one/department`]: {
				body: { siteId: 'site_one', departmentId: DEPT }
			}
		});
		const store = useDepartmentsStore();
		const moved = await store.moveSite(ORG, 'site_one', DEPT);
		expect(moved).toEqual({ siteId: 'site_one', departmentId: DEPT });
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ departmentId: DEPT });
		expect(store.departments.get(ORG)?.items[0]?.ownSites).toBe(1);
		expect(store.placements.get(ORG)?.items[0]?.departmentId).toBe(DEPT);
	});

	it('lets a refused change reach the caller', async () => {
		cleanup = registerApi({
			[`PUT /api/v1/orgs/${ORG}/departments/${DEPT}/quota`]: {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'Only an organization owner or admin can do this',
					details: {},
					requestId: 'req_4'
				}
			}
		});
		await expect(useDepartmentsStore().setQuota(ORG, DEPT, 3)).rejects.toMatchObject({
			status: 403
		});
	});

	it('clears everything on reset', async () => {
		cleanup = registerApi({ [listKey]: { body: { items: [], central: false } } });
		const store = useDepartmentsStore();
		await store.loadDepartments(ORG);
		store.reset();
		expect(store.departments.size).toBe(0);
	});
});
