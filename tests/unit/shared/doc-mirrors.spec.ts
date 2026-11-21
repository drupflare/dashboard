import { describe, expect, it } from 'vitest';
import {
	DOC_MIRRORS,
	flattenMirrorNav,
	isSafeRepoPath,
	mirrorAssetRoute,
	mirrorById,
	mirrorImageType,
	mirrorPageKey,
	mirrorRoute,
	parseMirrorSlug,
	safeHref,
	safeImageSrc
} from '../../../src/shared/doc-mirrors';

describe('mirror config', () => {
	it('has one entry per mirror with a pinned ref', () => {
		expect(DOC_MIRRORS.map((m) => m.id)).toEqual(['worker', 'spool']);
		for (const mirror of DOC_MIRRORS) {
			expect(mirror.ref).not.toBe('');
			expect(mirror.routePrefix).toBe(`/docs/${mirror.id}`);
			expect(mirror.home).toMatch(/^https:\/\//);
		}
		expect(mirrorById('worker')?.repo).toBe('drupflare/worker');
		expect(mirrorById('other')).toBeNull();
	});

	it('names the original page of a repo path', () => {
		const worker = mirrorById('worker')!;
		const spool = mirrorById('spool')!;
		expect(worker.originalUrl('README.md')).toBe('https://docs.drupflare.com/');
		expect(worker.originalUrl('docs/operating/index.md')).toBe(
			'https://docs.drupflare.com/operating/index.html'
		);
		expect(spool.originalUrl('README.md')).toBe('https://spool.drupflare.com/');
		expect(spool.originalUrl('docs/adapters/node.md')).toBe(
			'https://spool.drupflare.com/documents/docs_adapters_node.html'
		);
	});
});

describe('page keys and routes', () => {
	it.each([
		['README.md', ''],
		['docs/a.md', 'a'],
		['docs/a/b.md', 'a/b'],
		['docs/a/index.md', 'a'],
		['docs/adapters/README.md', 'adapters'],
		['docs/economics.src.md', 'economics.src']
	])('maps %s to %j', (path, key) => {
		expect(mirrorPageKey(path)).toBe(key);
	});

	it.each([
		['docs/README.md'],
		['src/a.md'],
		['docs/a.txt'],
		['docs/../a.md'],
		['/docs/a.md'],
		['docs/a b.md'],
		['docs//a.md']
	])('does not map %s', (path) => {
		expect(mirrorPageKey(path)).toBeNull();
	});

	it('builds the routes', () => {
		const worker = mirrorById('worker')!;
		expect(mirrorRoute(worker, '')).toBe('/docs/worker');
		expect(mirrorRoute(worker, 'a/b')).toBe('/docs/worker/a/b');
		expect(mirrorAssetRoute(worker, 'docs/x.png')).toBe('/docs/worker/_assets/docs/x.png');
	});

	it('types images by extension and refuses svg', () => {
		expect(mirrorImageType('docs/x.PNG')).toBe('image/png');
		expect(mirrorImageType('docs/x.svg')).toBeNull();
		expect(mirrorImageType('docs/x')).toBeNull();
	});

	it('checks repo path characters', () => {
		expect(isSafeRepoPath('docs/a-b_c.d/e.md')).toBe(true);
		expect(isSafeRepoPath('docs/a%2Fb.md')).toBe(false);
		expect(isSafeRepoPath('docs/./a.md')).toBe(false);
	});
});

describe('slug parsing', () => {
	it('accepts page names', () => {
		expect(parseMirrorSlug(undefined)).toEqual([]);
		expect(parseMirrorSlug('')).toEqual([]);
		expect(parseMirrorSlug([])).toEqual([]);
		expect(parseMirrorSlug('a/b-c/d_e')).toEqual(['a', 'b-c', 'd_e']);
		expect(parseMirrorSlug(['economics.src'])).toEqual(['economics.src']);
	});

	it.each([
		['..'],
		['a/../b'],
		['a//b'],
		['%2e%2e'],
		['café'],
		['a b'],
		['a\\b'],
		['.a'],
		['a.']
	])('rejects %j', (slug) => {
		expect(parseMirrorSlug(slug)).toBeNull();
	});
});

describe('href safety', () => {
	it.each([
		['#anchor', '#anchor'],
		['/docs/worker/a#b', '/docs/worker/a#b'],
		['https://example.com/a', 'https://example.com/a'],
		['mailto:a@example.com', 'mailto:a@example.com']
	])('allows %s', (href, out) => {
		expect(safeHref(href)).toBe(out);
	});

	it.each([
		['javascript:alert(1)'],
		['JaVaScRiPt:alert(1)'],
		['data:text/html,x'],
		['vbscript:x'],
		['//evil.example'],
		['/docs//evil.example'],
		['/other/path'],
		['ftp://example.com'],
		['file:///etc/passwd'],
		['https://a.example/ "x"'],
		['https://a.example/\u0000'],
		[''],
		[undefined],
		[5]
	])('refuses %j', (href) => {
		expect(safeHref(href)).toBeNull();
	});

	it('allows only the asset route for images', () => {
		expect(safeImageSrc('/docs/worker/_assets/docs/x.png')).toBe(
			'/docs/worker/_assets/docs/x.png'
		);
		expect(safeImageSrc('https://example.com/x.png')).toBeNull();
		expect(safeImageSrc('data:image/png;base64,AA')).toBeNull();
		expect(safeImageSrc('/docs/worker/_assets/../x.png')).toBeNull();
	});
});

describe('flattenMirrorNav', () => {
	it('lists the linkable items in reading order', () => {
		const flat = flattenMirrorNav([
			{ title: 'A', slug: ['a'], children: [{ title: 'B', slug: ['a', 'b'] }] },
			{
				title: 'Group',
				children: [
					{ title: 'C', slug: ['c'] },
					{ title: 'Ext', url: 'https://x.example' }
				]
			}
		]);
		expect(flat.map((i) => i.title)).toEqual(['A', 'B', 'C']);
	});
});
