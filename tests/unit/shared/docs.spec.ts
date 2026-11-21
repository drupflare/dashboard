import { describe, expect, it } from 'vitest';
import {
	docContentPath,
	docRoute,
	dropDraftSections,
	filterDocNav,
	flattenDocNav,
	isDocsAdminPath,
	isDocsAudience,
	isHiddenDoc
} from '../../../src/shared/docs';

const tree = [
	{ path: '/', title: 'Start Here', draft: false, audience: undefined },
	{
		path: '/guides',
		title: 'Guides',
		children: [
			{ path: '/guides/plans', title: 'Plans', audience: ['department-owner'], draft: false },
			{ path: '/guides/teams', title: 'Teams', audience: ['agency'], draft: true },
			{ path: '/guides/data', title: 'Data', audience: ['nonprofit'], draft: false }
		]
	},
	{
		path: '/archive',
		title: 'Archive',
		children: [{ path: '/archive/old', title: 'Old', draft: true }]
	}
];

describe('docs paths', () => {
	it('maps a catch-all slug to a content path and back to a route', () => {
		expect(docContentPath([])).toBe('/');
		expect(docContentPath(['guides', 'billing', 'plans'])).toBe('/guides/billing/plans');
		expect(docRoute('/')).toBe('/docs');
		expect(docRoute('/guides/billing/plans')).toBe('/docs/guides/billing/plans');
	});

	it('marks only the admin subtree', () => {
		expect(isDocsAdminPath('/docs/admin')).toBe(true);
		expect(isDocsAdminPath('/docs/admin/on-call')).toBe(true);
		expect(isDocsAdminPath('/docs/administrators')).toBe(false);
		expect(isDocsAdminPath('/docs/guides/admin')).toBe(false);
	});

	it('accepts only the eight audience tags', () => {
		expect(isDocsAudience('central-it')).toBe(true);
		expect(isDocsAudience('admin')).toBe(false);
		expect(isDocsAudience(undefined)).toBe(false);
	});
});

describe('isHiddenDoc', () => {
	it('hides a missing page everywhere and a draft only outside development', () => {
		expect(isHiddenDoc(null, true)).toBe(true);
		expect(isHiddenDoc(undefined, false)).toBe(true);
		expect(isHiddenDoc({ draft: true }, false)).toBe(true);
		expect(isHiddenDoc({ draft: true }, true)).toBe(false);
		expect(isHiddenDoc({ draft: false }, false)).toBe(false);
	});
});

describe('filterDocNav', () => {
	it('hides drafts outside development and keeps them locally', () => {
		const hidden = filterDocNav(tree, { includeDrafts: false });
		expect(hidden.flatMap((item) => item.children ?? []).map((item) => item.title)).toEqual([
			'Plans',
			'Data'
		]);
		expect(hidden.map((item) => item.title)).toEqual(['Start Here', 'Guides']);
		const local = filterDocNav(tree, { includeDrafts: true });
		expect(local[1]!.children!.map((item) => item.title)).toEqual(['Plans', 'Teams', 'Data']);
	});

	it('keeps only pages for the audience and drops a folder left empty', () => {
		const owners = filterDocNav(tree, { audience: 'department-owner', includeDrafts: false });
		expect(owners.map((item) => item.title)).toEqual(['Start Here', 'Guides']);
		expect(owners[1]!.children!.map((item) => item.title)).toEqual(['Plans']);
	});

	it('does not drop a page without an audience tag', () => {
		const owners = filterDocNav(tree, { audience: 'developer', includeDrafts: false });
		expect(owners.find((item) => item.title === 'Start Here')).toBeDefined();
		expect(owners.find((item) => item.title === 'Guides')).toBeUndefined();
	});
});

describe('flattenDocNav', () => {
	it('lists folders as groups at their depth', () => {
		const rows = flattenDocNav(filterDocNav(tree, { includeDrafts: false }));
		expect(rows).toEqual([
			{ path: '/', title: 'Start Here', depth: 0, group: false },
			{ path: '/guides', title: 'Guides', depth: 0, group: true },
			{ path: '/guides/plans', title: 'Plans', depth: 1, group: false },
			{ path: '/guides/data', title: 'Data', depth: 1, group: false }
		]);
	});
});

describe('dropDraftSections', () => {
	it('removes every section of a draft page, anchors included', () => {
		const sections = [
			{ id: '/guides/plans' },
			{ id: '/guides/plans#limits' },
			{ id: '/guides/teams#seats' },
			{ id: '/' }
		];
		expect(dropDraftSections(sections, new Set(['/guides/teams']))).toEqual([
			{ id: '/guides/plans' },
			{ id: '/guides/plans#limits' },
			{ id: '/' }
		]);
	});
});
