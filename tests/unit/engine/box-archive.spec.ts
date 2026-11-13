import { describe, expect, it } from 'vitest';
import {
	boxArchiveKey,
	boxArchiveOf,
	isBoxArchivePath,
	parseRange,
	serveBoxArchive
} from '../../../engine/src/box-archive';
import { handleLink, linkNodeId } from '../../../engine/src/node-link';

const ID = 'snap-b551063-59cff488';
const NAME = `drupflare-box-bundle-${ID}.tar.gz`;
const KEY = `releases/${ID}/box/${NAME}`;
const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const HOST = 'https://link-staging.example';

interface Call {
	op: 'get' | 'head';
	key: string;
	range?: { offset: number; length: number };
}

// holds one object and records every read, so a spec can see what the route asked the store for
function bucket(objects: Record<string, Uint8Array<ArrayBuffer>> = { [KEY]: BYTES }) {
	const calls: Call[] = [];
	const meta = (key: string, bytes: Uint8Array) => ({
		key,
		size: bytes.byteLength,
		etag: `etag-${key}`,
		httpEtag: `"etag-${key}"`
	});
	return {
		calls,
		store: {
			async head(key: string) {
				calls.push({ op: 'head', key });
				const bytes = objects[key];
				return bytes === undefined ? null : meta(key, bytes);
			},
			async get(key: string, options?: { range?: { offset: number; length: number } }) {
				calls.push({ op: 'get', key, range: options?.range });
				const bytes = objects[key];
				if (bytes === undefined) return null;
				const range = options?.range;
				const part = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
				return { ...meta(key, bytes), body: new Blob([part]).stream() };
			}
		} as never
	};
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const url = (path: string) => `${HOST}${path}`;
const good = url(`/link/payload/${ID}/${NAME}`);

describe('boxArchiveOf', () => {
	it('names the bucket key for an id and a tar.gz file and nothing else', () => {
		expect(boxArchiveOf(new URL(good))).toBe(KEY);
		expect(boxArchiveKey(ID, NAME)).toBe(KEY);
		expect(boxArchiveOf(new URL(url('/link/payload/v1.0.5/a.tar.gz')))).toBe(
			'releases/v1.0.5/box/a.tar.gz'
		);
	});

	it.each([
		['no file', `/link/payload/${ID}`],
		['no file, trailing slash', `/link/payload/${ID}/`],
		['an extra segment', `/link/payload/${ID}/box/${NAME}`],
		['a trailing segment', `/link/payload/${ID}/${NAME}/more`],
		['a .tgz name', `/link/payload/${ID}/a.tgz`],
		['a .zip name', `/link/payload/${ID}/a.zip`],
		['a bare tar.gz', `/link/payload/${ID}/.tar.gz`],
		['a double extension', `/link/payload/${ID}/a.tar.gz.txt`],
		['a dot dot in the name', `/link/payload/${ID}/a..b.tar.gz`],
		['a dot dot in the id', `/link/payload/a..b/a.tar.gz`],
		['an encoded slash', `/link/payload/${ID}/..%2f${NAME}`],
		['an encoded slash in the id', `/link/payload/..%2fx/${NAME}`],
		['an encoded percent', `/link/payload/${ID}/%61.tar.gz`],
		['a backslash', `/link/payload/${ID}/a%5cb.tar.gz`],
		['a name over the length cap', `/link/payload/${ID}/${'a'.repeat(200)}.tar.gz`],
		['an id over the length cap', `/link/payload/${'a'.repeat(65)}/a.tar.gz`],
		['a leading dot id', `/link/payload/.hidden/a.tar.gz`],
		['an empty id', `/link/payload//a.tar.gz`]
	])('refuses %s', (_label, path) => {
		expect(boxArchiveOf(new URL(url(path)))).toBeNull();
	});

	it('never reads a traversal as a path out of the release folder', () => {
		// the url parser resolves dot segments before the route sees the path
		for (const path of [
			`/link/payload/${ID}/../other/${NAME}`,
			`/link/payload/${ID}/%2e%2e/${NAME}`,
			`/link/payload/../${ID}/${NAME}`
		]) {
			const key = boxArchiveOf(new URL(url(path)));
			expect(key === null || /^releases\/[^/.][^/]*\/box\/[^/]+\.tar\.gz$/.test(key)).toBe(
				true
			);
			expect(key ?? '').not.toContain('..');
		}
	});

	it('does not claim a node socket path or anything outside the route', () => {
		expect(boxArchiveOf(new URL(url('/link/nod_abcdefgh1234')))).toBeNull();
		expect(boxArchiveOf(new URL(url('/start')))).toBeNull();
		expect(boxArchiveOf(new URL(url(`/link/payloads/${ID}/${NAME}`)))).toBeNull();
	});
});

describe('parseRange', () => {
	it.each([
		['bytes=0-9', { start: 0, end: 9 }],
		['bytes=10-', { start: 10, end: 99 }],
		['bytes=-10', { start: 90, end: 99 }],
		['bytes=90-500', { start: 90, end: 99 }],
		['bytes=-500', { start: 0, end: 99 }],
		['bytes=99-99', { start: 99, end: 99 }]
	])('reads %s', (header, slice) => {
		expect(parseRange(header, 100)).toEqual(slice);
	});

	it.each(['bytes=100-', 'bytes=200-300', 'bytes=-0'])('finds %s unsatisfiable', (header) => {
		expect(parseRange(header, 100)).toBe('unsatisfiable');
	});

	it('finds every range of an empty object unsatisfiable', () => {
		expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
		expect(parseRange('bytes=-1', 0)).toBe('unsatisfiable');
	});

	it.each([
		null,
		'',
		'bytes=0-1,5-6',
		'bytes=',
		'bytes=-',
		'bytes=9-3',
		'items=0-1',
		'bytes=a-b',
		'bytes=0-1 ',
		`bytes=${'9'.repeat(30)}-`
	])('serves the whole object for %s', (header) => {
		expect(parseRange(header, 100)).toBeNull();
	});
});

describe('serveBoxArchive', () => {
	it('streams the object with its length, type, cache lifetime and etag', async () => {
		const { store, calls } = bucket();
		const response = await serveBoxArchive(new Request(good), store);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('100');
		expect(response.headers.get('content-type')).toBe('application/gzip');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('etag')).toBe(`"etag-${KEY}"`);
		expect(await bytesOf(response)).toEqual(BYTES);
		expect(calls).toEqual([{ op: 'get', key: KEY, range: undefined }]);
	});

	it('answers HEAD with the same headers, no body and no read of the bytes', async () => {
		const { store, calls } = bucket();
		const response = await serveBoxArchive(new Request(good, { method: 'HEAD' }), store);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('100');
		expect(response.headers.get('etag')).toBe(`"etag-${KEY}"`);
		expect((await bytesOf(response)).byteLength).toBe(0);
		expect(calls).toEqual([{ op: 'head', key: KEY }]);
	});

	it('answers one range with 206, the slice and a content range', async () => {
		const { store, calls } = bucket();
		const response = await serveBoxArchive(
			new Request(good, { headers: { range: 'bytes=10-19' } }),
			store
		);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 10-19/100');
		expect(response.headers.get('content-length')).toBe('10');
		expect(await bytesOf(response)).toEqual(BYTES.slice(10, 20));
		expect(calls).toEqual([
			{ op: 'head', key: KEY },
			{ op: 'get', key: KEY, range: { offset: 10, length: 10 } }
		]);
	});

	it('reads an open ended and a suffix range against the real size', async () => {
		const open = await serveBoxArchive(
			new Request(good, { headers: { range: 'bytes=95-' } }),
			bucket().store
		);
		expect(open.headers.get('content-range')).toBe('bytes 95-99/100');
		expect(await bytesOf(open)).toEqual(BYTES.slice(95));
		const suffix = await serveBoxArchive(
			new Request(good, { headers: { range: 'bytes=-4' } }),
			bucket().store
		);
		expect(suffix.headers.get('content-range')).toBe('bytes 96-99/100');
		expect(await bytesOf(suffix)).toEqual(BYTES.slice(96));
	});

	it('answers 416 with the size for a range past the end', async () => {
		const { store } = bucket();
		const response = await serveBoxArchive(
			new Request(good, { headers: { range: 'bytes=100-' } }),
			store
		);
		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */100');
	});

	it('serves the whole object when the range header holds several ranges', async () => {
		const response = await serveBoxArchive(
			new Request(good, { headers: { range: 'bytes=0-1,5-6' } }),
			bucket().store
		);
		expect(response.status).toBe(200);
		expect(await bytesOf(response)).toEqual(BYTES);
	});

	it('ignores a range on HEAD', async () => {
		const response = await serveBoxArchive(
			new Request(good, { method: 'HEAD', headers: { range: 'bytes=0-1' } }),
			bucket().store
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('100');
	});

	it('answers 404 with no body for a missing object, on GET, HEAD and a range', async () => {
		const empty = bucket({});
		for (const init of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-1' } }]) {
			const response = await serveBoxArchive(new Request(good, init), empty.store);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('');
		}
	});

	it('answers 404 with no body for paths outside the form and never reads the bucket', async () => {
		const { store, calls } = bucket();
		for (const path of [
			`/link/payload/${ID}/a.tgz`,
			`/link/payload/${ID}/..%2f${NAME}`,
			`/link/payload/${ID}`,
			`/link/payload/${ID}/${NAME}/extra`,
			'/link/payload/',
			'/link/payload'
		]) {
			const response = await serveBoxArchive(new Request(url(path)), store);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe('');
		}
		expect(calls).toEqual([]);
	});

	it('does not read a key outside releases/<id>/box/ for any name it accepts', async () => {
		const { store, calls } = bucket({
			[KEY]: BYTES,
			'releases/other/manifest.json': new Uint8Array([1]),
			'releases/snap-b551063-59cff488/payload.json': new Uint8Array([1])
		});
		await serveBoxArchive(new Request(url(`/link/payload/${ID}/payload.json`)), store);
		await serveBoxArchive(new Request(url(`/link/payload/${ID}/a.tar.gz`)), store);
		for (const call of calls)
			expect(call.key).toMatch(/^releases\/[^/]+\/box\/[^/]+\.tar\.gz$/);
	});

	it('answers 405 with the allowed methods for any other method on a valid path', async () => {
		const { store, calls } = bucket();
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			const response = await serveBoxArchive(
				new Request(good, { method, body: method === 'DELETE' ? undefined : 'x' }),
				store
			);
			expect(response.status).toBe(405);
			expect(response.headers.get('allow')).toBe('GET, HEAD');
		}
		expect(calls).toEqual([]);
	});
});

describe('the link host routes', () => {
	const socketUrl = url('/link/nod_abcdefgh1234');

	it('gives a node socket path and an archive path to different routes', () => {
		expect(isBoxArchivePath(new URL(socketUrl))).toBe(false);
		expect(linkNodeId(new URL(socketUrl))).toBe('nod_abcdefgh1234');
		expect(isBoxArchivePath(new URL(good))).toBe(true);
		expect(linkNodeId(new URL(good))).toBeNull();
		expect(isBoxArchivePath(new URL(url('/link/payload/anything/at/all')))).toBe(true);
		expect(linkNodeId(new URL(url('/link/payload/anything/at/all')))).toBeNull();
	});

	it('still hands a node socket to its session beside the archive route', async () => {
		const forwarded: string[] = [];
		const route = {
			nodes: {
				get: async () => ({ state: 'active' }),
				touch: async () => undefined,
				sites: async () => []
			},
			sessions: {
				get: (id: string) => ({
					fetch: async () => {
						forwarded.push(id);
						return new Response('session');
					}
				})
			}
		} as never;
		const response = await handleLink(
			new Request(socketUrl, { headers: { upgrade: 'websocket' } }),
			route
		);
		expect(response.status).toBe(200);
		expect(forwarded).toEqual(['nod_abcdefgh1234']);
	});
});
