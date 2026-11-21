import { describe, expect, it } from 'vitest';
import { anchorOf, checkDocsLinks, checkMirrorLinks } from '../../../scripts/check-docs-links';
import { DOC_MIRRORS } from '../../../src/shared/doc-mirrors';

const docs = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe('docs link checker', () => {
	it('passes a /docs link to an existing page', () => {
		const problems = checkDocsLinks(
			docs({
				'index.md': 'See [plans](/docs/guides/billing/plans).',
				'guides/billing/plans.md': '# Plans'
			})
		);
		expect(problems).toEqual([]);
	});

	it('reports a /docs link to a page that does not exist', () => {
		const problems = checkDocsLinks(docs({ 'index.md': 'See [gone](/docs/guides/gone).' }));
		expect(problems).toEqual([
			{ file: 'index.md', line: 1, target: '/docs/guides/gone', reason: 'missing file' }
		]);
	});

	it('resolves the docs root to index.md', () => {
		expect(
			checkDocsLinks(docs({ 'guides/a.md': '[home](/docs)', 'index.md': '# Home' }))
		).toEqual([]);
	});

	it('reports a missing anchor and accepts a present one', () => {
		const files = docs({
			'a.md': '[ok](/docs/b#refund-window) [bad](/docs/b#nope)',
			'b.md': '## Refund Window\n\ntext'
		});
		expect(checkDocsLinks(files)).toEqual([
			{ file: 'a.md', line: 1, target: '/docs/b#nope', reason: 'missing anchor' }
		]);
	});

	it('checks an in-page anchor against the same file', () => {
		const problems = checkDocsLinks(docs({ 'a.md': '# Top\n\n[up](#top) [down](#missing)' }));
		expect(problems.map((p) => p.target)).toEqual(['#missing']);
	});

	it('resolves a relative link against the linking file', () => {
		const files = docs({
			'guides/billing/plans.md': '[usage](usage-and-limits.md) [gone](nope.md)',
			'guides/billing/usage-and-limits.md': '# Usage'
		});
		expect(checkDocsLinks(files)).toEqual([
			{
				file: 'guides/billing/plans.md',
				line: 1,
				target: 'nope.md',
				reason: 'missing file'
			}
		]);
	});

	it('reports a relative link that climbs out of docs', () => {
		const problems = checkDocsLinks(docs({ 'a.md': '[x](../../etc/passwd)' }));
		expect(problems).toHaveLength(1);
		expect(problems[0]!.reason).toBe('missing file');
	});

	it('checks an image link against the assets present in docs', () => {
		const files = docs({
			'a.md': '![shot](/docs/img/budget.png) ![gone](/docs/img/gone.png)',
			'img/budget.png': ''
		});
		expect(checkDocsLinks(files).map((p) => p.target)).toEqual(['/docs/img/gone.png']);
	});

	it('ignores external links, mail links and links outside /docs', () => {
		const problems = checkDocsLinks(
			docs({
				'a.md': '[site](https://example.com/x) [mail](mailto:support@drupflare.com) [app](/login)'
			})
		);
		expect(problems).toEqual([]);
	});

	it('ignores links inside fenced code blocks', () => {
		const problems = checkDocsLinks(docs({ 'a.md': '```md\n[gone](/docs/nope)\n```\n' }));
		expect(problems).toEqual([]);
	});

	it('slugs headings the way the anchors are written', () => {
		expect(anchorOf('Usage & limits (2026)')).toBe('usage--limits-2026');
		expect(anchorOf('`Hard` limits')).toBe('hard-limits');
	});
});

describe('mirrored sites', () => {
	it('does not look for the mirror pages in this repo', () => {
		const text = DOC_MIRRORS.map((m) => `[${m.id}](${m.routePrefix}/a/b#c)`).join(' ');
		expect(checkDocsLinks(docs({ 'index.md': text }))).toEqual([]);
	});

	const mirror = { id: 'worker', routePrefix: '/docs/worker' };
	const a = (href: string) => ({ t: 'a', href, c: ['x'] });
	const page = (...nodes: unknown[]) => ({ nodes });

	it('passes links and images that resolve inside the mirror', () => {
		const pages = new Map([
			[
				'',
				page(
					{ t: 'h', level: 2, id: 'top', c: ['Top'] },
					a('/docs/worker/a'),
					a('/docs/worker/a#top'),
					a('#top'),
					a('https://x.example')
				)
			],
			[
				'a',
				page(
					{ t: 'h', level: 2, id: 'top', c: ['Top'] },
					{ t: 'img', src: '/docs/worker/_assets/docs/x.png' }
				)
			]
		]);
		expect(checkMirrorLinks(mirror, pages, new Set(['docs/x.png']))).toEqual([]);
	});

	it('reports a missing page, anchor and image', () => {
		const pages = new Map([
			[
				'a',
				page(
					a('/docs/worker/gone'),
					a('/docs/worker/a#nope'),
					{ t: 'img', src: '/docs/worker/_assets/docs/none.png' },
					a('/docs/worker/_assets/docs/none.png')
				)
			]
		]);
		expect(checkMirrorLinks(mirror, pages, new Set()).map((p) => [p.reason, p.target])).toEqual(
			[
				['missing page', '/docs/worker/gone'],
				['missing anchor', '/docs/worker/a#nope'],
				['missing image', '/docs/worker/_assets/docs/none.png'],
				['missing image', '/docs/worker/_assets/docs/none.png']
			]
		);
	});
});
