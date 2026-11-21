import { describe, expect, it } from 'vitest';
import {
	renderMarkdown,
	searchSections,
	stripFrontmatter,
	type MElement,
	type MNode,
	type RenderContext
} from '../../../../src/server/services/doc-mirror-render';
import { mirrorById, safeHref, safeImageSrc } from '../../../../src/shared/doc-mirrors';
import { HOSTILE } from '../fixtures/mirror-hostile';

const worker = mirrorById('worker')!;

const ctx = (path = 'docs/a/b.md'): RenderContext => ({
	mirror: worker,
	path,
	pages: new Map([
		['docs/a/b.md', 'a/b'],
		['docs/a/c.md', 'a/c'],
		['README.md', '']
	]),
	assets: new Set(['docs/img/x.png'])
});

const TAGS = new Set([
	'p',
	'h',
	'ul',
	'ol',
	'li',
	'bq',
	'pre',
	'code',
	'em',
	'strong',
	'del',
	'a',
	'img',
	'br',
	'hr',
	'table',
	'tr',
	'th',
	'td',
	'sup',
	'task'
]);

function walk(nodes: MNode[], visit: (node: MElement) => void) {
	for (const node of nodes) {
		if (typeof node === 'string') continue;
		visit(node);
		walk(node.c ?? [], visit);
	}
}

function find(nodes: MNode[], t: MElement['t']): MElement[] {
	const out: MElement[] = [];
	walk(nodes, (n) => n.t === t && out.push(n));
	return out;
}

describe('hostile markdown renders inert', () => {
	it('has at least thirty inputs', () => {
		expect(HOSTILE.length).toBeGreaterThanOrEqual(30);
	});

	it.each(HOSTILE)('%s', (_name, source) => {
		const page = renderMarkdown(source, ctx());
		walk(page.nodes, (node) => {
			expect(TAGS.has(node.t)).toBe(true);
			if (node.t === 'a') expect(safeHref(node.href)).toBe(node.href);
			if (node.t === 'img') expect(safeImageSrc(node.src)).toBe(node.src);
			if (
				node.t === 'a' &&
				node.href &&
				!node.href.startsWith('#') &&
				!node.href.startsWith('/docs/')
			) {
				expect(node.ext).toBe(true);
			}
		});
		expect(JSON.stringify(page.nodes)).not.toMatch(/"t":"html"/);
	});

	it('drops the tags and keeps what sat between them as text', () => {
		const page = renderMarkdown('before <script>alert(1)</script> after', ctx());
		expect(page.nodes).toEqual([{ t: 'p', c: ['before ', 'alert(1)', ' after'] }]);
	});

	it('treats mdc component syntax as plain text', () => {
		const page = renderMarkdown('::alert{type="danger"}\nhello\n::', ctx());
		expect(find(page.nodes, 'p')).toHaveLength(1);
		expect(JSON.stringify(page.nodes)).toContain('::alert');
	});

	it('flattens nesting past the depth cap instead of recursing', () => {
		const page = renderMarkdown(`${'>'.repeat(60)} deep`, ctx());
		expect(JSON.stringify(page.nodes)).toContain('deep');
		expect(JSON.stringify(page.nodes).match(/"t":"bq"/g)!.length).toBeLessThanOrEqual(25);
	});

	it('survives five thousand nested quotes within the depth cap', () => {
		const page = renderMarkdown(`${'>'.repeat(5000)} deep`, ctx());
		expect(JSON.stringify(page.nodes).match(/"t":"bq"/g)!.length).toBeLessThanOrEqual(25);
	});

	it('shows a notice when the parser fails', () => {
		const page = renderMarkdown(undefined as unknown as string, ctx());
		expect(page.failed).toBe(true);
		expect(JSON.stringify(page.nodes)).toContain('cannot be shown here');
	});

	it('stops at the node budget', () => {
		const source = Array.from({ length: 30_000 }, (_, i) => `paragraph ${i}`).join('\n\n');
		const page = renderMarkdown(source, ctx());
		expect(page.nodes.length).toBeLessThanOrEqual(20_000);
		expect(page.nodes.length).toBeGreaterThan(1000);
	});
});

describe('frontmatter', () => {
	it('strips a leading block', () => {
		expect(stripFrontmatter('---\ntitle: x\n---\n# A')).toBe('# A');
		expect(stripFrontmatter('---\r\ntitle: x\r\n---\r\n# A')).toBe('# A');
	});

	it('keeps a block that is not at the start', () => {
		expect(stripFrontmatter('# A\n\n---\ntitle: x\n---\n')).toContain('title: x');
	});

	it('renders no frontmatter text', () => {
		const page = renderMarkdown('---\ntitle: secret\n---\n# Visible', ctx());
		expect(JSON.stringify(page.nodes)).not.toContain('secret');
		expect(page.title).toBe('Visible');
	});
});

describe('links and images', () => {
	const hrefs = (source: string, path?: string) =>
		find(renderMarkdown(source, ctx(path)).nodes, 'a').map((a) => [a.href, a.ext]);

	it('turns a relative page link into a mirror route', () => {
		expect(hrefs('[c](c.md)')).toEqual([['/docs/worker/a/c', false]]);
		expect(hrefs('[c](c.md#part-two)')).toEqual([['/docs/worker/a/c#part-two', false]]);
		expect(hrefs('[c](./c.md)')).toEqual([['/docs/worker/a/c', false]]);
	});

	it('maps the repository README to the mirror home', () => {
		expect(hrefs('[home](../../README.md)')).toEqual([['/docs/worker', false]]);
	});

	it('keeps an anchor on the same page', () => {
		expect(hrefs('[up](#quick-start)')).toEqual([['#quick-start', false]]);
	});

	it('sends a file the mirror does not hold to the repository on GitHub', () => {
		expect(hrefs('[src](../../src/index.ts)')).toEqual([
			['https://github.com/drupflare/worker/blob/master/src/index.ts', true]
		]);
	});

	it('keeps an external link external', () => {
		expect(hrefs('[x](https://example.com/a?b=1)')).toEqual([
			['https://example.com/a?b=1', true]
		]);
		expect(hrefs('[m](mailto:a@example.com)')).toEqual([['mailto:a@example.com', true]]);
	});

	it('drops the link and keeps the text for an unsafe scheme', () => {
		const page = renderMarkdown('[click](javascript:alert(1))', ctx());
		expect(find(page.nodes, 'a')).toEqual([]);
		expect(JSON.stringify(page.nodes)).toContain('click');
	});

	it('serves a cached image from the asset route', () => {
		const page = renderMarkdown('![logo](../img/x.png)', ctx());
		expect(find(page.nodes, 'img')).toEqual([
			{ t: 'img', src: '/docs/worker/_assets/docs/img/x.png', alt: 'logo' }
		]);
	});

	it('never embeds an image from another host or an svg', () => {
		const page = renderMarkdown('![a](https://cdn.example/a.png) ![b](../img/logo.svg)', ctx());
		expect(find(page.nodes, 'img')).toEqual([]);
		expect(find(page.nodes, 'a').map((a) => a.ext)).toEqual([true, true]);
	});

	it('never nests an anchor: a badge image inside a link keeps its text only', () => {
		const page = renderMarkdown(
			'[![Build](https://example.test/b.svg)](https://example.test/run) ' +
				'[![][r]](https://example.test/run) [**![Bold](../img/logo.svg)**](c.md)\n\n[r]: https://example.test/x.svg',
			ctx()
		);
		const anchors = find(page.nodes, 'a');
		expect(anchors).toHaveLength(3);
		for (const anchor of anchors) expect(find(anchor.c as MNode[], 'a')).toEqual([]);
		expect(JSON.stringify(anchors[0]!.c)).toContain('Build');
		expect(JSON.stringify(anchors[1]!.c)).toContain('Image');
	});

	it('resolves a reference link through its definition', () => {
		expect(hrefs('[x][r]\n\n[r]: c.md')).toEqual([['/docs/worker/a/c', false]]);
	});

	it('resolves from the page that holds the link', () => {
		expect(hrefs('[b](docs/a/b.md)', 'README.md')).toEqual([['/docs/worker/a/b', false]]);
	});
});

describe('structure', () => {
	it('titles the page from the first h1 and demotes later ones', () => {
		const page = renderMarkdown('# One\n\n# Two\n\n## Three', ctx());
		expect(page.title).toBe('One');
		expect(page.hasH1).toBe(true);
		expect(find(page.nodes, 'h').map((h) => h.level)).toEqual([1, 2, 2]);
	});

	it('titles a page without an h1 from its file name', () => {
		const page = renderMarkdown('just text', ctx('docs/a/b.md'));
		expect(page.hasH1).toBe(false);
		expect(page.title).toBe('b');
	});

	it('builds heading ids and a contents list of h2 and h3', () => {
		const page = renderMarkdown(
			'# T\n\n## Quick Start\n\n### Sub Part\n\n#### Deep\n\n## Quick Start',
			ctx()
		);
		expect(page.toc).toEqual([
			{ id: 'quick-start', text: 'Quick Start', level: 2 },
			{ id: 'sub-part', text: 'Sub Part', level: 3 },
			{ id: 'quick-start-1', text: 'Quick Start', level: 2 }
		]);
	});

	it('renders tables, task lists, code and ordered starts', () => {
		const page = renderMarkdown(
			'| a | b |\n| :-- | --: |\n| 1 | 2 |\n\n- [x] done\n- [ ] open\n\n3. three\n4. four\n\n```ts\nconst x = 1;\n```',
			ctx()
		);
		expect(find(page.nodes, 'th').map((n) => n.align)).toEqual(['left', 'right']);
		expect(find(page.nodes, 'task').map((n) => n.checked)).toEqual([true, false]);
		expect(find(page.nodes, 'ol')[0]!.start).toBe(3);
		expect(find(page.nodes, 'pre')[0]).toMatchObject({ lang: 'ts', c: ['const x = 1;'] });
	});

	it('keeps an unsafe code language out of the class', () => {
		const page = renderMarkdown('```"><script>\nx\n```', ctx());
		expect(find(page.nodes, 'pre')[0]!.lang).toBeUndefined();
	});
});

describe('search sections', () => {
	it('splits a page by heading and carries the trail', () => {
		const page = renderMarkdown('# T\n\nintro\n\n## A\n\nalpha\n\n### B\n\nbeta', ctx());
		const sections = searchSections('/docs/worker/a/b', page);
		expect(sections.map((s) => [s.id, s.titles, s.content])).toEqual([
			['/docs/worker/a/b', [], 'intro'],
			['/docs/worker/a/b#a', ['T'], 'alpha'],
			['/docs/worker/a/b#b', ['T', 'A'], 'beta']
		]);
	});
});
