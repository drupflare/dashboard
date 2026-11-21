import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	type DepartmentCreateBody,
	type DepartmentList,
	type DepartmentMemberBody,
	type DepartmentMemberList,
	type DepartmentMemberView,
	type DepartmentRole,
	type DepartmentUpdateBody,
	type DepartmentView,
	type PlacementList,
	type SiteDepartmentBody,
	type SiteDepartmentView
} from '../../shared/departments';
import { ApiError } from '../../shared/errors';
import { DuplicateRowError } from '../db/collegedb';
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
	memberCounts,
	removeDepartmentMember,
	setDepartmentMemberRole,
	setDepartmentQuota,
	setSiteDepartment,
	siteCounts,
	updateDepartment,
	type DepartmentRow
} from '../db/repos/departments';
import { getUserByEmail, getUserById } from '../db/repos/identity';
import { getMember } from '../db/repos/organization';
import type { Facts, Principal } from '../domain/authorize';
import {
	canGrantRole,
	checkParent,
	effectiveActions,
	isCentral,
	quotaRefusal,
	subtreeCount,
	type QuotaFacts,
	type TreeRefusal
} from '../domain/departments';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

// #region collaborators

export interface DepartmentServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	newId: () => string;
	now: () => number;
}

let installed: DepartmentServices | null = null;

export function setDepartmentServices(services: DepartmentServices | null): void {
	installed = services;
}

export function departmentServices(): DepartmentServices {
	if (installed === null) throw new ApiError('not_built', 'Departments are not available yet');
	return installed;
}

export const defaultDepartmentServices = (
	getDb: () => Promise<CollegeDBClient>,
	audit: DepartmentServices['audit']
): DepartmentServices => ({
	getDb,
	audit,
	newId: () => crypto.randomUUID().replaceAll('-', ''),
	now: Date.now
});

// #endregion

// #region actor

// who is asking: the principal and the facts the loader read for this request
export interface Actor {
	principal: Principal;
	facts: Facts;
}

export function actorOf(principal: Principal | null, facts: Facts | null): Actor {
	if (principal === null || facts === null) throw new ApiError('not_found', 'Not found');
	return { principal, facts };
}

// the organization and department a route acts on are the ones the loader read, and the path
// has to agree with them
export function targetOf(
	resource: { orgId?: string; departmentId?: string },
	params: { orgId: string; deptId?: string }
): { orgId: string; departmentId: string } {
	const { orgId, departmentId } = resource;
	if (orgId === undefined || orgId !== params.orgId) throw new ApiError('not_found', 'Not found');
	if (
		departmentId === undefined ||
		(params.deptId !== undefined && departmentId !== params.deptId)
	) {
		throw new ApiError('not_found', 'Not found');
	}
	return { orgId, departmentId };
}

const central = (actor: Actor) => isCentral(actor.facts.membership);

function heldAt(actor: Actor, orgId: string, departmentId: string | undefined) {
	const { facts } = actor;
	return effectiveActions(
		{
			orgId,
			...(facts.membership ? { membership: facts.membership } : {}),
			grants: facts.grants,
			...(facts.departments ? { departments: facts.departments } : {}),
			policy: facts.policy
		},
		departmentId === undefined ? {} : { departmentId }
	);
}

const needsCentral = () =>
	new ApiError('forbidden', 'Only an organization owner or admin can do this');

// #endregion

const iso = (ms: number) => new Date(ms).toISOString();

const REFUSALS: Record<TreeRefusal, string> = {
	parent_missing: 'Choose a parent from this organization',
	self_parent: 'A department cannot sit inside itself',
	cycle: 'A department cannot move inside one of its own departments',
	depth: 'Departments can go four levels deep at most',
	division_under_department: 'A division cannot sit inside a department'
};

const refuseTree = (refusal: TreeRefusal): never => {
	throw new ApiError(
		refusal === 'parent_missing' ? 'validation' : 'unprocessable',
		REFUSALS[refusal],
		{
			reason: refusal
		}
	);
};

function viewsOf(
	rows: readonly DepartmentRow[],
	own: ReadonlyMap<string, number>,
	members: ReadonlyMap<string, number>,
	canManage: (id: string) => boolean
): DepartmentView[] {
	const tree = rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind }));
	const facts: QuotaFacts = { tree, quotas: new Map(), counts: own };
	return rows.map((row) => ({
		id: row.id,
		parentId: row.parentId,
		name: row.name,
		kind: row.kind,
		siteQuota: row.siteQuota,
		ownSites: own.get(row.id) ?? 0,
		subtreeSites: subtreeCount(facts, row.id),
		childCount: rows.filter((r) => r.parentId === row.id).length,
		memberCount: members.get(row.id) ?? 0,
		canManage: canManage(row.id),
		createdAt: iso(row.createdAt)
	}));
}

async function loadViews(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor
): Promise<DepartmentView[]> {
	const db = await deps.getDb();
	const [rows, own, members] = await Promise.all([
		listDepartments(db, orgId),
		siteCounts(db, orgId),
		memberCounts(db, orgId)
	]);
	const tree = rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind }));
	// the loader read the tree before this change, so a department made a moment ago is not in it
	const withTree: Actor = { ...actor, facts: { ...actor.facts, departments: tree } };
	return viewsOf(rows, own, members, (id) =>
		heldAt(withTree, orgId, id).has('department.manage')
	);
}

async function viewOf(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	id: string
): Promise<DepartmentView> {
	const found = (await loadViews(deps, orgId, actor)).find((v) => v.id === id);
	if (!found) throw new ApiError('not_found', 'Not found');
	return found;
}

const record = (
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	action: string,
	target: string,
	detail: Record<string, unknown> = {}
) => deps.audit(orgId, { actor: principalActor(actor.principal), action, target, detail });

const duplicateName = () =>
	new ApiError('conflict', 'A department with that name already exists here', {
		reason: 'duplicate_name'
	});

async function treeOf(db: CollegeDBClient, orgId: string) {
	const rows = await listDepartments(db, orgId);
	return { rows, tree: rows.map((r) => ({ id: r.id, parentId: r.parentId, kind: r.kind })) };
}

// #region departments

export async function listDepartmentViews(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor
): Promise<DepartmentList> {
	return { items: await loadViews(deps, orgId, actor), central: central(actor) };
}

export async function createDepartment(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	body: DepartmentCreateBody
): Promise<DepartmentView> {
	if (!central(actor)) throw needsCentral();
	const db = await deps.getDb();
	const parentId = body.parentId ?? null;
	const { tree } = await treeOf(db, orgId);
	const refusal = checkParent(tree, { parentId, kind: body.kind });
	if (refusal) refuseTree(refusal);
	const row: DepartmentRow = {
		id: `dept_${deps.newId()}`,
		organizationId: orgId,
		parentId,
		name: body.name,
		kind: body.kind,
		siteQuota: null,
		createdAt: deps.now()
	};
	try {
		await insertDepartment(db, row);
	} catch (error) {
		if (error instanceof DuplicateRowError) throw duplicateName();
		throw error;
	}
	await record(deps, orgId, actor, 'department.created', row.id, {
		name: row.name,
		kind: row.kind,
		parentId
	});
	return viewOf(deps, orgId, actor, row.id);
}

// a department admin renames their own department; moving it in the tree is for owners and admins
export async function editDepartment(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	id: string,
	body: DepartmentUpdateBody
): Promise<DepartmentView> {
	const db = await deps.getDb();
	const current = await getDepartment(db, orgId, id);
	if (current === null) throw new ApiError('not_found', 'Not found');
	const moving = body.parentId !== undefined && body.parentId !== current.parentId;
	if (moving && !central(actor)) throw needsCentral();
	const parentId = body.parentId === undefined ? current.parentId : body.parentId;
	if (moving) {
		const { tree } = await treeOf(db, orgId);
		const refusal = checkParent(tree, { id, parentId, kind: current.kind });
		if (refusal) refuseTree(refusal);
	}
	const name = body.name ?? current.name;
	try {
		await updateDepartment(db, orgId, id, { name, parentId });
	} catch (error) {
		if (error instanceof DuplicateRowError) throw duplicateName();
		throw error;
	}
	await record(deps, orgId, actor, 'department.updated', id, {
		name,
		parentId,
		...(name === current.name ? {} : { was: current.name })
	});
	return viewOf(deps, orgId, actor, id);
}

export async function setQuota(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	id: string,
	siteQuota: number | null
): Promise<DepartmentView> {
	if (!central(actor)) throw needsCentral();
	const db = await deps.getDb();
	const current = await getDepartment(db, orgId, id);
	if (current === null) throw new ApiError('not_found', 'Not found');
	await setDepartmentQuota(db, orgId, id, siteQuota);
	await record(deps, orgId, actor, 'department.quota.set', id, {
		siteQuota,
		was: current.siteQuota
	});
	return viewOf(deps, orgId, actor, id);
}

export async function removeDepartment(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	id: string
): Promise<void> {
	if (!central(actor)) throw needsCentral();
	const db = await deps.getDb();
	const current = await getDepartment(db, orgId, id);
	if (current === null) throw new ApiError('not_found', 'Not found');
	const { rows } = await treeOf(db, orgId);
	if (rows.some((r) => r.parentId === id)) {
		throw new ApiError('conflict', 'Move or delete the departments inside it first', {
			reason: 'has_children'
		});
	}
	if (((await siteCounts(db, orgId)).get(id) ?? 0) > 0) {
		throw new ApiError('conflict', 'Move its sites to another department first', {
			reason: 'has_sites'
		});
	}
	await deleteDepartment(db, orgId, id);
	await record(deps, orgId, actor, 'department.deleted', id, { name: current.name });
}

// #endregion

// #region members

async function memberView(
	db: CollegeDBClient,
	row: { userId: string; role: DepartmentRole; grantedAt: number }
): Promise<DepartmentMemberView> {
	const user = await getUserById(db, row.userId);
	return {
		userId: row.userId,
		email: user?.email ?? '',
		displayName: user?.displayName ?? null,
		role: row.role,
		grantedAt: iso(row.grantedAt)
	};
}

export async function listMembersOf(
	deps: DepartmentServices,
	orgId: string,
	departmentId: string
): Promise<DepartmentMemberList> {
	const db = await deps.getDb();
	const rows = await listDepartmentMembers(db, orgId, departmentId);
	return { items: await Promise.all(rows.map((row) => memberView(db, row))) };
}

const ABOVE = 'Your role does not reach that role';

// the route already authorized the action; this keeps the service safe when called from elsewhere
function heldFor(
	actor: Actor,
	orgId: string,
	departmentId: string,
	action: 'member.invite' | 'member.update' | 'member.remove'
) {
	const held = heldAt(actor, orgId, departmentId);
	if (!held.has(action))
		throw new ApiError('forbidden', 'You do not have access to this resource');
	return held;
}

export async function addDepartmentMember(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	departmentId: string,
	body: DepartmentMemberBody
): Promise<DepartmentMemberView> {
	const db = await deps.getDb();
	const held = heldFor(actor, orgId, departmentId, 'member.invite');
	if (!canGrantRole(held, body.role)) throw new ApiError('forbidden', ABOVE);
	// an unknown address and a person outside the organization answer the same
	const user = await getUserByEmail(db, body.email);
	const member = user ? await getMember(db, orgId, user.id) : null;
	if (!user || !member) {
		throw new ApiError('validation', 'Add the person to the organization first', {
			field: 'email'
		});
	}
	const row = {
		organizationId: orgId,
		departmentId,
		userId: user.id,
		role: body.role,
		grantedBy:
			actor.principal.kind === 'user' ? actor.principal.userId : actor.principal.issuerId,
		grantedAt: deps.now()
	};
	try {
		await insertDepartmentMember(db, row);
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'That person already has a role in this department', {
				reason: 'duplicate_member'
			});
		}
		throw error;
	}
	await record(deps, orgId, actor, 'department.member.added', departmentId, {
		userId: user.id,
		role: body.role
	});
	return memberView(db, row);
}

async function existing(db: CollegeDBClient, orgId: string, departmentId: string, userId: string) {
	const row = await getDepartmentMember(db, orgId, departmentId, userId);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

export async function changeDepartmentMemberRole(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	departmentId: string,
	userId: string,
	role: DepartmentRole
): Promise<DepartmentMemberView> {
	const db = await deps.getDb();
	const held = heldFor(actor, orgId, departmentId, 'member.update');
	const row = await existing(db, orgId, departmentId, userId);
	if (!canGrantRole(held, row.role) || !canGrantRole(held, role)) {
		throw new ApiError('forbidden', ABOVE);
	}
	if (row.role !== role) {
		await setDepartmentMemberRole(db, orgId, departmentId, userId, role);
		await record(deps, orgId, actor, 'department.member.role.changed', departmentId, {
			userId,
			role,
			was: row.role
		});
	}
	return memberView(db, { ...row, role });
}

export async function removeDepartmentMemberOf(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	departmentId: string,
	userId: string
): Promise<void> {
	const db = await deps.getDb();
	const held = heldFor(actor, orgId, departmentId, 'member.remove');
	const row = await existing(db, orgId, departmentId, userId);
	if (!canGrantRole(held, row.role)) {
		throw new ApiError('forbidden', ABOVE);
	}
	await removeDepartmentMember(db, orgId, departmentId, userId);
	await record(deps, orgId, actor, 'department.member.removed', departmentId, {
		userId,
		role: row.role
	});
}

// #endregion

// #region sites

async function quotaFacts(db: CollegeDBClient, orgId: string): Promise<QuotaFacts> {
	const [{ rows, tree }, counts] = await Promise.all([treeOf(db, orgId), siteCounts(db, orgId)]);
	return { tree, quotas: new Map(rows.map((r) => [r.id, r.siteQuota])), counts };
}

function refuseQuota(refusal: NonNullable<ReturnType<typeof quotaRefusal>>): never {
	throw new ApiError('conflict', 'This department has reached its Site Limit', {
		reason: 'site_quota',
		departmentId: refusal.departmentId,
		limit: refusal.limit,
		used: refusal.used
	});
}

// called before a site is created in a department; the quota counts the whole subtree
export async function assertQuotaRoom(
	deps: DepartmentServices,
	orgId: string,
	departmentId: string
): Promise<void> {
	const facts = await quotaFacts(await deps.getDb(), orgId);
	const refusal = quotaRefusal(facts, departmentId);
	if (refusal) refuseQuota(refusal);
}

// the new site row exists once its create is recorded; this places it
export async function placeNewSite(
	deps: DepartmentServices,
	orgId: string,
	siteId: string,
	departmentId: string
): Promise<void> {
	const db = await deps.getDb();
	// a repeated create returns the first site, which already sits where it was put
	if ((await getSiteDepartment(db, orgId, siteId))?.departmentId !== null) return;
	await setSiteDepartment(db, orgId, siteId, departmentId);
}

export async function moveSite(
	deps: DepartmentServices,
	orgId: string,
	actor: Actor,
	siteId: string,
	body: SiteDepartmentBody
): Promise<SiteDepartmentView> {
	const db = await deps.getDb();
	const site = await getSiteDepartment(db, orgId, siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const to = body.departmentId;
	if (to === null) {
		if (!central(actor)) throw needsCentral();
	} else {
		if ((await getDepartment(db, orgId, to)) === null) {
			throw new ApiError('validation', 'Choose a department from this organization', {
				field: 'departmentId'
			});
		}
		if (!heldAt(actor, orgId, to).has('site.create')) {
			throw new ApiError('forbidden', 'You cannot place sites in that department');
		}
		if (to !== site.departmentId) {
			const refusal = quotaRefusal(await quotaFacts(db, orgId), to, {
				from: site.departmentId
			});
			if (refusal) refuseQuota(refusal);
		}
	}
	if (to !== site.departmentId) {
		await setSiteDepartment(db, orgId, siteId, to);
		await record(deps, orgId, actor, 'site.department.set', siteId, {
			from: site.departmentId,
			to
		});
	}
	return { siteId, departmentId: to };
}

export async function listSitePlacements(
	deps: DepartmentServices,
	orgId: string
): Promise<PlacementList> {
	return { items: await listPlacements(await deps.getDb(), orgId) };
}

// #endregion
