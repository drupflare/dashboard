import type { R2Bucket, R2UploadedPart } from '@cloudflare/workers-types';
import { convertDump } from '../../../../../drangler/src/migrate/convert';

interface Env {
	BLOB: R2Bucket;
	SPIKE_TOKEN?: string;
}

const MB = 1048576;

function authorized(request: Request, env: Env): boolean {
	if (!env.SPIKE_TOKEN) return false;
	const given = new TextEncoder().encode(request.headers.get('authorization') ?? '');
	const want = new TextEncoder().encode(`Bearer ${env.SPIKE_TOKEN}`);
	if (given.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < given.length; i++) diff |= given[i]! ^ want[i]!;
	return diff === 0;
}

function lastStatementEnd(bytes: Uint8Array): number {
	for (let i = bytes.length - 1; i > 0; i--) {
		if (bytes[i] === 10 && bytes[i - 1] === 59) return i + 1;
	}
	return -1;
}

async function step(env: Env, url: URL): Promise<Response> {
	const key = url.searchParams.get('key') ?? '';
	const offset = Number(url.searchParams.get('offset') ?? 0);
	const mb = Number(url.searchParams.get('mb') ?? 4);
	const write = url.searchParams.get('out') !== '0';
	const head = await env.BLOB.head(key);
	if (head === null) return Response.json({ error: 'no such object' }, { status: 404 });
	const length = Math.min(mb * MB, head.size - offset);
	const t0 = Date.now();
	const object = await env.BLOB.get(key, { range: { offset, length } });
	if (object === null) return Response.json({ error: 'read failed' }, { status: 500 });
	const bytes = new Uint8Array(await object.arrayBuffer());
	const readMs = Date.now() - t0;
	const last = offset + length >= head.size;
	const cut = last ? bytes.length : lastStatementEnd(bytes);
	if (cut < 0) return Response.json({ error: 'no statement boundary in range' }, { status: 422 });
	const text = new TextDecoder().decode(bytes.subarray(0, cut));
	const result = convertDump(text, { from: 'mysql', to: 'sqlite' });
	let putMs = 0;
	if (write) {
		const t1 = Date.now();
		await env.BLOB.put(`out/${key}/${offset}`, result.sql);
		putMs = Date.now() - t1;
	}
	return Response.json({
		offset,
		nextOffset: last ? null : offset + cut,
		inBytes: cut,
		outChars: result.sql.length,
		rows: result.rows,
		statements: result.statements,
		skipped: result.skipped.length,
		readMs,
		putMs
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!authorized(request, env)) return new Response('no', { status: 401 });
		const url = new URL(request.url);
		const key = url.searchParams.get('key') ?? '';
		try {
			if (url.pathname === '/upload/start') {
				const upload = await env.BLOB.createMultipartUpload(key);
				return Response.json({ uploadId: upload.uploadId });
			}
			if (url.pathname === '/upload/part') {
				const upload = env.BLOB.resumeMultipartUpload(
					key,
					url.searchParams.get('uploadId') ?? ''
				);
				const part = await upload.uploadPart(
					Number(url.searchParams.get('n')),
					request.body as never
				);
				return Response.json(part);
			}
			if (url.pathname === '/upload/finish') {
				const upload = env.BLOB.resumeMultipartUpload(
					key,
					url.searchParams.get('uploadId') ?? ''
				);
				const parts = (await request.json()) as R2UploadedPart[];
				const object = await upload.complete(parts);
				return Response.json({ size: object.size });
			}
			if (url.pathname === '/step') return await step(env, url);
			if (url.pathname === '/clean') {
				const prefix = url.searchParams.get('prefix') ?? '';
				if (prefix === '')
					return Response.json({ error: 'prefix required' }, { status: 400 });
				let removed = 0;
				for (;;) {
					const page = await env.BLOB.list({ prefix, limit: 1000 });
					if (page.objects.length === 0) break;
					await env.BLOB.delete(page.objects.map((o) => o.key));
					removed += page.objects.length;
				}
				return Response.json({ removed });
			}
			return new Response('not found', { status: 404 });
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error ? `${error.name}: ${error.message}` : String(error)
				},
				{ status: 500 }
			);
		}
	}
};
