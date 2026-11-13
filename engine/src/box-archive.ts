import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types';

export const BOX_ARCHIVE_ROUTE = '/link/payload/';

const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}\.tar\.gz$/;

export const boxArchiveKey = (releaseId: string, name: string) =>
	`releases/${releaseId}/box/${name}`;

export const isBoxArchivePath = (url: URL) => url.pathname.startsWith(BOX_ARCHIVE_ROUTE);

// the bucket key a request path names, and null for anything that is not exactly <id>/<name>.tar.gz
export function boxArchiveOf(url: URL): string | null {
	if (!isBoxArchivePath(url)) return null;
	const [releaseId, name, ...rest] = url.pathname.slice(BOX_ARCHIVE_ROUTE.length).split('/');
	if (rest.length > 0 || releaseId === undefined || name === undefined) return null;
	if (!RELEASE_ID.test(releaseId) || !ARCHIVE_NAME.test(name)) return null;
	if (releaseId.includes('..') || name.includes('..')) return null;
	return boxArchiveKey(releaseId, name);
}

export interface ByteSlice {
	start: number;
	end: number;
}

// one byte range of an object of this size; null means serve the whole object, as a header with
// several ranges or an unreadable one is allowed to be ignored
export function parseRange(
	header: string | null,
	size: number
): ByteSlice | 'unsatisfiable' | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
	if (match === null || (match[1] === '' && match[2] === '')) return null;
	const first = match[1] === '' ? null : Number(match[1]);
	const second = match[2] === '' ? null : Number(match[2]);
	if ([first, second].some((n) => n !== null && !Number.isSafeInteger(n))) return null;
	if (first === null) {
		const suffix = second as number;
		return suffix === 0 || size === 0
			? 'unsatisfiable'
			: { start: Math.max(0, size - suffix), end: size - 1 };
	}
	if (second !== null && second < first) return null;
	if (first >= size) return 'unsatisfiable';
	return { start: first, end: Math.min(second ?? size - 1, size - 1) };
}

const notFound = () => new Response(null, { status: 404 });

// the store's stream and a Response body are typed by different libs where scripts import this file
const bodyOf = (object: R2ObjectBody) => object.body as unknown as BodyInit;

function headersOf(object: R2Object, length: number): Headers {
	return new Headers({
		'content-type': 'application/gzip',
		'content-length': String(length),
		'cache-control': 'public, max-age=31536000, immutable',
		'accept-ranges': 'bytes',
		etag: object.httpEtag
	});
}

// release archives are the bytes a public release would publish, so the route needs no credential
export async function serveBoxArchive(
	request: Request,
	bucket: Pick<R2Bucket, 'get' | 'head'>
): Promise<Response> {
	const key = boxArchiveOf(new URL(request.url));
	if (key === null) return notFound();
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
	}
	const wanted = request.method === 'GET' ? request.headers.get('range') : null;
	if (request.method === 'GET' && wanted === null) {
		const object = await bucket.get(key);
		return object === null
			? notFound()
			: new Response(bodyOf(object), { headers: headersOf(object, object.size) });
	}
	const head = await bucket.head(key);
	if (head === null) return notFound();
	if (request.method === 'HEAD') {
		return new Response(null, { headers: headersOf(head, head.size) });
	}
	const slice = parseRange(wanted, head.size);
	if (slice === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { 'content-range': `bytes */${head.size}` }
		});
	}
	const object = await bucket.get(
		key,
		slice === null
			? undefined
			: { range: { offset: slice.start, length: slice.end - slice.start + 1 } }
	);
	if (object === null) return notFound();
	if (slice === null) {
		return new Response(bodyOf(object), { headers: headersOf(object, object.size) });
	}
	const headers = headersOf(object, slice.end - slice.start + 1);
	headers.set('content-range', `bytes ${slice.start}-${slice.end}/${head.size}`);
	return new Response(bodyOf(object), { status: 206, headers });
}
