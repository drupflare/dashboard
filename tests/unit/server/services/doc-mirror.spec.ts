import { describe, expect, it } from 'vitest';
import {
	MirrorError,
	buildMirror,
	commitOf,
	extractDocs,
	inflateCapped,
	navFromTree,
	readMeta,
	readMirrorAsset,
	readMirrorPage,
	readMirrorSearch,
	refreshDue,
	refreshMirror,
	refreshMirrors
} from '../../../../src/server/services/doc-mirror';
import { MIRROR_LIMITS, MIRROR_REFRESH_MS, mirrorById } from '../../../../src/shared/doc-mirrors';
import { PNG, archive, docsRepo, gzip, harness, ok, tar } from '../fixtures/mirror-archive';

const worker = mirrorById('worker')!;
const spool = mirrorById('spool')!;
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const enc = new TextEncoder();

describe('refresh gate', () => {
	it('is due with no earlier attempt and after the interval', () => {
		expect(refreshDue(10, null)).toBe(true);
		expect(refreshDue(MIRROR_REFRESH_MS - 31_000, 0)).toBe(false);
		expect(refreshDue(MIRROR_REFRESH_MS - 29_000, 0)).toBe(true);
	});

	it('fires once per thirty minutes across minute ticks', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness(() => ok(gz));
		let runs = 0;
		for (let minute = 0; minute <= 65; minute++) {
			h.now = 1_000_000 + minute * 60_000;
			if (await refreshMirrors(h.deps, [worker])) runs++;
		}
		expect(runs).toBe(3);
	});

	it('runs every mirror in one pass', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness(() => ok(gz));
		const out = await refreshMirrors(h.deps, [worker, spool]);
		expect(out?.map((o) => o.id)).toEqual(['worker', 'spool']);
		expect(h.calls.map((c) => c.url)).toEqual([
			'https://codeload.github.com/drupflare/worker/tar.gz/master',
			'https://codeload.github.com/drupflare/spool/tar.gz/master'
		]);
	});
});

describe('extraction', () => {
	it('keeps the docs, the home file and images, and nothing else', async () => {
		const gz = await archive(SHA1, [
			...docsRepo(),
			{ name: 'worker-master/docs/link.md', type: '2' },
			{ name: 'worker-master/docs/odd name.md', body: '# odd' }
		]);
		const bytes = await inflateCapped(gz, MIRROR_LIMITS.inflatedBytes);
		const { files, skipped } = extractDocs(bytes, worker);
		expect([...files.keys()].sort()).toEqual([
			'README.md',
			'docs/getting-started/index.md',
			'docs/getting-started/install.md',
			'docs/img/x.png',
			'docs/operating/index.md'
		]);
		expect(skipped).toEqual(['docs/odd name.md: unusual characters in the name']);
	});

	it('refuses a whole archive that holds a traversal path', () => {
		const bytes = tar(SHA1, [
			{ name: 'worker-master/docs/a.md', body: '# a' },
			{ name: '../x', body: 'x' }
		]);
		expect(() => extractDocs(bytes, worker)).toThrow(MirrorError);
		expect(() => extractDocs(tar(SHA1, [{ name: '/etc/passwd', body: 'x' }]), worker)).toThrow(
			/absolute/
		);
	});

	it('skips a page and an image over their size caps', () => {
		const bytes = tar(SHA1, [
			{ name: 't/docs/big.md', body: new Uint8Array(MIRROR_LIMITS.pageBytes + 1).fill(97) },
			{ name: 't/docs/big.png', body: new Uint8Array(MIRROR_LIMITS.imageBytes + 1) },
			{ name: 't/docs/ok.md', body: '# ok' }
		]);
		const { files, skipped } = extractDocs(bytes, worker);
		expect([...files.keys()]).toEqual(['docs/ok.md']);
		expect(skipped).toEqual([
			'docs/big.md: over the page size cap',
			'docs/big.png: over the image size cap'
		]);
	});

	it('skips pages and images past their count caps', () => {
		const pages = Array.from({ length: MIRROR_LIMITS.pages + 1 }, (_, i) => ({
			name: `t/docs/p${String(i).padStart(4, '0')}.md`,
			body: '# p'
		}));
		const images = Array.from({ length: MIRROR_LIMITS.images + 1 }, (_, i) => ({
			name: `t/docs/i${String(i).padStart(4, '0')}.png`,
			body: PNG
		}));
		const { files, skipped } = extractDocs(tar(SHA1, [...pages, ...images]), worker);
		expect(files.size).toBe(MIRROR_LIMITS.pages + MIRROR_LIMITS.images);
		expect(skipped.map((s) => s.split(': ')[1]).sort()).toEqual([
			'over the image count cap',
			'over the page count cap'
		]);
	});

	it('refuses an archive with too many entries', () => {
		const members = Array.from({ length: MIRROR_LIMITS.entries + 1 }, (_, i) => ({
			name: `t/f${i}`
		}));
		expect(() => extractDocs(tar(SHA1, members), worker)).toThrow(/entries/);
	});

	it('stops inflating at the cap', async () => {
		const gz = await gzip(new Uint8Array(3 * 1024 * 1024));
		await expect(inflateCapped(gz, 1024 * 1024)).rejects.toThrow(MirrorError);
		expect((await inflateCapped(gz, 4 * 1024 * 1024)).length).toBe(3 * 1024 * 1024);
	});

	it('reads the commit from the pax header', () => {
		expect(commitOf(tar(SHA1, []))).toBe(SHA1);
		expect(commitOf(tar(null, [{ name: 'a' }]))).toBeNull();
	});
});

describe('navigation', () => {
	const titles = [
		{ key: '', title: 'Overview' },
		{ key: 'impact', title: 'Impact' },
		{ key: 'impact/water', title: 'Water' },
		{ key: 'getting-started', title: 'Getting Started' },
		{ key: 'getting-started/install', title: 'Install' },
		{ key: 'zeta/page', title: 'Zeta Page' }
	];

	it('derives a tree with the home page first and the configured folder order', () => {
		const nav = navFromTree(titles, ['getting-started', 'impact']);
		expect(nav.map((n) => n.title)).toEqual(['Overview', 'Getting Started', 'Impact', 'Zeta']);
		expect(nav[1]).toEqual({
			title: 'Getting Started',
			slug: ['getting-started'],
			children: [{ title: 'Install', slug: ['getting-started', 'install'] }]
		});
		expect(nav[3]).toEqual({
			title: 'Zeta',
			children: [{ title: 'Zeta Page', slug: ['zeta', 'page'] }]
		});
	});

	it('uses nav.json when the repo has one', () => {
		const manifest = {
			groups: [
				{
					title: 'Start',
					pages: [
						{ title: 'Overview', path: 'README.md' },
						{ title: 'Getting Started', path: 'docs/getting-started.md#install' },
						{
							title: 'Examples',
							url: 'https://github.com/drupflare/spool/tree/master/examples'
						},
						{ title: 'Api', path: 'api' },
						{ title: 'Bad', url: 'javascript:alert(1)' },
						{ title: 'Plain Http', url: 'http://example.com' }
					],
					sections: [
						{
							title: 'Runtimes',
							pages: [{ title: 'Node', path: 'docs/adapters/node.md' }]
						}
					]
				},
				{ title: 'Empty', pages: [{ title: 'Gone', path: 'docs/gone.md' }] }
			]
		};
		const built = buildMirror(
			spool,
			SHA1,
			extractDocs(
				tar(SHA1, [
					{ name: 't/README.md', body: '# Spool' },
					{ name: 't/docs/getting-started.md', body: '# Getting Started' },
					{ name: 't/docs/adapters/node.md', body: '# Node' },
					{ name: 't/docs/nav.json', body: JSON.stringify(manifest) }
				]),
				spool
			)
		);
		expect(built.meta.nav).toEqual([
			{
				title: 'Start',
				children: [
					{ title: 'Overview', slug: [] },
					{ title: 'Getting Started', slug: ['getting-started'] },
					{
						title: 'Examples',
						url: 'https://github.com/drupflare/spool/tree/master/examples'
					},
					{ title: 'Runtimes', children: [{ title: 'Node', slug: ['adapters', 'node'] }] }
				]
			}
		]);
	});

	it('falls back to the tree when nav.json is not JSON', () => {
		const built = buildMirror(
			spool,
			SHA1,
			extractDocs(
				tar(SHA1, [
					{ name: 't/docs/a.md', body: '# A' },
					{ name: 't/docs/nav.json', body: '{nope' }
				]),
				spool
			)
		);
		expect(built.meta.nav).toEqual([{ title: 'A', slug: ['a'] }]);
		expect(built.meta.skipped).toEqual(['docs/nav.json: not valid JSON']);
	});
});

describe('refresh and read', () => {
	it('stores pages, images and a search index, and reads them back', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness(() => ok(gz));
		const out = await refreshMirror(h.deps, worker);
		expect(out).toMatchObject({ status: 'updated', sha: SHA1, pages: 4, assets: 1 });

		const view = await readMirrorPage(h.deps, worker, ['getting-started', 'install']);
		expect(view).toMatchObject({
			sha: SHA1,
			fromFallback: false,
			original: 'https://docs.drupflare.com/getting-started/install.html',
			home: 'https://docs.drupflare.com'
		});
		expect(view?.page.title).toBe('Install');
		expect(view?.previous?.slug).toEqual(['getting-started']);
		expect(view?.next?.slug).toEqual(['operating']);

		const home = await readMirrorPage(h.deps, worker, []);
		expect(home?.page.title).toBe('Home');
		expect(home?.original).toBe('https://docs.drupflare.com/');
		const index = await readMirrorPage(h.deps, worker, 'getting-started');
		expect(JSON.stringify(index?.page.nodes)).toContain('/docs/worker/_assets/docs/img/x.png');
		expect(JSON.stringify(index?.page.nodes)).toContain('/docs/worker/getting-started/install');

		const sections = await readMirrorSearch(h.deps, worker);
		expect(sections.map((s) => s.id)).toContain('/docs/worker/getting-started/install#steps');
		const asset = await readMirrorAsset(h.deps, worker, 'docs/img/x.png');
		expect(asset?.type).toBe('image/png');
		expect(new Uint8Array(asset!.bytes)).toEqual(PNG);
		expect(h.calls[0]!.init?.redirect).toBe('manual');
	});

	it('sends the stored etag and treats a 304 as unchanged', async () => {
		const gz = await archive(SHA1, docsRepo());
		let status = 200;
		const h = harness((_url, init) => {
			if (status === 304) {
				expect((init!.headers as Record<string, string>)['if-none-match']).toBe('"e1"');
				return new Response(null, { status: 304 });
			}
			return ok(gz);
		});
		await refreshMirror(h.deps, worker);
		const first = await readMeta(h.deps, 'worker');
		status = 304;
		h.advance(MIRROR_REFRESH_MS);
		expect(await refreshMirror(h.deps, worker)).toEqual({
			id: 'worker',
			status: 'unchanged',
			sha: SHA1
		});
		const second = await readMeta(h.deps, 'worker');
		expect(second?.syncedAt).toBe(first?.syncedAt);
		expect(second?.checkedAt).toBe(first!.checkedAt + MIRROR_REFRESH_MS);
	});

	it('writes nothing new when the commit is the same', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness(() => ok(gz, '"e2"'));
		await refreshMirror(h.deps, worker);
		const keys = [...h.store.keys()].sort();
		expect(await refreshMirror(h.deps, worker)).toMatchObject({ status: 'unchanged' });
		expect([...h.store.keys()].sort()).toEqual(keys);
	});

	it('replaces the copy on a new commit and deletes the old keys', async () => {
		let sha = SHA1;
		let gz = await archive(sha, docsRepo());
		const h = harness(() => ok(gz));
		await refreshMirror(h.deps, worker);
		sha = SHA2;
		gz = await archive(
			sha,
			docsRepo().filter((m) => !m.name.includes('operating'))
		);
		expect(await refreshMirror(h.deps, worker)).toMatchObject({
			status: 'updated',
			sha: SHA2,
			pages: 3
		});
		expect([...h.store.keys()].some((k) => k.includes(SHA1))).toBe(false);
		expect(await readMirrorPage(h.deps, worker, ['getting-started'])).toMatchObject({
			sha: SHA2
		});
	});

	describe('a failed refresh keeps the last good copy', () => {
		const cases: [string, (good: Uint8Array) => Promise<Response> | Response, RegExp][] = [
			['GitHub answers 500', () => new Response('no', { status: 500 }), /500/],
			[
				'GitHub answers a redirect',
				() =>
					new Response(null, {
						status: 302,
						headers: { location: 'https://example.test/x' }
					}),
				/302/
			],
			[
				'the download is over the cap',
				() =>
					new Response(new Uint8Array(1), {
						headers: { 'content-length': String(MIRROR_LIMITS.tarballBytes + 1) }
					}),
				/over the/
			],
			[
				'the archive holds a traversal path',
				async () => ok(await archive(SHA2, [{ name: '../x', body: 'x' }])),
				/refused path/
			],
			[
				'the archive has no commit id',
				async () => ok(await archive(null, docsRepo())),
				/no commit id/
			],
			[
				'the archive has no pages',
				async () => ok(await archive(SHA2, [{ name: 't/src/a.ts', body: 'x' }])),
				/no pages/
			],
			['the body is not gzip', () => ok(enc.encode('not a tarball at all')), /./]
		];

		it.each(cases)('%s', async (_name, respond, message) => {
			const good = await archive(SHA1, docsRepo());
			let fail = false;
			const h = harness(() => (fail ? respond(good) : ok(good)));
			await refreshMirror(h.deps, worker);
			fail = true;
			h.advance(MIRROR_REFRESH_MS);
			const out = await refreshMirror(h.deps, worker);
			expect(out.status).toBe('failed');
			expect(out.status === 'failed' && out.message).toMatch(message);
			const view = await readMirrorPage(h.deps, worker, ['getting-started']);
			expect(view).toMatchObject({ sha: SHA1, fromFallback: false });
			expect((await readMeta(h.deps, 'worker'))?.syncedAt).toBe(1_000_000);
			expect(h.store.has('docmirror:worker:status')).toBe(true);
		});

		it('stops reading a streamed body at the cap', async () => {
			const h = harness(
				() =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(MIRROR_LIMITS.tarballBytes));
								controller.enqueue(new Uint8Array(10));
								controller.close();
							}
						})
					)
			);
			const out = await refreshMirror(h.deps, worker);
			expect(out).toMatchObject({ status: 'failed' });
		});

		it('keeps the copy when the network call throws', async () => {
			const good = await archive(SHA1, docsRepo());
			let fail = false;
			const h = harness(() => {
				if (fail) throw new TypeError('offline');
				return ok(good);
			});
			await refreshMirror(h.deps, worker);
			fail = true;
			expect(await refreshMirror(h.deps, worker)).toMatchObject({
				status: 'failed',
				message: 'offline'
			});
			expect(await readMirrorPage(h.deps, worker, [])).toMatchObject({ sha: SHA1 });
		});
	});
});

describe('a miss falls back to one raw fetch', () => {
	const RAW = 'https://raw.githubusercontent.com/drupflare/worker/master';

	it('renders and caches a page when nothing has synced yet', async () => {
		const h = harness((url) =>
			url === `${RAW}/docs/operating/recovery.md`
				? new Response('# Recovery\n\n[back](../index.md)')
				: new Response('missing', { status: 404 })
		);
		const first = await readMirrorPage(h.deps, worker, ['operating', 'recovery']);
		expect(first).toMatchObject({ fromFallback: true, syncedAt: null, sha: '' });
		expect(first?.page.title).toBe('Recovery');
		expect(h.calls.map((c) => c.url)).toEqual([`${RAW}/docs/operating/recovery.md`]);
		const second = await readMirrorPage(h.deps, worker, ['operating', 'recovery']);
		expect(second?.page.title).toBe('Recovery');
		expect(h.calls).toHaveLength(1);
	});

	it('tries the folder index second and gives up after two fetches', async () => {
		const h = harness((url) =>
			url === `${RAW}/docs/operating/index.md`
				? new Response('# Operating')
				: new Response('missing', { status: 404 })
		);
		expect((await readMirrorPage(h.deps, worker, ['operating']))?.page.title).toBe('Operating');
		expect(h.calls).toHaveLength(2);

		const none = harness(() => new Response('missing', { status: 404 }));
		expect(await readMirrorPage(none.deps, worker, ['gone'])).toBeNull();
		expect(none.calls).toHaveLength(2);
	});

	it('fetches the repository README for the home page', async () => {
		const h = harness(() => new Response('# Home'));
		await readMirrorPage(h.deps, worker, []);
		expect(h.calls.map((c) => c.url)).toEqual([`${RAW}/README.md`]);
	});

	it('titles a home page with no heading Overview, as the synced copy does', async () => {
		const h = harness(() => new Response('<div><h1>Raw html only</h1></div>\n\nText.'));
		const view = await readMirrorPage(h.deps, worker, []);
		expect(view?.page.title).toBe('Overview');
	});

	it('serves a page that appeared after the last sync', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness((url) =>
			url.startsWith('https://raw.githubusercontent.com')
				? new Response('# New Page\n\n[install](getting-started/install.md)')
				: ok(gz)
		);
		await refreshMirror(h.deps, worker);
		const view = await readMirrorPage(h.deps, worker, ['new-page']);
		expect(view).toMatchObject({ fromFallback: true, sha: SHA1 });
		expect(JSON.stringify(view?.page.nodes)).toContain('/docs/worker/getting-started/install');
		expect(view?.nav.length).toBeGreaterThan(0);
	});

	it.each([
		['dot dot', ['..']],
		['dot dot in the middle', ['a', '..', 'b']],
		['an encoded slash', ['a%2Fb']],
		['a decoded slash inside one segment', ['a/../b']],
		['unicode', ['café']],
		['a backslash', ['a\\b']],
		['an empty segment', ['a', '', 'b']],
		['a leading dot', ['.env']],
		['a query', ['a?x=1']],
		['too deep', Array.from({ length: 9 }, () => 'a')],
		['too long', ['a'.repeat(129)]],
		['a null byte', ['a\u0000b']]
	])('answers 404 for %s without any fetch', async (_name, slug) => {
		const h = harness(() => new Response('# x'));
		expect(await readMirrorPage(h.deps, worker, slug)).toBeNull();
		expect(h.calls).toEqual([]);
	});

	it('answers 404 for a slash string that holds a dot dot', async () => {
		const h = harness(() => new Response('# x'));
		expect(await readMirrorPage(h.deps, worker, '../etc/passwd')).toBeNull();
		expect(h.calls).toEqual([]);
	});

	it('answers null when GitHub is unreachable or oversize', async () => {
		const down = harness(() => {
			throw new TypeError('offline');
		});
		expect(await readMirrorPage(down.deps, worker, ['a'])).toBeNull();
		const big = harness(
			() =>
				new Response('# x', {
					headers: { 'content-length': String(MIRROR_LIMITS.pageBytes + 1) }
				})
		);
		expect(await readMirrorPage(big.deps, worker, ['a'])).toBeNull();
		const bad = harness(() => new Response('boom', { status: 500 }));
		expect(await readMirrorPage(bad.deps, worker, ['a'])).toBeNull();
		const moved = harness(
			() =>
				new Response(null, { status: 301, headers: { location: 'https://example.test/x' } })
		);
		expect(await readMirrorPage(moved.deps, worker, ['a'])).toBeNull();
	});
});

describe('assets', () => {
	it('answers only cached images', async () => {
		const gz = await archive(SHA1, docsRepo());
		const h = harness(() => ok(gz));
		await refreshMirror(h.deps, worker);
		expect(await readMirrorAsset(h.deps, worker, 'docs/img/x.png')).not.toBeNull();
		expect(await readMirrorAsset(h.deps, worker, 'docs/logo.svg')).toBeNull();
		expect(await readMirrorAsset(h.deps, worker, 'docs/img/none.png')).toBeNull();
		expect(await readMirrorAsset(h.deps, worker, '../x.png')).toBeNull();
		expect(await readMirrorAsset(h.deps, worker, 'docs/%2e%2e/x.png')).toBeNull();
		expect(
			await readMirrorAsset(harness(() => ok(gz)).deps, worker, 'docs/img/x.png')
		).toBeNull();
	});
});
