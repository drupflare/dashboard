import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime';
import { createError, getQuery } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpoolMirrorPage from '~/pages/docs/spool/[...slug].vue';
import WorkerMirrorPage from '~/pages/docs/worker/[...slug].vue';

const seen = vi.hoisted(() => ({
	slugs: [] as unknown[],
	reply: null as unknown,
	requestFetches: 0
}));

mockNuxtImport('useRequestFetch', () => () => {
	seen.requestFetches += 1;
	return globalThis.$fetch;
});

function view(overrides: Record<string, unknown> = {}) {
	return {
		page: {
			key: 'a/b',
			path: 'docs/a/b.md',
			title: 'Install',
			hasH1: true,
			nodes: [
				{ t: 'h', level: 1, id: 'install', c: ['Install'] },
				{ t: 'p', c: ['Body text.'] }
			],
			toc: [{ id: 'steps', text: 'Steps', level: 2 }],
			original: 'https://docs.drupflare.com/a/b.html'
		},
		nav: [
			{ title: 'Overview', slug: [] },
			{ title: 'A', slug: ['a'], children: [{ title: 'Install', slug: ['a', 'b'] }] }
		],
		previous: { title: 'A', slug: ['a'] },
		next: { title: 'Other', slug: ['other'] },
		sha: '0123456789abcdef0123456789abcdef01234567',
		syncedAt: Date.UTC(2026, 10, 21, 3, 30),
		original: 'https://docs.drupflare.com/a/b.html',
		home: 'https://docs.drupflare.com',
		fromFallback: false,
		...overrides
	};
}

beforeEach(() => {
	seen.slugs = [];
	seen.requestFetches = 0;
	seen.reply = view();
	for (const id of ['worker', 'spool']) {
		registerEndpoint(`/docs/${id}/_page`, (event) => {
			seen.slugs.push(getQuery(event).slug);
			if (seen.reply === null) {
				throw createError({ statusCode: 404, statusMessage: 'Page Not Found' });
			}
			return seen.reply;
		});
	}
});

describe('worker mirror page', () => {
	it('reads the page through the request-scoped fetch, so SSR reaches the server route with the bindings', async () => {
		await mountSuspended(WorkerMirrorPage, { route: '/docs/worker/fetch/check' });
		expect(seen.requestFetches).toBeGreaterThan(0);
	});

	it('shows the mirror banner with the home page, sync time, short commit and the original', async () => {
		const wrapper = await mountSuspended(WorkerMirrorPage, { route: '/docs/worker/a/b' });
		const banner = wrapper.find('[role="note"]');
		expect(banner.text()).toBe(
			'This is a mirror of https://docs.drupflare.com. Last synced 2026-11-21 03:30 UTC from 0123456. Open the original'
		);
		expect(banner.find('a[href="https://docs.drupflare.com"]').attributes('rel')).toBe(
			'noopener noreferrer'
		);
		const original = banner.find('a[href="https://docs.drupflare.com/a/b.html"]');
		expect(original.text()).toBe('Open the original');
		expect(original.attributes('rel')).toBe('noopener noreferrer');
		expect(seen.slugs).toEqual(['a/b']);
	});

	it('renders one h1, the body, the contents list and the neighbours', async () => {
		const wrapper = await mountSuspended(WorkerMirrorPage, { route: '/docs/worker/a/b' });
		expect(wrapper.findAll('h1')).toHaveLength(1);
		expect(wrapper.find('h1').text()).toBe('Install');
		expect(wrapper.text()).toContain('Body text.');
		expect(wrapper.find('a[href="#steps"]').text()).toBe('Steps');
		expect(wrapper.find('a[rel="prev"]').attributes('href')).toBe('/docs/worker/a');
		expect(wrapper.find('a[rel="next"]').attributes('href')).toBe('/docs/worker/other');
		expect(
			wrapper.find('nav[aria-label="Worker Documentation"] a[aria-current="page"]').text()
		).toBe('Install');
	});

	it('adds an h1 when the page body has none', async () => {
		seen.reply = view({
			page: { ...view().page, hasH1: false, nodes: [{ t: 'p', c: ['Only text.'] }] }
		});
		const wrapper = await mountSuspended(WorkerMirrorPage, {
			route: '/docs/worker/no/heading'
		});
		expect(wrapper.findAll('h1')).toHaveLength(1);
		expect(wrapper.find('h1').text()).toBe('Install');
	});

	it('points the canonical link at the original page', async () => {
		await mountSuspended(WorkerMirrorPage, { route: '/docs/worker/a/b' });
		await vi.waitFor(() => {
			expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
				'https://docs.drupflare.com/a/b.html'
			);
		});
	});

	it('says so when the page came straight from GitHub', async () => {
		seen.reply = view({ syncedAt: null, sha: '', fromFallback: true });
		const wrapper = await mountSuspended(WorkerMirrorPage, {
			route: '/docs/worker/fresh/page'
		});
		expect(wrapper.find('[role="note"]').text()).toContain(
			'This page was read from GitHub before the first sync.'
		);
	});

	it('renders the mirror home for the bare route', async () => {
		await mountSuspended(WorkerMirrorPage, { route: '/docs/worker' });
		expect(seen.slugs).toEqual(['']);
	});

	// mountSuspended does not surface the setup-time 404 throw; the page renders no article instead
	it('renders no article for an unknown page', async () => {
		seen.reply = null;
		const wrapper = await mountSuspended(WorkerMirrorPage, { route: '/docs/worker/nope' });
		expect(wrapper.find('article').exists()).toBe(false);
	});
});

describe('spool mirror page', () => {
	it('reads from the spool route', async () => {
		seen.reply = view({
			home: 'https://spool.drupflare.com',
			original: 'https://spool.drupflare.com/documents/docs_a_b.html'
		});
		const wrapper = await mountSuspended(SpoolMirrorPage, { route: '/docs/spool/a/b' });
		expect(wrapper.find('[role="note"]').text()).toContain('https://spool.drupflare.com');
		expect(wrapper.find('nav[aria-label="Spool Documentation"]').exists()).toBe(true);
		expect(wrapper.find('a[rel="next"]').attributes('href')).toBe('/docs/spool/other');
	});
});
