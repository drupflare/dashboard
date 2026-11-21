import {
	DEPARTMENT_ROLES,
	MAX_DEPARTMENT_DEPTH,
	type DepartmentKind,
	type DepartmentRole
} from '../../shared/departments';
import {
	ACTIONS,
	ORG_ROLE_ACTIONS,
	type Action,
	type OrgRole,
	type SiteRole
} from '../../shared/permissions';
import { capByPolicy } from './cap-by-policy';
import { grantProvides, grantReaches, type AnyGrant, type Grant, type PolicyGroup } from './policy';

// #region tree

export interface DepartmentNode {
	id: string;
	parentId: string | null;
	kind: DepartmentKind;
}

export type TreeRefusal =
	'parent_missing' | 'self_parent' | 'cycle' | 'depth' | 'division_under_department';

const byId = (tree: readonly DepartmentNode[]) => new Map(tree.map((node) => [node.id, node]));

// parent first, then upward; a loop in bad data stops at the first repeat
export function ancestors(tree: readonly DepartmentNode[], id: string): string[] {
	const nodes = byId(tree);
	const out: string[] = [];
	const seen = new Set([id]);
	let at = nodes.get(id)?.parentId ?? null;
	while (at !== null && !seen.has(at)) {
		out.push(at);
		seen.add(at);
		at = nodes.get(at)?.parentId ?? null;
	}
	return out;
}

export function descendants(tree: readonly DepartmentNode[], id: string): string[] {
	const children = new Map<string, string[]>();
	for (const node of tree) {
		if (node.parentId === null) continue;
		children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
	}
	const out: string[] = [];
	const seen = new Set([id]);
	const queue = [...(children.get(id) ?? [])];
	while (queue.length > 0) {
		const next = queue.shift() as string;
		if (seen.has(next)) continue;
		seen.add(next);
		out.push(next);
		queue.push(...(children.get(next) ?? []));
	}
	return out;
}

// the node and its ancestors, nearest first
export function chainOf(tree: readonly DepartmentNode[] | undefined, id: string): string[] {
	return [id, ...ancestors(tree ?? [], id)];
}

// levels from the root down to and including the node
export function depthOf(tree: readonly DepartmentNode[], id: string): number {
	return 1 + ancestors(tree, id).length;
}

// levels in the subtree below and including the node
export function heightOf(tree: readonly DepartmentNode[], id: string): number {
	const below = new Set(descendants(tree, id));
	let height = 1;
	for (const node of tree) {
		if (below.has(node.id))
			height = Math.max(height, depthOf(tree, node.id) - depthOf(tree, id) + 1);
	}
	return height;
}

// whether a node may sit under a parent. `id` is set when an existing node moves
export function checkParent(
	tree: readonly DepartmentNode[],
	input: { id?: string; parentId: string | null; kind: DepartmentKind }
): TreeRefusal | null {
	if (input.parentId === null) return null;
	const parent = tree.find((node) => node.id === input.parentId);
	if (!parent) return 'parent_missing';
	if (input.id !== undefined) {
		if (input.id === input.parentId) return 'self_parent';
		if (descendants(tree, input.id).includes(input.parentId)) return 'cycle';
	}
	if (input.kind === 'division' && parent.kind === 'department')
		return 'division_under_department';
	const own = input.id === undefined ? 1 : heightOf(tree, input.id);
	if (depthOf(tree, parent.id) + own > MAX_DEPARTMENT_DEPTH) return 'depth';
	return null;
}

// #endregion

// #region grants

export interface NearestGrant {
	level: 'site' | 'department' | 'organisation';
	// 0 is the site itself; each step up the tree adds one
	distance: number;
	role: string;
	targetId?: string;
}

export interface GrantFacts {
	orgId: string;
	membership?: { orgId: string; role: OrgRole };
	grants: readonly Grant[];
	departments?: readonly DepartmentNode[];
}

export interface GrantTarget {
	departmentId?: string;
	siteId?: string;
}

// every grant that applies to the target, nearest first: the site, its department, each parent
// department, then the organisation
export function nearestGrants(facts: GrantFacts, target: GrantTarget): NearestGrant[] {
	const out: NearestGrant[] = [];
	if (target.siteId !== undefined) {
		for (const g of facts.grants) {
			if (g.level === 'site' && g.orgId === facts.orgId && g.targetId === target.siteId) {
				out.push({ level: 'site', distance: 0, role: g.role, targetId: g.targetId });
			}
		}
	}
	let distance = 1;
	if (target.departmentId !== undefined) {
		for (const id of chainOf(facts.departments, target.departmentId)) {
			for (const g of facts.grants) {
				if (g.level === 'department' && g.orgId === facts.orgId && g.targetId === id) {
					out.push({ level: 'department', distance, role: g.role, targetId: id });
				}
			}
			distance++;
		}
	}
	if (facts.membership?.orgId === facts.orgId) {
		out.push({ level: 'organisation', distance, role: facts.membership.role });
	}
	return out;
}

function actionsOf(grant: NearestGrant): readonly Action[] {
	const any: AnyGrant =
		grant.level === 'site'
			? { level: 'site', orgId: '', targetId: '', role: grant.role as SiteRole }
			: grant.level === 'department'
				? {
						level: 'department',
						orgId: '',
						targetId: grant.targetId ?? '',
						role: grant.role as OrgRole
					}
				: { level: 'organisation', role: grant.role as OrgRole };
	return ACTIONS.filter((action) => grantProvides(any, action));
}

// the union of what the nearest grants allow, then what policy lets through
export function effectiveActions(
	facts: GrantFacts & { policy?: readonly PolicyGroup[] },
	target: GrantTarget
): ReadonlySet<Action> {
	const union = new Set<Action>();
	for (const grant of nearestGrants(facts, target)) {
		for (const action of actionsOf(grant)) union.add(action);
	}
	return capByPolicy(union, {
		orgId: facts.orgId,
		...target,
		policy: facts.policy ?? []
	});
}

// what a department role gives inside a department: the role's actions at department scope or below
export function reachableActions(role: DepartmentRole): readonly Action[] {
	return ORG_ROLE_ACTIONS[role].filter((action) => grantReaches('department', action));
}

// nobody gives a role that carries an action they do not hold themselves
export function canGrantRole(held: ReadonlySet<Action>, role: DepartmentRole): boolean {
	return reachableActions(role).every((action) => held.has(action));
}

export function isDepartmentRole(value: unknown): value is DepartmentRole {
	return typeof value === 'string' && (DEPARTMENT_ROLES as readonly string[]).includes(value);
}

// the organisation owners and admins; only they set quotas and shape the top of the tree
export function isCentral(membership: { role: string } | undefined | null): boolean {
	return membership?.role === 'owner' || membership?.role === 'admin';
}

// #endregion

// #region quota

export interface QuotaFacts {
	tree: readonly DepartmentNode[];
	quotas: ReadonlyMap<string, number | null>;
	// sites placed directly in each department
	counts: ReadonlyMap<string, number>;
}

// sites in the department and everything below it
export function subtreeCount(facts: QuotaFacts, id: string): number {
	let total = facts.counts.get(id) ?? 0;
	for (const below of descendants(facts.tree, id)) total += facts.counts.get(below) ?? 0;
	return total;
}

export interface QuotaRefusal {
	departmentId: string;
	limit: number;
	used: number;
}

// whether `adding` more sites fit under a department; it and each ancestor with a quota count
// their whole subtree, and `from` is where a moved site leaves, so a shared ancestor gains nothing
export function quotaRefusal(
	facts: QuotaFacts,
	departmentId: string,
	opts: { adding?: number; from?: string | null } = {}
): QuotaRefusal | null {
	const adding = opts.adding ?? 1;
	const leaving = new Set(opts.from ? chainOf(facts.tree, opts.from) : []);
	for (const id of chainOf(facts.tree, departmentId)) {
		const limit = facts.quotas.get(id);
		if (limit === null || limit === undefined) continue;
		if (leaving.has(id)) continue;
		const used = subtreeCount(facts, id);
		if (used + adding > limit) return { departmentId: id, limit, used };
	}
	return null;
}

// #endregion
