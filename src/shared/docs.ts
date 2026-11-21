export const DOCS_AUDIENCES = [
	'solo-beginner',
	'developer',
	'agency',
	'nonprofit',
	'department-owner',
	'central-it',
	'security-reviewer',
	'self-hosting-operator'
] as const;

export type DocsAudience = (typeof DOCS_AUDIENCES)[number];

export interface DocNavItem {
	path: string;
	draft?: boolean;
	audience?: readonly string[];
	children?: DocNavItem[];
}

// content paths have no /docs prefix: docs/index.md is "/", docs/guides/x.md is "/guides/x"
export function docContentPath(slug: readonly string[]): string {
	return slug.length ? `/${slug.join('/')}` : '/';
}

export function docRoute(contentPath: string): string {
	return contentPath === '/' ? '/docs' : `/docs${contentPath}`;
}

export function isDocsAdminPath(routePath: string): boolean {
	return routePath === '/docs/admin' || routePath.startsWith('/docs/admin/');
}

// a draft page is served only where the app runs locally; a missing page is always hidden
export function isHiddenDoc(doc: { draft?: boolean } | null | undefined, isDev: boolean): boolean {
	return !doc || (doc.draft === true && !isDev);
}

export function isDocsAudience(value: unknown): value is DocsAudience {
	return typeof value === 'string' && (DOCS_AUDIENCES as readonly string[]).includes(value);
}

// a directory keeps its place while any child survives; a page survives when it is listed
export function filterDocNav<T extends DocNavItem>(
	items: readonly T[],
	options: { audience?: string | null; includeDrafts: boolean }
): T[] {
	const kept: T[] = [];
	for (const item of items) {
		if (item.draft && !options.includeDrafts) continue;
		const children = item.children ? filterDocNav(item.children as T[], options) : undefined;
		const matches =
			!options.audience || !item.audience || item.audience.includes(options.audience);
		const hasChildren = children !== undefined && children.length > 0;
		if (!hasChildren && item.children) continue;
		if (!hasChildren && !matches) continue;
		kept.push({ ...item, children: children ?? item.children });
	}
	return kept;
}

export interface FlatDocNav {
	path: string;
	title: string;
	depth: number;
	group: boolean;
}

// a group is a folder: it labels its children and has no page of its own
export function flattenDocNav<T extends DocNavItem & { title: string }>(
	items: readonly T[],
	depth = 0
): FlatDocNav[] {
	return items.flatMap((item) => [
		{
			path: item.path,
			title: item.title,
			depth,
			group: Boolean(item.children && item.children.length > 0)
		},
		...flattenDocNav(item.children ? (item.children as T[]) : [], depth + 1)
	]);
}

// search sections are "path" or "path#anchor"; a draft page's sections never leave the server
export function dropDraftSections<T extends { id: string }>(
	sections: readonly T[],
	draftPaths: ReadonlySet<string>
): T[] {
	return sections.filter((section) => !draftPaths.has(section.id.split('#')[0]!));
}
