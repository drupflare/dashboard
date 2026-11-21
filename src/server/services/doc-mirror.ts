import { parseTar, tarEntryTree, TarPathError } from '@drupflare/untarl';
import {
	flattenMirrorNav,
	isSafeRepoPath,
	MIRROR_HOME_FILE,
	MIRROR_LIMITS,
	MIRROR_NAV_FILE,
	MIRROR_REFRESH_MS,
	mirrorImageType,
	mirrorPageKey,
	mirrorRoute,
	parseMirrorSlug,
	type DocMirror,
	type MirrorNavItem
} from '../../shared/doc-mirrors';
import {
	renderMarkdown,
	searchSections,
	type MNode,
	type SearchSection,
	type TocLink
} from './doc-mirror-render';

export interface KvLike {
	get(key: string, type: 'json' | 'arrayBuffer'): Promise<unknown>;
	put(
		key: string,
		value: string | ArrayBuffer,
		options?: { expirationTtl?: number }
	): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: {
		prefix: string;
		cursor?: string;
	}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface MirrorDeps {
	kv: KvLike;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	now: () => number;
}

export interface MirrorMeta {
	sha: string;
	etag: string | null;
	syncedAt: number;
	checkedAt: number;
	ref: string;
	nav: MirrorNavItem[];
	pages: number;
	assets: number;
	skipped: string[];
}

export interface StoredPage {
	key: string;
	path: string;
	title: string;
	hasH1: boolean;
	nodes: MNode[];
	toc: TocLink[];
	original: string;
}

export interface MirrorPageView {
	page: StoredPage;
	nav: MirrorNavItem[];
	previous: MirrorNavItem | null;
	next: MirrorNavItem | null;
	sha: string;
	syncedAt: number | null;
	original: string;
	home: string;
	fromFallback: boolean;
}

// null when the KV namespace is not bound (a local run without bindings)
export function mirrorDepsOf(env: { CACHE?: unknown } | undefined): MirrorDeps | null {
	if (!env?.CACHE) return null;
	return {
		kv: env.CACHE as KvLike,
		fetch: (url, init) => fetch(url, init),
		now: Date.now
	};
}

export class MirrorError extends Error {
	constructor(message: string) {
		super(`doc mirror: ${message}`);
		this.name = 'MirrorError';
	}
}

const USER_AGENT = 'drupflare-docs-mirror (support@drupflare.com)';
const RAW_HOST = 'https://raw.githubusercontent.com';
const CODELOAD_HOST = 'https://codeload.github.com';
const FALLBACK_TTL_S = 3600;

// #region keys
const metaKey = (id: string) => `docmirror:${id}:meta`;
const pageKeyOf = (id: string, sha: string, key: string) => `docmirror:${id}:${sha}:p:${key}`;
const assetKeyOf = (id: string, sha: string, path: string) => `docmirror:${id}:${sha}:a:${path}`;
const searchKeyOf = (id: string, sha: string) => `docmirror:${id}:${sha}:search`;
const rawKeyOf = (id: string, key: string) => `docmirror:${id}:raw:${key}`;
const lastRunKey = 'docmirror:lastrun';
const statusKey = (id: string) => `docmirror:${id}:status`;
// #endregion

// true once the gap since the last attempt reaches the refresh interval; the minute cron may drift by a few seconds
export function refreshDue(now: number, lastAttempt: number | null): boolean {
	return lastAttempt === null || now - lastAttempt >= MIRROR_REFRESH_MS - 30_000;
}

// #region download
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get('content-length') ?? '0');
	if (declared > max)
		throw new MirrorError(`the download is ${declared} bytes, over the ${max} cap`);
	if (!response.body) throw new MirrorError('the response has no body');
	return drain(response.body, max, 'download');
}

async function drain(stream: ReadableStream<Uint8Array>, max: number, what: string) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel().catch(() => undefined);
			throw new MirrorError(`the ${what} passed the ${max} byte cap`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}

export function inflateCapped(bytes: Uint8Array, max: number): Promise<Uint8Array> {
	const gunzip = new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>;
	return drain(new Blob([bytes as BlobPart]).stream().pipeThrough(gunzip), max, 'archive');
}

// git archive writes the commit id in the pax global header at the start of the tar
export function commitOf(tar: Uint8Array): string | null {
	const head = new TextDecoder('latin1').decode(tar.subarray(0, 1024));
	return head.match(/comment=([0-9a-f]{40})\b/)?.[1] ?? null;
}
// #endregion

export interface Extracted {
	files: Map<string, Uint8Array>;
	skipped: string[];
}

// the docs folder, the home file and the navigation file, with every cap applied; a hostile path fails the archive
export function extractDocs(tar: Uint8Array, mirror: DocMirror): Extracted {
	const entries = parseTar(tar);
	if (entries.length > MIRROR_LIMITS.entries) {
		throw new MirrorError(
			`the archive has ${entries.length} entries, over the ${MIRROR_LIMITS.entries} cap`
		);
	}
	let tree: Map<string, Uint8Array>;
	try {
		tree = tarEntryTree(entries, 1);
	} catch (error) {
		if (error instanceof TarPathError) throw new MirrorError(error.message);
		throw error;
	}
	const files = new Map<string, Uint8Array>();
	const skipped: string[] = [];
	let pages = 0;
	let images = 0;
	for (const [path, bytes] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
		const inDocs = path.startsWith(`${mirror.dir}/`);
		if (!inDocs && path !== MIRROR_HOME_FILE) continue;
		if (!isSafeRepoPath(path)) {
			skipped.push(`${path}: unusual characters in the name`);
			continue;
		}
		if (path.endsWith('.md')) {
			if (mirrorPageKey(path, mirror.dir) === null) continue;
			if (bytes.byteLength > MIRROR_LIMITS.pageBytes) {
				skipped.push(`${path}: over the page size cap`);
				continue;
			}
			if (++pages > MIRROR_LIMITS.pages) {
				skipped.push(`${path}: over the page count cap`);
				continue;
			}
			files.set(path, bytes);
		} else if (path === MIRROR_NAV_FILE) {
			if (bytes.byteLength <= MIRROR_LIMITS.pageBytes) files.set(path, bytes);
		} else if (mirrorImageType(path)) {
			if (bytes.byteLength > MIRROR_LIMITS.imageBytes) {
				skipped.push(`${path}: over the image size cap`);
				continue;
			}
			if (++images > MIRROR_LIMITS.images) {
				skipped.push(`${path}: over the image count cap`);
				continue;
			}
			files.set(path, bytes);
		}
	}
	return { files, skipped };
}

// #region navigation
const humanize = (segment: string) =>
	segment
		.split(/[-_]/)
		.map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
		.join(' ');

interface TrieNode {
	segment: string;
	page?: { key: string; title: string };
	children: Map<string, TrieNode>;
}

export function navFromTree(
	pages: readonly { key: string; title: string }[],
	order: readonly string[] = []
): MirrorNavItem[] {
	const root: TrieNode = { segment: '', children: new Map() };
	for (const page of pages) {
		let node = root;
		for (const segment of page.key === '' ? [] : page.key.split('/')) {
			let next = node.children.get(segment);
			if (!next) {
				next = { segment, children: new Map() };
				node.children.set(segment, next);
			}
			node = next;
		}
		node.page = page;
	}
	const rank = (segment: string) => {
		const at = order.indexOf(segment);
		return at === -1 ? order.length : at;
	};
	const toItem = (node: TrieNode, top: boolean): MirrorNavItem => {
		const kids = [...node.children.values()]
			.sort(
				(a, b) =>
					(top ? rank(a.segment) - rank(b.segment) : 0) ||
					a.segment.localeCompare(b.segment)
			)
			.map((child) => toItem(child, false));
		return {
			title: node.page?.title ?? humanize(node.segment),
			...(node.page ? { slug: node.page.key === '' ? [] : node.page.key.split('/') } : {}),
			...(kids.length ? { children: kids } : {})
		};
	};
	const items: MirrorNavItem[] = [];
	if (root.page) items.push({ title: root.page.title, slug: [] });
	const top = [...root.children.values()].sort(
		(a, b) => rank(a.segment) - rank(b.segment) || a.segment.localeCompare(b.segment)
	);
	for (const node of top) items.push(toItem(node, false));
	return items;
}

interface NavEntry {
	title?: unknown;
	path?: unknown;
	url?: unknown;
}
interface NavGroup {
	title?: unknown;
	pages?: unknown;
	sections?: unknown;
}

// the spool nav.json: groups of pages, with optional sections; unknown paths and unsafe urls are dropped
export function navFromManifest(
	json: unknown,
	keyOfPath: (path: string) => string | undefined,
	isSafeUrl: (url: string) => boolean
): MirrorNavItem[] {
	const groups = (json as { groups?: unknown })?.groups;
	if (!Array.isArray(groups)) return [];
	const entries = (list: unknown): MirrorNavItem[] =>
		(Array.isArray(list) ? (list as NavEntry[]) : []).flatMap((entry): MirrorNavItem[] => {
			if (typeof entry?.title !== 'string') return [];
			if (typeof entry.url === 'string') {
				return isSafeUrl(entry.url) ? [{ title: entry.title, url: entry.url }] : [];
			}
			if (typeof entry.path !== 'string') return [];
			const key = keyOfPath(entry.path.split('#')[0]!);
			return key === undefined
				? []
				: [{ title: entry.title, slug: key === '' ? [] : key.split('/') }];
		});
	return (groups as NavGroup[]).flatMap((group) => {
		if (typeof group?.title !== 'string') return [];
		const children = [
			...entries(group.pages),
			...(Array.isArray(group.sections) ? (group.sections as NavGroup[]) : []).flatMap(
				(section) => {
					const inner = entries(section?.pages);
					return typeof section?.title === 'string' && inner.length
						? [{ title: section.title, children: inner }]
						: [];
				}
			)
		];
		return children.length ? [{ title: group.title, children }] : [];
	});
}
// #endregion

export interface Built {
	meta: Omit<MirrorMeta, 'syncedAt' | 'checkedAt' | 'etag'>;
	pages: Map<string, StoredPage>;
	assets: Map<string, Uint8Array>;
	search: SearchSection[];
}

export function buildMirror(mirror: DocMirror, sha: string, extracted: Extracted): Built {
	const pagePaths = new Map<string, string>();
	const assetPaths = new Set<string>();
	for (const path of extracted.files.keys()) {
		const key = path.endsWith('.md') ? mirrorPageKey(path, mirror.dir) : null;
		if (key !== null) {
			// the first path wins when two files name the same page
			if (![...pagePaths.values()].includes(key)) pagePaths.set(path, key);
		} else if (mirrorImageType(path)) assetPaths.add(path);
	}
	const skipped = [...extracted.skipped];
	const pages = new Map<string, StoredPage>();
	const search: SearchSection[] = [];
	const decoder = new TextDecoder('utf-8');
	for (const [path, key] of pagePaths) {
		const source = decoder.decode(extracted.files.get(path)!);
		try {
			const rendered = renderMarkdown(source, {
				mirror,
				path,
				pages: pagePaths,
				assets: assetPaths
			});
			pages.set(key, {
				key,
				path,
				title: key === '' && !rendered.hasH1 ? 'Overview' : rendered.title,
				hasH1: rendered.hasH1,
				nodes: rendered.nodes,
				toc: rendered.toc,
				original: mirror.originalUrl(path)
			});
			search.push(...searchSections(mirrorRoute(mirror, key), rendered));
			if (rendered.failed) skipped.push(`${path}: the parser could not read it`);
		} catch (error) {
			skipped.push(`${path}: ${error instanceof Error ? error.message : 'could not render'}`);
		}
	}
	const keyOfPath = (path: string) =>
		pages.has(pagePaths.get(path) ?? '\0') ? pagePaths.get(path) : undefined;
	const manifest = extracted.files.get(MIRROR_NAV_FILE);
	let nav: MirrorNavItem[] = [];
	if (manifest) {
		try {
			nav = navFromManifest(JSON.parse(decoder.decode(manifest)), keyOfPath, isHttpsUrl);
		} catch {
			skipped.push(`${MIRROR_NAV_FILE}: not valid JSON`);
		}
	}
	if (nav.length === 0) {
		nav = navFromTree(
			[...pages.values()].map(({ key, title }) => ({ key, title })),
			mirror.folderOrder
		);
	}
	const assets = new Map<string, Uint8Array>();
	for (const path of assetPaths) assets.set(path, extracted.files.get(path)!);
	return {
		meta: { sha, ref: mirror.ref, nav, pages: pages.size, assets: assets.size, skipped },
		pages,
		assets,
		search
	};
}

function isHttpsUrl(url: string): boolean {
	try {
		return new URL(url).protocol === 'https:';
	} catch {
		return false;
	}
}

// #region store
export async function readMeta(deps: MirrorDeps, id: string): Promise<MirrorMeta | null> {
	return ((await deps.kv.get(metaKey(id), 'json')) as MirrorMeta | null) ?? null;
}

async function deletePrefix(kv: KvLike, prefix: string): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix, cursor });
		for (const key of page.keys) await kv.delete(key.name);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
}

async function storeBuilt(deps: MirrorDeps, mirror: DocMirror, built: Built, etag: string | null) {
	const { kv } = deps;
	const { sha } = built.meta;
	const before = await readMeta(deps, mirror.id);
	for (const [key, page] of built.pages) {
		await kv.put(pageKeyOf(mirror.id, sha, key), JSON.stringify(page));
	}
	for (const [path, bytes] of built.assets) {
		await kv.put(assetKeyOf(mirror.id, sha, path), bytes.slice().buffer as ArrayBuffer);
	}
	await kv.put(searchKeyOf(mirror.id, sha), JSON.stringify(built.search));
	const now = deps.now();
	// the pointer moves last, so a failure above leaves the previous copy serving
	await kv.put(
		metaKey(mirror.id),
		JSON.stringify({ ...built.meta, etag, syncedAt: now, checkedAt: now })
	);
	if (before && before.sha !== sha)
		await deletePrefix(kv, `docmirror:${mirror.id}:${before.sha}:`);
}
// #endregion

export type RefreshOutcome =
	| { id: string; status: 'updated'; sha: string; pages: number; assets: number; skipped: number }
	| { id: string; status: 'unchanged'; sha: string }
	| { id: string; status: 'failed'; message: string };

export async function refreshMirror(deps: MirrorDeps, mirror: DocMirror): Promise<RefreshOutcome> {
	try {
		const before = await readMeta(deps, mirror.id);
		const headers: Record<string, string> = { 'user-agent': USER_AGENT };
		if (before?.etag) headers['if-none-match'] = before.etag;
		const response = await deps.fetch(`${CODELOAD_HOST}/${mirror.repo}/tar.gz/${mirror.ref}`, {
			headers,
			redirect: 'manual'
		});
		if (response.status === 304 && before) {
			await deps.kv.put(
				metaKey(mirror.id),
				JSON.stringify({ ...before, checkedAt: deps.now() })
			);
			return { id: mirror.id, status: 'unchanged', sha: before.sha };
		}
		if (!response.ok) throw new MirrorError(`GitHub answered ${response.status}`);
		const gz = await readCapped(response, MIRROR_LIMITS.tarballBytes);
		const tar = await inflateCapped(gz, MIRROR_LIMITS.inflatedBytes);
		const sha = commitOf(tar);
		if (!sha) throw new MirrorError('the archive carries no commit id');
		if (before?.sha === sha) {
			await deps.kv.put(
				metaKey(mirror.id),
				JSON.stringify({
					...before,
					etag: response.headers.get('etag'),
					checkedAt: deps.now()
				})
			);
			return { id: mirror.id, status: 'unchanged', sha };
		}
		const built = buildMirror(mirror, sha, extractDocs(tar, mirror));
		if (built.pages.size === 0) throw new MirrorError('the archive holds no pages');
		await storeBuilt(deps, mirror, built, response.headers.get('etag'));
		await deps.kv.delete(statusKey(mirror.id));
		return {
			id: mirror.id,
			status: 'updated',
			sha,
			pages: built.pages.size,
			assets: built.assets.size,
			skipped: built.meta.skipped.length
		};
	} catch (error) {
		const message =
			error instanceof Error
				? error.message || error.name || 'refresh failed'
				: 'refresh failed';
		await deps.kv
			.put(statusKey(mirror.id), JSON.stringify({ at: deps.now(), message }))
			.catch(() => undefined);
		return { id: mirror.id, status: 'failed', message };
	}
}

// the scheduled entry: runs at most once per interval across overlapping cron ticks
export async function refreshMirrors(
	deps: MirrorDeps,
	mirrors: readonly DocMirror[]
): Promise<RefreshOutcome[] | null> {
	const last = (await deps.kv.get(lastRunKey, 'json')) as number | null;
	const now = deps.now();
	if (!refreshDue(now, typeof last === 'number' ? last : null)) return null;
	await deps.kv.put(lastRunKey, JSON.stringify(now));
	const out: RefreshOutcome[] = [];
	for (const mirror of mirrors) out.push(await refreshMirror(deps, mirror));
	return out;
}

// #region read
function neighbours(nav: MirrorNavItem[], key: string) {
	const flat = flattenMirrorNav(nav);
	const at = flat.findIndex((item) => (item.slug ?? []).join('/') === key);
	return {
		previous: at > 0 ? flat[at - 1]! : null,
		next: at >= 0 && at < flat.length - 1 ? flat[at + 1]! : null
	};
}

// at most two raw fetches, one per candidate path, from a fixed host and the pinned ref
async function fallbackPage(
	deps: MirrorDeps,
	mirror: DocMirror,
	key: string,
	treePath: string | null
): Promise<StoredPage | null> {
	const candidates =
		treePath !== null
			? [treePath]
			: key === ''
				? [MIRROR_HOME_FILE]
				: [`${mirror.dir}/${key}.md`, `${mirror.dir}/${key}/index.md`];
	for (const path of candidates) {
		if (!isSafeRepoPath(path)) continue;
		let response: Response;
		try {
			response = await deps.fetch(`${RAW_HOST}/${mirror.repo}/${mirror.ref}/${path}`, {
				headers: { 'user-agent': USER_AGENT },
				redirect: 'manual'
			});
		} catch {
			return null;
		}
		if (response.status === 404) continue;
		if (!response.ok) return null;
		const bytes = await readCapped(response, MIRROR_LIMITS.pageBytes).catch(() => null);
		if (!bytes) return null;
		const meta = await readMeta(deps, mirror.id);
		const known = new Map<string, string>();
		for (const item of flattenMirrorNav(meta?.nav ?? [])) {
			const itemKey = (item.slug ?? []).join('/');
			known.set(itemKey === '' ? MIRROR_HOME_FILE : `${mirror.dir}/${itemKey}.md`, itemKey);
		}
		known.set(path, key);
		try {
			const rendered = renderMarkdown(new TextDecoder().decode(bytes), {
				mirror,
				path,
				pages: known,
				assets: new Set()
			});
			return {
				key,
				path,
				title: key === '' && !rendered.hasH1 ? 'Overview' : rendered.title,
				hasH1: rendered.hasH1,
				nodes: rendered.nodes,
				toc: rendered.toc,
				original: mirror.originalUrl(path)
			};
		} catch {
			return null;
		}
	}
	return null;
}

// null is a 404: the slug is not a page name, or no page answers to it
export async function readMirrorPage(
	deps: MirrorDeps,
	mirror: DocMirror,
	slug: string | readonly string[] | undefined
): Promise<MirrorPageView | null> {
	const parts = parseMirrorSlug(slug);
	if (parts === null) return null;
	const key = parts.join('/');
	const meta = await readMeta(deps, mirror.id);
	if (meta) {
		const stored = (await deps.kv.get(
			pageKeyOf(mirror.id, meta.sha, key),
			'json'
		)) as StoredPage | null;
		if (stored) {
			return {
				page: stored,
				nav: meta.nav,
				...neighbours(meta.nav, key),
				sha: meta.sha,
				syncedAt: meta.syncedAt,
				original: stored.original,
				home: mirror.home,
				fromFallback: false
			};
		}
	}
	const cached = (await deps.kv.get(rawKeyOf(mirror.id, key), 'json')) as StoredPage | null;
	const page = cached ?? (await fallbackPage(deps, mirror, key, null));
	if (!page) return null;
	if (!cached) {
		await deps.kv
			.put(rawKeyOf(mirror.id, key), JSON.stringify(page), { expirationTtl: FALLBACK_TTL_S })
			.catch(() => undefined);
	}
	return {
		page,
		nav: meta?.nav ?? [],
		...neighbours(meta?.nav ?? [], key),
		sha: meta?.sha ?? '',
		syncedAt: meta?.syncedAt ?? null,
		original: page.original,
		home: mirror.home,
		fromFallback: true
	};
}

export async function readMirrorAsset(
	deps: MirrorDeps,
	mirror: DocMirror,
	path: string
): Promise<{ bytes: ArrayBuffer; type: string; sha: string } | null> {
	const type = mirrorImageType(path);
	if (!type || !isSafeRepoPath(path)) return null;
	const meta = await readMeta(deps, mirror.id);
	if (!meta) return null;
	const bytes = (await deps.kv.get(
		assetKeyOf(mirror.id, meta.sha, path),
		'arrayBuffer'
	)) as ArrayBuffer | null;
	return bytes ? { bytes, type, sha: meta.sha } : null;
}

export async function readMirrorSearch(
	deps: MirrorDeps,
	mirror: DocMirror
): Promise<SearchSection[]> {
	const meta = await readMeta(deps, mirror.id);
	if (!meta) return [];
	return (
		((await deps.kv.get(searchKeyOf(mirror.id, meta.sha), 'json')) as SearchSection[] | null) ??
		[]
	);
}
// #endregion
