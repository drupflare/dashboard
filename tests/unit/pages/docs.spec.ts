import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import docsAdmin from '~/middleware/docs-admin';
import DocsPage from '~/pages/docs/[...slug].vue';
import { useSessionStore } from '~/stores/session';

const fixtures = vi.hoisted(() => new Map<string, Record<string, unknown>>());

mockNuxtImport('queryCollection', () => () => ({
	path: (path: string) => ({
		first: async () => fixtures.get(path) ?? null
	})
}));

mockNuxtImport('queryCollectionItemSurroundings', () => async () => []);

const docsDir = join(process.cwd(), 'docs');

interface Front {
	title: string;
	description: string;
	draft: boolean;
}

function allPages(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return allPages(full);
		return entry.name.endsWith('.md') ? [full] : [];
	});
}

// the content path the collection gives a file: docs/index.md is "/", docs/a/b.md is "/a/b"
function contentPath(file: string): string {
	const rel = relative(docsDir, file).split('\\').join('/').replace(/\.md$/, '');
	return rel === 'index' ? '/' : `/${rel}`;
}

// reference/permissions.md is generated without frontmatter, so it is not a collection page yet
function frontOf(file: string): Front | null {
	const match = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
	return match ? (parse(match[1]!) as Front) : null;
}

function fakeDoc(front: Front): Record<string, unknown> {
	return { ...front, body: { toc: { links: [] } } };
}

const pages = allPages(docsDir).flatMap((file) => {
	const front = frontOf(file);
	return front ? [{ file, route: contentPath(file), front }] : [];
});
const published = pages.filter((page) => !page.front.draft);

beforeEach(() => {
	fixtures.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('docs page', () => {
	it.each(published.map((page) => [page.route, page]))(
		'renders the published page %s with one h1 and its title',
		async (_route, page) => {
			fixtures.set(page.route, fakeDoc(page.front));
			const routePath = page.route === '/' ? '/docs' : `/docs${page.route}`;
			const wrapper = await mountSuspended(DocsPage, {
				route: routePath,
				global: { stubs: { ContentRenderer: { template: '<div data-doc-body />' } } }
			});
			expect(wrapper.findAll('h1')).toHaveLength(1);
			expect(wrapper.find('h1').text()).toBe(page.front.title);
			expect(wrapper.find('[data-doc-body]').exists()).toBe(true);
		}
	);

	it('has no second h1 in the markdown of any published page', () => {
		for (const page of published) {
			const body = readFileSync(page.file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
			expect(body.match(/^# /gm) ?? [], page.file).toHaveLength(0);
		}
	});

	// the test environment is not a dev server, so a draft is hidden here; the notice branch is
	// covered by the browser run, and the visibility rule by isHiddenDoc in shared/docs.spec.ts
	it('hides a draft page outside development', async () => {
		fixtures.set('/guides/example', {
			title: 'Example',
			description: 'A draft page.',
			draft: true,
			body: { toc: { links: [] } }
		});
		const wrapper = await mountSuspended(DocsPage, {
			route: '/docs/guides/example',
			global: { stubs: { ContentRenderer: { template: '<div />' } } }
		});
		expect(wrapper.find('article').exists()).toBe(false);
	});

	// mountSuspended does not surface the setup-time 404 throw; the page renders no article instead
	it('renders no article for a missing slug', async () => {
		const wrapper = await mountSuspended(DocsPage, {
			route: '/docs/guides/does-not-exist',
			global: { stubs: { ContentRenderer: { template: '<div />' } } }
		});
		expect(wrapper.find('article').exists()).toBe(false);
	});
});

describe('docs admin middleware', () => {
	it('leaves public docs alone without reading the session', async () => {
		const session = useSessionStore();
		const ensure = vi.spyOn(session, 'ensure').mockResolvedValue(undefined);
		await expect(
			docsAdmin({ path: '/docs/guides/billing/plans' } as never, {} as never)
		).resolves.toBeUndefined();
		expect(ensure).not.toHaveBeenCalled();
	});

	it('answers a signed-out or non-admin visitor with a 404 on the admin docs', async () => {
		const session = useSessionStore();
		vi.spyOn(session, 'ensure').mockResolvedValue(undefined);
		session.me = null;
		await expect(
			docsAdmin({ path: '/docs/admin/on-call' } as never, {} as never)
		).rejects.toMatchObject({
			statusCode: 404
		});
	});

	it('lets a platform admin through to the admin docs', async () => {
		const session = useSessionStore();
		vi.spyOn(session, 'ensure').mockResolvedValue(undefined);
		session.me = { platformRole: 'admin' } as never;
		await expect(
			docsAdmin({ path: '/docs/admin/on-call' } as never, {} as never)
		).resolves.toBeUndefined();
	});
});
