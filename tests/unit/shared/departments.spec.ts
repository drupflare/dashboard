import { describe, expect, it } from 'vitest';
import {
	buildTree,
	departmentCreateBodySchema,
	departmentUpdateBodySchema,
	quotaBodySchema,
	quotaText,
	siteDepartmentBodySchema,
	type DepartmentView
} from '../../../src/shared/departments';

const view = (id: string, name: string, parentId: string | null = null): DepartmentView => ({
	id,
	parentId,
	name,
	kind: 'department',
	siteQuota: null,
	ownSites: 0,
	subtreeSites: 0,
	childCount: 0,
	memberCount: 0,
	canManage: true,
	createdAt: '2026-11-01T10:00:00.000Z'
});

describe('buildTree', () => {
	it('nests children under parents and sorts each level by name', () => {
		const tree = buildTree([
			view('c', 'Zoology', 'a'),
			view('b', 'Botany', 'a'),
			view('a', 'Biology'),
			view('d', 'Art')
		]);
		expect(tree.map((n) => n.department.name)).toEqual(['Art', 'Biology']);
		expect(tree[1]?.children.map((n) => n.department.name)).toEqual(['Botany', 'Zoology']);
	});

	it('shows a department whose parent is missing as a root', () => {
		const tree = buildTree([view('x', 'Orphan', 'gone')]);
		expect(tree.map((n) => n.department.id)).toEqual(['x']);
	});
});

describe('quotaText', () => {
	it('reads the count against the limit', () => {
		expect(quotaText({ siteQuota: 10, subtreeSites: 3 })).toBe('3 of 10 Sites');
		expect(quotaText({ siteQuota: 1, subtreeSites: 1 })).toBe('1 of 1 Site');
		expect(quotaText({ siteQuota: null, subtreeSites: 1 })).toBe('1 Site, No Limit');
		expect(quotaText({ siteQuota: null, subtreeSites: 0 })).toBe('0 Sites, No Limit');
	});
});

describe('department bodies', () => {
	it('trims a name and refuses a blank one or an unknown kind', () => {
		expect(
			departmentCreateBodySchema.parse({ name: '  Library ', kind: 'department' }).name
		).toBe('Library');
		expect(
			departmentCreateBodySchema.safeParse({ name: '  ', kind: 'department' }).success
		).toBe(false);
		expect(departmentCreateBodySchema.safeParse({ name: 'x', kind: 'team' }).success).toBe(
			false
		);
		expect(
			departmentCreateBodySchema.safeParse({ name: 'x', kind: 'department', siteQuota: 1 })
				.success
		).toBe(false);
	});

	it('needs a name or a parent to update', () => {
		expect(departmentUpdateBodySchema.safeParse({}).success).toBe(false);
		expect(departmentUpdateBodySchema.safeParse({ parentId: null }).success).toBe(true);
		expect(departmentUpdateBodySchema.safeParse({ name: 'New' }).success).toBe(true);
	});

	it('holds a Site Limit to whole numbers from zero, or null for none', () => {
		for (const ok of [0, 5, 100_000, null]) {
			expect(quotaBodySchema.safeParse({ siteQuota: ok }).success, String(ok)).toBe(true);
		}
		for (const bad of [-1, 1.5, 100_001, '3', undefined]) {
			expect(quotaBodySchema.safeParse({ siteQuota: bad }).success, String(bad)).toBe(false);
		}
	});

	it('moves a site to a department or back to the organization', () => {
		expect(siteDepartmentBodySchema.safeParse({ departmentId: null }).success).toBe(true);
		expect(siteDepartmentBodySchema.safeParse({ departmentId: 'dept_a' }).success).toBe(true);
		expect(siteDepartmentBodySchema.safeParse({}).success).toBe(false);
	});
});
