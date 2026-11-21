import type { EventHandler, H3Event } from 'h3';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { refreshMirror } from '../../../../src/server/services/doc-mirror';
import { mirrorById } from '../../../../src/shared/doc-mirrors';
import { PNG, archive, docsRepo, harness, ok } from '../fixtures/mirror-archive';

interface FakeEvent {
	params: Record<string, string>;
	query: Record<string, unknown>;
	headers: Record<string, string>;
	context: { cloudflare?: { env: { CACHE?: unknown } } };
	out: { headers: Record<string, string>; status?: number };
}

const SHA = 'c'.repeat(40);
type Handler = (event: FakeEvent) => Promise<unknown>;
let page: Handler;
let search: Handler;
let asset: Handler;

// the stubbed h3 helpers read only FakeEvent's fields, so this is the one cast to H3Event
const asHandler =
	(handler: EventHandler): Handler =>
	async (event) =>
		handler(event as unknown as H3Event);

beforeAll(async () => {
	vi.stubGlobal('defineEventHandler', (fn: Handler) => fn);
	vi.stubGlobal('getRouterParam', (e: FakeEvent, name: string) => e.params[name]);
	vi.stubGlobal('getQuery', (e: FakeEvent) => e.query);
	vi.stubGlobal('getRequestHeader', (e: FakeEvent, name: string) => e.headers[name]);
	vi.stubGlobal('setResponseHeader', (e: FakeEvent, name: string, value: string) => {
		e.out.headers[name] = value;
	});
	vi.stubGlobal('setResponseHeaders', (e: FakeEvent, values: Record<string, string>) => {
		Object.assign(e.out.headers, values);
	});
	vi.stubGlobal('setResponseStatus', (e: FakeEvent, status: number) => {
		e.out.status = status;
	});
	vi.stubGlobal('createError', (e: { statusCode: number }) => Object.assign(new Error('h3'), e));
	page = asHandler(
		(await import('../../../../src/server/routes/docs/[mirror]/_page.get')).default
	);
	search = asHandler(
		(await import('../../../../src/server/routes/docs/[mirror]/search.json.get')).default
	);
	asset = asHandler(
		(await import('../../../../src/server/routes/docs/[mirror]/_assets/[...path].get')).default
	);
});

afterEach(() => vi.clearAllMocks());

async function seeded() {
	const gz = await archive(SHA, docsRepo());
	const h = harness(() => ok(gz));
	await refreshMirror(h.deps, mirrorById('worker')!);
	return h.store;
}

const eventOf = (
	params: Record<string, string>,
	store: Map<string, string | ArrayBuffer> | null,
	extra: Partial<FakeEvent> = {}
): FakeEvent => ({
	params,
	query: {},
	headers: {},
	context: store
		? {
				cloudflare: {
					env: {
						CACHE: {
							get: async (key: string, type: string) => {
								const v = store.get(key);
								if (v === undefined) return null;
								return type === 'json' ? JSON.parse(v as string) : v;
							},
							put: async (key: string, value: string | ArrayBuffer) =>
								void store.set(key, value),
							delete: async (key: string) => void store.delete(key),
							list: async () => ({ keys: [], list_complete: true })
						}
					}
				}
			}
		: {},
	out: { headers: {} },
	...extra
});

describe('page route', () => {
	it('returns the stored page with the public cache header', async () => {
		const store = await seeded();
		const e = eventOf({ mirror: 'worker' }, store, {
			query: { slug: 'getting-started/install' }
		});
		const view = (await page(e)) as { page: { title: string }; sha: string };
		expect(view.page.title).toBe('Install');
		expect(view.sha).toBe(SHA);
		expect(e.out.headers['cache-control']).toBe('public, max-age=300');
	});

	it.each([
		['an unknown mirror', { mirror: 'other' }, { slug: 'a' }],
		['dot dot', { mirror: 'worker' }, { slug: '../x' }],
		['an encoded slash', { mirror: 'worker' }, { slug: 'a%2F..%2Fb' }],
		['unicode', { mirror: 'worker' }, { slug: 'café' }],
		['a repeated slug', { mirror: 'worker' }, { slug: ['a', 'b'] }]
	])('answers 404 for %s', async (_name, params, query) => {
		const store = await seeded();
		await expect(page(eventOf(params, store, { query }))).rejects.toMatchObject({
			statusCode: 404
		});
	});

	it('answers 404 when the cache is not bound', async () => {
		await expect(page(eventOf({ mirror: 'worker' }, null))).rejects.toMatchObject({
			statusCode: 404
		});
	});
});

describe('search route', () => {
	it('returns the sections of one mirror', async () => {
		const store = await seeded();
		const sections = (await search(eventOf({ mirror: 'worker' }, store))) as { id: string }[];
		expect(sections.some((s) => s.id === '/docs/worker/getting-started/install#steps')).toBe(
			true
		);
		expect(await search(eventOf({ mirror: 'spool' }, store))).toEqual([]);
	});

	it('answers 404 for an unknown mirror', async () => {
		await expect(search(eventOf({ mirror: 'nope' }, await seeded()))).rejects.toMatchObject({
			statusCode: 404
		});
	});
});

describe('asset route', () => {
	it('serves cached bytes with the safe headers', async () => {
		const store = await seeded();
		const e = eventOf({ mirror: 'worker', path: 'docs/img/x.png' }, store);
		const bytes = (await asset(e)) as Uint8Array;
		expect(bytes).toEqual(PNG);
		expect(e.out.headers).toMatchObject({
			'content-type': 'image/png',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			etag: `"${SHA}"`
		});
	});

	it('answers 304 when the etag matches', async () => {
		const store = await seeded();
		const e = eventOf({ mirror: 'worker', path: 'docs/img/x.png' }, store, {
			headers: { 'if-none-match': `"${SHA}"` }
		});
		expect(await asset(e)).toBeNull();
		expect(e.out.status).toBe(304);
	});

	it.each([
		['an svg', 'docs/logo.svg'],
		['a missing image', 'docs/img/none.png'],
		['a traversal path', '../docs/img/x.png'],
		['an encoded traversal', 'docs/%2e%2e/img/x.png'],
		['a page', 'docs/getting-started/index.md']
	])('answers 404 for %s', async (_name, path) => {
		const store = await seeded();
		await expect(asset(eventOf({ mirror: 'worker', path }, store))).rejects.toMatchObject({
			statusCode: 404
		});
	});

	it('answers 404 for an unknown mirror', async () => {
		await expect(
			asset(eventOf({ mirror: 'other', path: 'docs/img/x.png' }, await seeded()))
		).rejects.toMatchObject({ statusCode: 404 });
	});
});
