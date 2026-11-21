import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	deleteDepartment,
	getDepartment,
	getDepartmentMember,
	getSiteDepartment,
	insertDepartment,
	insertDepartmentMember,
	listDepartmentMembers,
	listDepartments,
	listPlacements,
	listUserDepartmentGrants,
	memberCounts,
	removeDepartmentMember,
	removeUserDepartmentMembers,
	setDepartmentMemberRole,
	setDepartmentQuota,
	setSiteDepartment,
	siteCounts,
	updateDepartment,
	type DepartmentRow
} from '../../../src/server/db/repos/departments';
import { createUser } from '../../../src/server/db/repos/identity';
import { addMember, createOrganization } from '../../../src/server/db/repos/organization';
import type { Facts, Principal } from '../../../src/server/domain/authorize';
import * as cap from '../../../src/server/domain/cap-by-policy';
import {
	addDepartmentMember,
	assertQuotaRoom,
	changeDepartmentMemberRole,
	createDepartment,
	editDepartment,
	listDepartmentViews,
	moveSite,
	removeDepartment,
	removeDepartmentMemberOf,
	setQuota,
	type Actor,
	type DepartmentServices
} from '../../../src/server/services/departments';
import { collegeFactsStore, loadFacts } from '../../../src/server/services/facts';
import { facts as baseFacts } from '../../unit/domain/fixtures';
import { openBindings, TWO_SHARD_CONFIG, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings(TWO_SHARD_CONFIG);
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const tag = () => crypto.randomUUID().replaceAll('-', '');
const email = (name: string) => `${name}-${tag()}@example.test`;

async function organisation() {
	const founder = await createUser(db, { email: email('founder') });
	const org = await createOrganization(db, {
		name: 'Departments Test',
		personal: false,
		createdBy: founder.id
	});
	await addMember(db, org.id, { userId: founder.id, role: 'owner' });
	return { orgId: org.id, founder };
}

async function person(orgId: string, role: 'admin' | 'developer' | 'viewer' = 'viewer') {
	const user = await createUser(db, { email: email(role) });
	await addMember(db, orgId, { userId: user.id, role });
	return user;
}

function dept(orgId: string, name: string, over: Partial<DepartmentRow> = {}): DepartmentRow {
	return {
		id: `dept_${tag()}`,
		organizationId: orgId,
		parentId: null,
		name,
		kind: 'department',
		siteQuota: null,
		createdAt: 1000,
		...over
	};
}

async function site(orgId: string, over: { departmentId?: string | null; state?: string } = {}) {
	const id = `site_${tag()}`;
	await db.run(
		orgId,
		`INSERT INTO sites (id, organization_id, name, plane, state, department_id, created_at, updated_at)
		 VALUES (?, ?, ?, 'managed', ?, ?, 1, 1)`,
		[id, orgId, `n${id.slice(-8)}`, over.state ?? 'active', over.departmentId ?? null]
	);
	return id;
}

const audits: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
const services: DepartmentServices = {
	getDb: async () => db,
	audit: async (orgId, input) => {
		audits.push({ orgId, ...input });
	},
	newId: tag,
	now: () => 5000
};

const asUser = (userId: string): Principal => ({ kind: 'user', userId });

async function actorFor(orgId: string, userId: string, over: Partial<Facts> = {}): Promise<Actor> {
	const rows = await listDepartments(db, orgId);
	return {
		principal: asUser(userId),
		facts: baseFacts({
			departments: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })),
			...over
		})
	};
}

const central = (orgId: string, userId: string) =>
	actorFor(orgId, userId, { membership: { orgId, role: 'owner' } });

describe('department rows', () => {
	it('stores, reads, renames, moves and deletes', async () => {
		const { orgId } = await organisation();
		const a = dept(orgId, 'Library', { kind: 'division' });
		const b = dept(orgId, 'Archives', { parentId: a.id });
		await insertDepartment(db, a);
		await insertDepartment(db, b);
		expect((await listDepartments(db, orgId)).map((r) => r.name)).toEqual([
			'Archives',
			'Library'
		]);
		expect(await getDepartment(db, orgId, b.id)).toMatchObject({
			parentId: a.id,
			siteQuota: null
		});
		expect(
			await updateDepartment(db, orgId, b.id, { name: 'Special Collections', parentId: null })
		).toBe(true);
		expect((await getDepartment(db, orgId, b.id))?.parentId).toBeNull();
		expect(await setDepartmentQuota(db, orgId, b.id, 3)).toBe(true);
		expect((await getDepartment(db, orgId, b.id))?.siteQuota).toBe(3);
		expect(await deleteDepartment(db, orgId, b.id)).toBe(true);
		expect(await getDepartment(db, orgId, b.id)).toBeNull();
	});

	it('refuses a sibling with the same name, ignoring case, at the root and below', async () => {
		const { orgId } = await organisation();
		const root = dept(orgId, 'Science');
		await insertDepartment(db, root);
		await expect(insertDepartment(db, dept(orgId, 'science'))).rejects.toBeInstanceOf(
			DuplicateRowError
		);
		const child = dept(orgId, 'Physics', { parentId: root.id });
		await insertDepartment(db, child);
		await expect(
			insertDepartment(db, dept(orgId, 'PHYSICS', { parentId: root.id }))
		).rejects.toBeInstanceOf(DuplicateRowError);
		await insertDepartment(db, dept(orgId, 'Physics'));
	});

	it('keeps one organisation out of another', async () => {
		const a = await organisation();
		const b = await organisation();
		const row = dept(a.orgId, 'Only Here');
		await insertDepartment(db, row);
		expect(await getDepartment(db, b.orgId, row.id)).toBeNull();
		expect(await listDepartments(db, b.orgId)).toEqual([]);
		expect(await setDepartmentQuota(db, b.orgId, row.id, 1)).toBe(false);
	});

	it('rejects a negative quota', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Quota');
		await insertDepartment(db, row);
		await expect(setDepartmentQuota(db, orgId, row.id, -1)).rejects.toThrow();
	});
});

describe('members and sites', () => {
	it('holds one role per person, changes it, and lists grants in the authorize shape', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Members');
		await insertDepartment(db, row);
		const user = await person(orgId);
		const member = {
			organizationId: orgId,
			departmentId: row.id,
			userId: user.id,
			role: 'viewer' as const,
			grantedBy: 'someone',
			grantedAt: 10
		};
		await insertDepartmentMember(db, member);
		await expect(insertDepartmentMember(db, member)).rejects.toBeInstanceOf(DuplicateRowError);
		expect(await setDepartmentMemberRole(db, orgId, row.id, user.id, 'admin')).toBe(true);
		expect((await getDepartmentMember(db, orgId, row.id, user.id))?.role).toBe('admin');
		expect(await listUserDepartmentGrants(db, orgId, user.id)).toEqual([
			{ level: 'department', orgId, targetId: row.id, role: 'admin' }
		]);
		expect((await memberCounts(db, orgId)).get(row.id)).toBe(1);
		expect(await listDepartmentMembers(db, orgId, row.id)).toHaveLength(1);
		expect(await removeDepartmentMember(db, orgId, row.id, user.id)).toBe(true);
		expect(await removeDepartmentMember(db, orgId, row.id, user.id)).toBe(false);
	});

	it('drops every department role of a person who leaves', async () => {
		const { orgId } = await organisation();
		const [a, b] = [dept(orgId, 'A'), dept(orgId, 'B')];
		await insertDepartment(db, a);
		await insertDepartment(db, b);
		const user = await person(orgId);
		for (const row of [a, b]) {
			await insertDepartmentMember(db, {
				organizationId: orgId,
				departmentId: row.id,
				userId: user.id,
				role: 'viewer',
				grantedBy: 'x',
				grantedAt: 1
			});
		}
		await removeUserDepartmentMembers(db, orgId, user.id);
		expect(await listUserDepartmentGrants(db, orgId, user.id)).toEqual([]);
	});

	it('counts live sites per department and ignores deleted ones', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Counted');
		await insertDepartment(db, row);
		await site(orgId, { departmentId: row.id });
		await site(orgId, { departmentId: row.id, state: 'suspended' });
		await site(orgId, { departmentId: row.id, state: 'deleted' });
		await site(orgId);
		expect((await siteCounts(db, orgId)).get(row.id)).toBe(2);
	});

	it('places and unplaces a site and lists placements', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Placed');
		await insertDepartment(db, row);
		const id = await site(orgId);
		expect(await getSiteDepartment(db, orgId, id)).toEqual({ departmentId: null });
		expect(await setSiteDepartment(db, orgId, id, row.id)).toBe(true);
		expect(await listPlacements(db, orgId)).toEqual([
			expect.objectContaining({ id, departmentId: row.id })
		]);
		await setSiteDepartment(db, orgId, id, null);
		expect((await getSiteDepartment(db, orgId, id))?.departmentId).toBeNull();
		expect(await getSiteDepartment(db, orgId, 'site_missing')).toBeNull();
	});
});

describe('department service', () => {
	it('builds a tree, refuses a fifth level and a cycle, and writes an audit row', async () => {
		const { orgId, founder } = await organisation();
		const actor = await central(orgId, founder.id);
		const l1 = await createDepartment(services, orgId, actor, {
			name: 'One',
			kind: 'division'
		});
		const l2 = await createDepartment(services, orgId, actor, {
			name: 'Two',
			kind: 'division',
			parentId: l1.id
		});
		const l3 = await createDepartment(services, orgId, actor, {
			name: 'Three',
			kind: 'department',
			parentId: l2.id
		});
		const l4 = await createDepartment(services, orgId, actor, {
			name: 'Four',
			kind: 'department',
			parentId: l3.id
		});
		await expect(
			createDepartment(services, orgId, actor, {
				name: 'Five',
				kind: 'department',
				parentId: l4.id
			})
		).rejects.toMatchObject({ code: 'unprocessable', details: { reason: 'depth' } });
		await expect(
			editDepartment(services, orgId, actor, l1.id, { parentId: l4.id })
		).rejects.toMatchObject({ details: { reason: 'cycle' } });
		await expect(
			createDepartment(services, orgId, actor, {
				name: 'Ghost',
				kind: 'department',
				parentId: 'nope'
			})
		).rejects.toMatchObject({ code: 'validation' });
		expect(
			audits.filter((a) => a.orgId === orgId && a.action === 'department.created')
		).toHaveLength(4);
		const views = (await listDepartmentViews(services, orgId, actor)).items;
		expect(views.find((v) => v.id === l1.id)).toMatchObject({ childCount: 1 });
	});

	it('refuses a duplicate name with a plain conflict', async () => {
		const { orgId, founder } = await organisation();
		const actor = await central(orgId, founder.id);
		await createDepartment(services, orgId, actor, { name: 'Same', kind: 'department' });
		await expect(
			createDepartment(services, orgId, actor, { name: 'same', kind: 'department' })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('lets only central IT create, move, set a limit and delete', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const row = await createDepartment(services, orgId, boss, {
			name: 'Web',
			kind: 'department'
		});
		const other = await createDepartment(services, orgId, boss, {
			name: 'Div',
			kind: 'division'
		});
		const admin = await person(orgId);
		const deptAdmin = await actorFor(orgId, admin.id, {
			membership: { orgId, role: 'viewer' },
			grants: [{ level: 'department', orgId, targetId: row.id, role: 'admin' }]
		});
		await expect(
			createDepartment(services, orgId, deptAdmin, { name: 'New', kind: 'department' })
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(setQuota(services, orgId, deptAdmin, row.id, 5)).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			editDepartment(services, orgId, deptAdmin, row.id, { parentId: other.id })
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(removeDepartment(services, orgId, deptAdmin, row.id)).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			editDepartment(services, orgId, deptAdmin, row.id, { name: 'Web Team' })
		).resolves.toMatchObject({
			name: 'Web Team'
		});
		const listed = await listDepartmentViews(services, orgId, deptAdmin);
		expect(listed.central).toBe(false);
		expect(listed.items.find((v) => v.id === row.id)?.canManage).toBe(true);
		expect(listed.items.find((v) => v.id === other.id)?.canManage).toBe(false);
		expect((await listDepartmentViews(services, orgId, boss)).central).toBe(true);
		await expect(setQuota(services, orgId, boss, row.id, 5)).resolves.toMatchObject({
			siteQuota: 5
		});
	});

	it('refuses to delete a department that holds sites or departments', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const parent = await createDepartment(services, orgId, boss, {
			name: 'P',
			kind: 'division'
		});
		const child = await createDepartment(services, orgId, boss, {
			name: 'C',
			kind: 'department',
			parentId: parent.id
		});
		await expect(removeDepartment(services, orgId, boss, parent.id)).rejects.toMatchObject({
			details: { reason: 'has_children' }
		});
		const siteId = await site(orgId, { departmentId: child.id });
		await expect(removeDepartment(services, orgId, boss, child.id)).rejects.toMatchObject({
			details: { reason: 'has_sites' }
		});
		await setSiteDepartment(db, orgId, siteId, null);
		await removeDepartment(services, orgId, boss, child.id);
		await removeDepartment(services, orgId, boss, parent.id);
		expect(await listDepartments(db, orgId)).toEqual([]);
	});

	it('counts a subtree against the limit and names the department that is full', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const top = await createDepartment(services, orgId, boss, {
			name: 'Top',
			kind: 'division'
		});
		const leaf = await createDepartment(services, orgId, boss, {
			name: 'Leaf',
			kind: 'department',
			parentId: top.id
		});
		await setQuota(services, orgId, boss, top.id, 2);
		await site(orgId, { departmentId: leaf.id });
		await assertQuotaRoom(services, orgId, leaf.id);
		await site(orgId, { departmentId: leaf.id });
		await expect(assertQuotaRoom(services, orgId, leaf.id)).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'site_quota', departmentId: top.id, limit: 2, used: 2 }
		});
		const views = (await listDepartmentViews(services, orgId, boss)).items;
		expect(views.find((v) => v.id === top.id)).toMatchObject({ ownSites: 0, subtreeSites: 2 });
	});

	it('moves a site, checks authority and the limit, and writes an audit row', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const a = await createDepartment(services, orgId, boss, { name: 'A', kind: 'department' });
		const b = await createDepartment(services, orgId, boss, { name: 'B', kind: 'department' });
		await setQuota(services, orgId, boss, b.id, 1);
		const one = await site(orgId);
		const two = await site(orgId);
		await expect(moveSite(services, orgId, boss, one, { departmentId: b.id })).resolves.toEqual(
			{
				siteId: one,
				departmentId: b.id
			}
		);
		await expect(
			moveSite(services, orgId, boss, two, { departmentId: b.id })
		).rejects.toMatchObject({
			details: { reason: 'site_quota' }
		});
		await expect(
			moveSite(services, orgId, boss, two, { departmentId: 'nope' })
		).rejects.toMatchObject({
			code: 'validation'
		});
		await expect(
			moveSite(services, orgId, boss, 'site_missing', { departmentId: a.id })
		).rejects.toMatchObject({ code: 'not_found' });
		await moveSite(services, orgId, boss, two, { departmentId: a.id });
		const user = await person(orgId);
		const onlyA = await actorFor(orgId, user.id, {
			membership: { orgId, role: 'viewer' },
			grants: [{ level: 'department', orgId, targetId: a.id, role: 'admin' }]
		});
		await expect(
			moveSite(services, orgId, onlyA, two, { departmentId: b.id })
		).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			moveSite(services, orgId, onlyA, two, { departmentId: null })
		).rejects.toMatchObject({
			code: 'forbidden'
		});
		await expect(
			moveSite(services, orgId, onlyA, two, { departmentId: a.id })
		).resolves.toEqual({
			siteId: two,
			departmentId: a.id
		});
		expect(audits.some((x) => x.action === 'site.department.set' && x.target === one)).toBe(
			true
		);
		await expect(moveSite(services, orgId, boss, two, { departmentId: null })).resolves.toEqual(
			{
				siteId: two,
				departmentId: null
			}
		);
	});

	it('stops a department member reaching another department or a role they cannot give', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const a = await createDepartment(services, orgId, boss, {
			name: 'Alpha',
			kind: 'department'
		});
		const b = await createDepartment(services, orgId, boss, {
			name: 'Beta',
			kind: 'department'
		});
		const target = await person(orgId);
		const targetEmail = target.email;
		const grant = (departmentId: string, role: 'admin' | 'developer') => ({
			level: 'department' as const,
			orgId,
			targetId: departmentId,
			role
		});
		const make = async (role: 'admin' | 'developer') =>
			actorFor(orgId, (await person(orgId)).id, {
				membership: { orgId, role: 'viewer' },
				grants: [grant(a.id, role)]
			});
		// a department developer holds no member actions
		await expect(
			addDepartmentMember(services, orgId, await make('developer'), a.id, {
				email: targetEmail,
				role: 'viewer'
			})
		).rejects.toMatchObject({ code: 'forbidden' });
		const asAdmin = await make('admin');
		// an admin of one department reaches nothing in the other
		await expect(
			addDepartmentMember(services, orgId, asAdmin, b.id, {
				email: targetEmail,
				role: 'viewer'
			})
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			addDepartmentMember(services, orgId, asAdmin, a.id, {
				email: targetEmail,
				role: 'developer'
			})
		).resolves.toMatchObject({ role: 'developer' });
		await expect(
			addDepartmentMember(services, orgId, asAdmin, a.id, {
				email: targetEmail,
				role: 'viewer'
			})
		).rejects.toMatchObject({ code: 'conflict' });
		await expect(
			changeDepartmentMemberRole(services, orgId, asAdmin, a.id, target.id, 'viewer')
		).resolves.toMatchObject({ role: 'viewer' });
		await expect(
			changeDepartmentMemberRole(services, orgId, asAdmin, b.id, target.id, 'viewer')
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			changeDepartmentMemberRole(services, orgId, asAdmin, a.id, 'user_missing', 'viewer')
		).rejects.toMatchObject({ code: 'not_found' });
		await removeDepartmentMemberOf(services, orgId, asAdmin, a.id, target.id);
		expect(await getDepartmentMember(db, orgId, a.id, target.id)).toBeNull();
	});

	it('refuses a role the actor no longer holds once policy narrows them', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const a = await createDepartment(services, orgId, boss, {
			name: 'Capped',
			kind: 'department'
		});
		const target = await person(orgId);
		const asAdmin = await actorFor(orgId, (await person(orgId)).id, {
			membership: { orgId, role: 'viewer' },
			grants: [{ level: 'department', orgId, targetId: a.id, role: 'admin' }]
		});
		const spy = vi.spyOn(cap, 'capByPolicy').mockImplementation((actions) => {
			const next = new Set(actions);
			next.delete('site.deploy');
			return next;
		});
		try {
			await expect(
				addDepartmentMember(services, orgId, asAdmin, a.id, {
					email: target.email,
					role: 'developer'
				})
			).rejects.toMatchObject({ code: 'forbidden' });
			await expect(
				addDepartmentMember(services, orgId, asAdmin, a.id, {
					email: target.email,
					role: 'viewer'
				})
			).resolves.toMatchObject({ role: 'viewer' });
		} finally {
			spy.mockRestore();
		}
	});

	it('adds only a person who is already in the organization, and says the same for an unknown address', async () => {
		const { orgId, founder } = await organisation();
		const boss = await central(orgId, founder.id);
		const a = await createDepartment(services, orgId, boss, {
			name: 'Gate',
			kind: 'department'
		});
		const outsider = await createUser(db, { email: email('outsider') });
		const unknown = await addDepartmentMember(services, orgId, boss, a.id, {
			email: 'nobody@example.test',
			role: 'viewer'
		}).catch((e: unknown) => e);
		const notMember = await addDepartmentMember(services, orgId, boss, a.id, {
			email: outsider.email,
			role: 'viewer'
		}).catch((e: unknown) => e);
		expect(unknown).toMatchObject({ code: 'validation' });
		expect((notMember as Error).message).toBe((unknown as Error).message);
	});
});

describe('facts for a department route', () => {
	const input = (principal: Principal, params: Record<string, string>) => ({
		principal,
		scope: 'organization' as const,
		action: 'department.manage' as const,
		params
	});

	it('finds a department of the organization and answers not found for another one', async () => {
		const a = await organisation();
		const b = await organisation();
		const row = dept(a.orgId, 'Mine');
		await insertDepartment(db, row);
		const deps = { store: collegeFactsStore(async () => db) };
		const own = await loadFacts(
			deps,
			input(asUser(a.founder.id), { orgId: a.orgId, deptId: row.id })
		);
		expect(own?.resource).toEqual({ orgId: a.orgId, departmentId: row.id });
		expect(own?.facts.departments).toEqual([
			{ id: row.id, parentId: null, kind: 'department' }
		]);
		// the other organisation's owner names a department that is not theirs
		expect(
			await loadFacts(deps, input(asUser(b.founder.id), { orgId: b.orgId, deptId: row.id }))
		).toBeNull();
		// and names the right department through the wrong organisation
		expect(
			await loadFacts(deps, input(asUser(b.founder.id), { orgId: a.orgId, deptId: row.id }))
		).toBeNull();
		expect(
			await loadFacts(deps, input(asUser(a.founder.id), { orgId: a.orgId, deptId: 'nope' }))
		).toBeNull();
	});

	it('puts the site department on a site resource and loads department roles', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Site Home');
		await insertDepartment(db, row);
		const id = await site(orgId, { departmentId: row.id });
		const user = await person(orgId);
		await insertDepartmentMember(db, {
			organizationId: orgId,
			departmentId: row.id,
			userId: user.id,
			role: 'admin',
			grantedBy: 'x',
			grantedAt: 1
		});
		const deps = { store: collegeFactsStore(async () => db) };
		const loaded = await loadFacts(deps, {
			principal: asUser(user.id),
			scope: 'site',
			action: 'site.read',
			params: { id: id, orgId }
		});
		expect(loaded?.resource).toEqual({ orgId, siteId: id, departmentId: row.id });
		expect(loaded?.facts.grants).toEqual([
			{ level: 'department', orgId, targetId: row.id, role: 'admin' }
		]);
	});

	it('ignores department roles once the person has left the organization', async () => {
		const { orgId } = await organisation();
		const row = dept(orgId, 'Stale');
		await insertDepartment(db, row);
		const user = await createUser(db, { email: email('stale') });
		await insertDepartmentMember(db, {
			organizationId: orgId,
			departmentId: row.id,
			userId: user.id,
			role: 'admin',
			grantedBy: 'x',
			grantedAt: 1
		});
		const deps = { store: collegeFactsStore(async () => db) };
		expect(await loadFacts(deps, input(asUser(user.id), { orgId, deptId: row.id }))).toBeNull();
	});
});
