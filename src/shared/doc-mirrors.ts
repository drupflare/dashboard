export type MirrorId = 'worker' | 'spool';

export interface DocMirror {
	id: MirrorId;
	title: string;
	repo: string;
	ref: string;
	dir: string;
	home: string;
	routePrefix: `/docs/${MirrorId}`;
	// where the original site publishes a repo path
	originalUrl(path: string): string;
	// top-level folders in the order the original lists them; others follow alphabetically
	folderOrder?: readonly string[];
}

// the repo-relative path of the front page of each mirror
export const MIRROR_HOME_FILE = 'README.md';
export const MIRROR_NAV_FILE = `docs/nav.json`;

export const DOC_MIRRORS: readonly DocMirror[] = [
	{
		id: 'worker',
		title: 'Worker',
		repo: 'drupflare/worker',
		ref: 'master',
		dir: 'docs',
		home: 'https://docs.drupflare.com',
		routePrefix: '/docs/worker',
		originalUrl(path) {
			if (path === MIRROR_HOME_FILE) return 'https://docs.drupflare.com/';
			const name = path.replace(/^docs\//, '').replace(/\.md$/, '');
			return `https://docs.drupflare.com/${name}.html`;
		},
		folderOrder: [
			'getting-started',
			'operating',
			'architecture',
			'configuration',
			'security',
			'impact',
			'audiences'
		]
	},
	{
		id: 'spool',
		title: 'Spool',
		repo: 'drupflare/spool',
		ref: 'master',
		dir: 'docs',
		home: 'https://spool.drupflare.com',
		routePrefix: '/docs/spool',
		originalUrl(path) {
			if (path === MIRROR_HOME_FILE) return 'https://spool.drupflare.com/';
			const name = path.replace(/\.md$/, '').replaceAll('/', '_');
			return `https://spool.drupflare.com/documents/${name}.html`;
		}
	}
];

export function mirrorById(id: unknown): DocMirror | null {
	return DOC_MIRRORS.find((mirror) => mirror.id === id) ?? null;
}

// unreviewed: every cap that keeps one refresh bounded
export const MIRROR_LIMITS = {
	tarballBytes: 16 * 1024 * 1024,
	inflatedBytes: 64 * 1024 * 1024,
	entries: 20_000,
	pageBytes: 256 * 1024,
	imageBytes: 1024 * 1024,
	pages: 400,
	images: 100,
	nodesPerPage: 20_000,
	depth: 24,
	sectionChars: 2_000
} as const;

export const MIRROR_REFRESH_MS = 30 * 60_000;

export const MIRROR_IMAGE_TYPES: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	ico: 'image/x-icon'
};

const SEGMENT = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_CHARS = 128;

// null when any part could not be a page name; the slug is only ever looked up, never built into a URL
export function parseMirrorSlug(slug: string | readonly string[] | undefined): string[] | null {
	const raw = typeof slug === 'string' ? slug.split('/') : (slug ?? []);
	const parts = raw.length === 1 && raw[0] === '' ? [] : [...raw];
	if (parts.length > MAX_SEGMENTS) return null;
	for (const part of parts) {
		if (part.length > MAX_SEGMENT_CHARS || !SEGMENT.test(part)) return null;
	}
	return parts;
}

// a repo path is a safe name when it holds only these characters, which is every path the mirrors build a URL from
export function isSafeRepoPath(path: string): boolean {
	return (
		/^[A-Za-z0-9_./-]+$/.test(path) &&
		!path.startsWith('/') &&
		path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
	);
}

// the page key for a repo path: README.md is the home page (''), docs/a/b.md is 'a/b', docs/a/index.md is 'a'
export function mirrorPageKey(path: string, dir = 'docs'): string | null {
	if (!path.endsWith('.md') || !isSafeRepoPath(path)) return null;
	if (path === MIRROR_HOME_FILE) return '';
	const prefix = `${dir}/`;
	if (!path.startsWith(prefix)) return null;
	const rest = path.slice(prefix.length, -'.md'.length);
	// docs/README.md is a map for the repository, not a page
	if (rest === 'README') return null;
	return rest.replace(/\/(index|README)$/, '') || null;
}

export function mirrorRoute(mirror: Pick<DocMirror, 'routePrefix'>, key: string): string {
	return key === '' ? mirror.routePrefix : `${mirror.routePrefix}/${key}`;
}

export function mirrorAssetRoute(mirror: Pick<DocMirror, 'routePrefix'>, path: string): string {
	return `${mirror.routePrefix}/_assets/${path}`;
}

export function mirrorImageType(path: string): string | null {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return MIRROR_IMAGE_TYPES[ext] ?? null;
}

const SAFE_HREF = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

// the only hrefs a mirrored page may carry: an anchor, a dashboard docs route, http(s) or mailto
export function safeHref(href: unknown): string | null {
	if (typeof href !== 'string' || href === '' || !SAFE_HREF.test(href)) return null;
	if (href.startsWith('#')) return href;
	if (href.startsWith('/docs/') && !href.includes('//')) return href;
	try {
		const url = new URL(href);
		if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
		if (url.protocol === 'mailto:') return url.href;
	} catch {
		return null;
	}
	return null;
}

// image sources are only the dashboard asset route
export function safeImageSrc(src: unknown): string | null {
	return typeof src === 'string' &&
		/^\/docs\/[a-z]+\/_assets\/[A-Za-z0-9_./-]+$/.test(src) &&
		!src.includes('..')
		? src
		: null;
}

export interface MirrorNavItem {
	title: string;
	slug?: string[];
	url?: string;
	children?: MirrorNavItem[];
}

export function flattenMirrorNav(items: readonly MirrorNavItem[]): MirrorNavItem[] {
	return items.flatMap((item) => [
		...(item.slug ? [item] : []),
		...flattenMirrorNav(item.children ?? [])
	]);
}
