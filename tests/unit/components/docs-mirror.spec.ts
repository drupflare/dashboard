import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import DocsMirrorBlock from '~/components/docs/mirror/Block.vue';
import DocsMirrorNav from '~/components/docs/mirror/Nav.vue';
import { renderMarkdown } from '../../../src/server/services/doc-mirror-render';
import { mirrorById } from '../../../src/shared/doc-mirrors';
import { HOSTILE } from '../server/fixtures/mirror-hostile';

const worker = mirrorById('worker')!;

const render = (source: string) =>
	renderMarkdown(source, {
		mirror: worker,
		path: 'docs/a/b.md',
		pages: new Map([
			['docs/a/b.md', 'a/b'],
			['docs/a/c.md', 'a/c']
		]),
		assets: new Set(['docs/img/x.png'])
	});

async function mountNodes(nodes: unknown[]) {
	const Host = defineComponent({
		render: () => h('div', { id: 'root' }, [h(DocsMirrorBlock, { nodes: nodes as never })])
	});
	const wrapper = await mountSuspended(Host);
	return wrapper.element as HTMLElement;
}

describe('mirrored page body', () => {
	it.each(HOSTILE)('%s produces no active element or attribute', async (_name, source) => {
		const root = await mountNodes(render(source).nodes);
		expect(
			root.querySelectorAll('script,iframe,style,object,embed,svg,form,meta,base,link')
		).toHaveLength(0);
		for (const el of root.querySelectorAll('*')) {
			for (const attr of el.getAttributeNames()) {
				expect(attr.startsWith('on')).toBe(false);
				if (attr === 'style') {
					expect(['TD', 'TH']).toContain(el.tagName);
					expect(el.getAttribute('style')).toMatch(/^text-align: (left|center|right);?$/);
				}
			}
		}
		for (const a of root.querySelectorAll('a')) {
			const href = a.getAttribute('href') ?? '';
			expect(href).toMatch(/^(#|\/docs\/|https?:|mailto:)/);
			expect(a.hasAttribute('target')).toBe(false);
			if (/^(https?:|mailto:)/.test(href))
				expect(a.getAttribute('rel')).toBe('noopener noreferrer');
		}
		for (const img of root.querySelectorAll('img')) {
			expect(img.getAttribute('src')).toMatch(/^\/docs\/worker\/_assets\//);
		}
	});

	it('renders the structure a page needs', async () => {
		const root = await mountNodes(
			render(
				'# Title\n\n## Part\n\ntext with `code` and [link](c.md) and [out](https://example.com).\n\n![logo](../img/x.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n```ts\nconst x = 1;\n```'
			).nodes
		);
		expect(root.querySelector('h1')?.textContent).toBe('Title');
		expect(root.querySelector('h2')?.id).toBe('part');
		expect(root.querySelector('a[href="/docs/worker/a/c"]')).not.toBeNull();
		expect(root.querySelector('a[href="https://example.com/"]')?.getAttribute('rel')).toBe(
			'noopener noreferrer'
		);
		expect(root.querySelector('img')?.getAttribute('src')).toBe(
			'/docs/worker/_assets/docs/img/x.png'
		);
		expect(root.querySelectorAll('table tr')).toHaveLength(2);
		expect(root.querySelector('input[type=checkbox]')?.hasAttribute('disabled')).toBe(true);
		expect(root.querySelector('pre code.language-ts')?.textContent).toBe('const x = 1;');
	});

	it('shows hostile markup as text', async () => {
		const root = await mountNodes(render('before <script>alert(1)</script>').nodes);
		expect(root.querySelector('script')).toBeNull();
		expect(root.textContent).toContain('alert(1)');
	});

	it('refuses a tampered node that carries an unsafe href, src or id', async () => {
		const root = await mountNodes([
			{ t: 'a', href: 'javascript:alert(1)', c: ['bad'] },
			{ t: 'img', src: 'https://evil.example/x.png', alt: 'alt' },
			{ t: 'h', level: 2, id: '"><script>', c: ['H'] },
			{ t: 'script', c: ['x'] }
		]);
		expect(root.querySelector('a')).toBeNull();
		expect(root.querySelector('img')).toBeNull();
		expect(root.querySelector('h2')?.hasAttribute('id')).toBe(false);
		expect(root.querySelector('script')).toBeNull();
		expect(root.textContent).toContain('bad');
	});
});

describe('mirror navigation', () => {
	it('links pages, marks the current one and lists nested items', async () => {
		const wrapper = await mountSuspended(DocsMirrorNav, {
			props: {
				mirror: worker,
				current: '/docs/worker/a',
				items: [
					{ title: 'Overview', slug: [] },
					{
						title: 'A',
						slug: ['a'],
						children: [{ title: 'B', slug: ['a', 'b'] }]
					},
					{ title: 'Group', children: [{ title: 'Ext', url: 'https://example.com/x' }] },
					{ title: 'Bad', children: [{ title: 'Evil', url: 'javascript:alert(1)' }] }
				]
			}
		});
		const hrefs = wrapper.findAll('a').map((a) => a.attributes('href'));
		expect(hrefs).toEqual([
			'/docs/worker',
			'/docs/worker/a',
			'/docs/worker/a/b',
			'https://example.com/x'
		]);
		expect(wrapper.find('a[aria-current="page"]').text()).toBe('A');
		expect(wrapper.find('a[href="https://example.com/x"]').attributes('rel')).toBe(
			'noopener noreferrer'
		);
		expect(wrapper.text()).toContain('Evil');
	});
});
