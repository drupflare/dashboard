import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as cap from '../../../src/server/domain/cap-by-policy';
import {
	ancestors,
	canGrantRole,
	chainOf,
	checkParent,
	depthOf,
	descendants,
	effectiveActions,
	heightOf,
	isCentral,
	nearestGrants,
	quotaRefusal,
	reachableActions,
	subtreeCount,
	type DepartmentNode,
	type GrantFacts,
	type QuotaFacts
} from '../../../src/server/domain/departments';
import type { Grant, PolicyGroup } from '../../../src/server/domain/policy';
import { ORG, OTHER_ORG } from './fixtures';

const node = (
	id: string,
	parentId: string | null,
	kind: DepartmentNode['kind'] = 'department'
): DepartmentNode => ({ id, parentId, kind });

// campus > college > dept > lab, plus a second branch under campus
const TREE: DepartmentNode[] = [
	node('campus', null, 'division'),
	node('college', 'campus', 'division'),
	node('dept', 'college'),
	node('lab', 'dept'),
	node('arts', 'campus', 'division'),
	node('other-root', null)
];

describe('department tree', () => {
	it('walks up and down', () => {
		expect(ancestors(TREE, 'lab')).toEqual(['dept', 'college', 'campus']);
		expect(ancestors(TREE, 'campus')).toEqual([]);
		expect(chainOf(TREE, 'dept')).toEqual(['dept', 'college', 'campus']);
		expect(chainOf(undefined, 'dept')).toEqual(['dept']);
		expect(descendants(TREE, 'campus').sort()).toEqual(['arts', 'college', 'dept', 'lab']);
		expect(descendants(TREE, 'lab')).toEqual([]);
		expect(depthOf(TREE, 'lab')).toBe(4);
		expect(heightOf(TREE, 'campus')).toBe(4);
		expect(heightOf(TREE, 'arts')).toBe(1);
	});

	it('stops at a loop in bad data', () => {
		const loop = [node('a', 'b'), node('b', 'a')];
		expect(ancestors(loop, 'a')).toEqual(['b']);
		expect(descendants(loop, 'a')).toEqual(['b']);
	});

	it('accepts a root and a legal parent', () => {
		expect(checkParent(TREE, { parentId: null, kind: 'department' })).toBeNull();
		expect(checkParent(TREE, { parentId: 'arts', kind: 'department' })).toBeNull();
		expect(checkParent(TREE, { parentId: 'campus', kind: 'division' })).toBeNull();
	});

	it('refuses a missing parent, a self parent and a cycle', () => {
		expect(checkParent(TREE, { parentId: 'nope', kind: 'department' })).toBe('parent_missing');
		expect(checkParent(TREE, { id: 'dept', parentId: 'dept', kind: 'department' })).toBe(
			'self_parent'
		);
		expect(checkParent(TREE, { id: 'campus', parentId: 'lab', kind: 'division' })).toBe(
			'cycle'
		);
		expect(checkParent(TREE, { id: 'college', parentId: 'dept', kind: 'division' })).toBe(
			'cycle'
		);
	});

	it('refuses a fifth level, for a new node and for a moved subtree', () => {
		expect(checkParent(TREE, { parentId: 'lab', kind: 'department' })).toBe('depth');
		// college holds three levels (college, dept, lab); under arts it would reach depth 5
		expect(checkParent(TREE, { id: 'college', parentId: 'arts', kind: 'division' })).toBe(
			'depth'
		);
		// the lab alone fits under arts
		expect(checkParent(TREE, { id: 'lab', parentId: 'arts', kind: 'department' })).toBeNull();
	});

	it('keeps a division out of a department', () => {
		expect(checkParent(TREE, { parentId: 'dept', kind: 'division' })).toBe(
			'division_under_department'
		);
	});

	it('gives each department one parent', () => {
		const parents = TREE.map((n) => n.parentId);
		expect(parents).toHaveLength(TREE.length);
		expect(new Set(TREE.map((n) => n.id)).size).toBe(TREE.length);
	});
});

const deptGrant = (targetId: string, role: Grant['role'], orgId = ORG): Grant => ({
	level: 'department',
	orgId,
	targetId,
	role: role as never
});
const siteGrant = (targetId: string, role: Grant['role']): Grant => ({
	level: 'site',
	orgId: ORG,
	targetId,
	role: role as never
});

const base = (over: Partial<GrantFacts> = {}): GrantFacts => ({
	orgId: ORG,
	grants: [],
	departments: TREE,
	...over
});

describe('nearestGrants', () => {
	it('lists the site, the department, each parent, then the organisation, nearest first', () => {
		const facts = base({
			membership: { orgId: ORG, role: 'viewer' },
			grants: [
				deptGrant('campus', 'viewer'),
				siteGrant('s1', 'maintainer'),
				deptGrant('dept', 'developer')
			]
		});
		const got = nearestGrants(facts, { departmentId: 'lab', siteId: 's1' });
		expect(got.map((g) => [g.level, g.targetId ?? null, g.distance])).toEqual([
			['site', 's1', 0],
			['department', 'dept', 2],
			['department', 'campus', 4],
			['organisation', null, 5]
		]);
	});

	it('leaves out other departments, other sites and other organisations', () => {
		const facts = base({
			grants: [
				deptGrant('arts', 'admin'),
				deptGrant('dept', 'admin', OTHER_ORG),
				siteGrant('s2', 'viewer')
			],
			membership: { orgId: OTHER_ORG, role: 'owner' }
		});
		expect(nearestGrants(facts, { departmentId: 'lab', siteId: 's1' })).toEqual([]);
	});
});

describe('effectiveActions', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('is the union of an organisation viewer and a department admin grant', () => {
		const facts = base({
			membership: { orgId: ORG, role: 'viewer' },
			grants: [deptGrant('college', 'admin')]
		});
		const inside = effectiveActions(facts, { departmentId: 'dept' });
		expect(inside.has('org.read')).toBe(true);
		expect(inside.has('member.invite')).toBe(true);
		expect(inside.has('site.create')).toBe(true);
		expect(inside.has('org.update')).toBe(false);
		const outside = effectiveActions(facts, { departmentId: 'arts' });
		expect(outside.has('org.read')).toBe(true);
		expect(outside.has('member.invite')).toBe(false);
	});

	it('hands the union to the policy hook with the department and site', () => {
		const spy = vi.spyOn(cap, 'capByPolicy');
		const policy: PolicyGroup[] = [{ id: 'g', name: 'G', rules: [] }];
		effectiveActions(
			{ ...base({ grants: [deptGrant('dept', 'admin')] }), policy },
			{ departmentId: 'dept', siteId: 's1' }
		);
		expect(spy).toHaveBeenCalledOnce();
		expect(spy.mock.calls[0]?.[1]).toEqual({
			orgId: ORG,
			departmentId: 'dept',
			siteId: 's1',
			policy
		});
	});

	it('returns what the policy hook returns', () => {
		vi.spyOn(cap, 'capByPolicy').mockImplementation((actions) => {
			const next = new Set(actions);
			next.delete('member.invite');
			return next;
		});
		const got = effectiveActions(base({ grants: [deptGrant('dept', 'admin')] }), {
			departmentId: 'dept'
		});
		expect(got.has('member.invite')).toBe(false);
		expect(got.has('site.create')).toBe(true);
	});

	it('passes the actions through while no policy narrows them', () => {
		const actions = new Set(['site.read'] as const);
		expect(cap.capByPolicy(actions, { policy: [] })).toBe(actions);
	});
});

describe('granting a role', () => {
	const held = (role: Grant['role'], at = 'dept') =>
		effectiveActions(base({ grants: [deptGrant(at, role)] }), { departmentId: at });

	it('lets an admin give the department roles it holds, and a developer give no admin role', () => {
		for (const role of ['admin', 'developer', 'viewer'] as const) {
			expect(canGrantRole(held('admin'), role), role).toBe(true);
		}
		// billing carries site.budget.manage; admin does not hold it
		expect(reachableActions('billing')).toContain('site.budget.manage');
		expect(canGrantRole(held('admin'), 'billing')).toBe(false);
		expect(canGrantRole(held('developer'), 'admin')).toBe(false);
		expect(canGrantRole(held('developer'), 'developer')).toBe(true);
		expect(canGrantRole(held('developer'), 'viewer')).toBe(true);
		expect(canGrantRole(held('viewer'), 'developer')).toBe(false);
	});

	it('counts only what a department role reaches', () => {
		expect(reachableActions('admin')).toContain('member.invite');
		expect(reachableActions('admin')).not.toContain('org.update');
		expect(reachableActions('viewer')).toContain('site.read');
	});

	it('never lets an empty set give anything that carries an action', () => {
		expect(canGrantRole(new Set(), 'viewer')).toBe(false);
	});
});

describe('Site Limit', () => {
	const quotas = (entries: [string, number | null][]) => new Map(entries);
	const facts = (q: [string, number | null][], counts: [string, number][]): QuotaFacts => ({
		tree: TREE,
		quotas: quotas(q),
		counts: new Map(counts)
	});

	it('counts the whole subtree', () => {
		const f = facts(
			[],
			[
				['campus', 1],
				['dept', 2],
				['lab', 3],
				['arts', 4],
				['other-root', 9]
			]
		);
		expect(subtreeCount(f, 'campus')).toBe(10);
		expect(subtreeCount(f, 'college')).toBe(5);
		expect(subtreeCount(f, 'lab')).toBe(3);
	});

	it('allows a create while there is room and names the department that is full', () => {
		const f = facts(
			[['college', 5]],
			[
				['dept', 2],
				['lab', 2]
			]
		);
		expect(quotaRefusal(f, 'lab')).toBeNull();
		const full = facts(
			[['college', 4]],
			[
				['dept', 2],
				['lab', 2]
			]
		);
		expect(quotaRefusal(full, 'lab')).toEqual({ departmentId: 'college', limit: 4, used: 4 });
	});

	it('lets a parent limit bind a department with no limit of its own', () => {
		const f = facts(
			[
				['campus', 1],
				['lab', null]
			],
			[['arts', 1]]
		);
		expect(quotaRefusal(f, 'lab')?.departmentId).toBe('campus');
		expect(quotaRefusal(f, 'other-root')).toBeNull();
	});

	it('checks the nearest limit first and each one above it', () => {
		const f = facts(
			[
				['dept', 1],
				['campus', 99]
			],
			[['dept', 1]]
		);
		expect(quotaRefusal(f, 'lab')?.departmentId).toBe('dept');
	});

	it('treats a limit of zero as closed and a missing limit as open', () => {
		expect(quotaRefusal(facts([['arts', 0]], []), 'arts')).toEqual({
			departmentId: 'arts',
			limit: 0,
			used: 0
		});
		expect(quotaRefusal(facts([], [['arts', 500]]), 'arts')).toBeNull();
	});

	it('does not count a moved site twice in a limit it already sits under', () => {
		const f = facts(
			[
				['college', 2],
				['dept', 5]
			],
			[
				['dept', 1],
				['lab', 1]
			]
		);
		// lab to dept stays inside college, which is full, but nothing is added there
		expect(quotaRefusal(f, 'dept', { from: 'lab' })).toBeNull();
		// arts to dept adds one to college
		expect(quotaRefusal(f, 'dept', { from: 'arts' })?.departmentId).toBe('college');
	});
});

describe('central IT', () => {
	it('is the organisation owner and admin', () => {
		expect(isCentral({ role: 'owner' })).toBe(true);
		expect(isCentral({ role: 'admin' })).toBe(true);
		expect(isCentral({ role: 'developer' })).toBe(false);
		expect(isCentral(undefined)).toBe(false);
	});
});
