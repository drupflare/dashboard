import { describe, expect, it } from 'vitest';
import { base64Encode, base64Length, multipartBody } from '../../../engine/src/stream-body';

const bytesOf = (length: number, seed = 7) => {
	const out = new Uint8Array(length);
	let state = seed;
	for (let i = 0; i < length; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = state >> 16;
	}
	return out;
};

const btoaOf = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function drain(body: ReadableStream<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return { bytes: out, chunks };
}

describe('base64Encode', () => {
	it.each([0, 1, 2, 3, 4, 5, 6, 7, 100, 1001])('matches btoa for %i bytes', (length) => {
		const source = bytesOf(length);
		expect(new TextDecoder().decode(base64Encode(source))).toBe(btoaOf(source));
		expect(base64Encode(source).byteLength).toBe(base64Length(length));
	});
});

describe('multipartBody', () => {
	it('reads back through a form-data parser with every part intact', async () => {
		const wasm = bytesOf(150_001);
		const built = multipartBody([
			{ name: 'metadata', bytes: new TextEncoder().encode('{"main_module":"a.js"}') },
			{
				name: 'a.js',
				filename: 'a.js',
				contentType: 'application/javascript+module',
				bytes: new TextEncoder().encode('export default {}')
			},
			{
				name: 'php.wasm',
				filename: 'php.wasm',
				contentType: 'application/wasm',
				bytes: wasm
			},
			{
				name: 'empty',
				filename: 'empty',
				contentType: 'text/plain',
				bytes: new Uint8Array(0)
			}
		]);
		const form = await new Response(built.body, {
			headers: { 'content-type': built.contentType }
		}).formData();
		expect(form.get('metadata')).toBe('{"main_module":"a.js"}');
		const script = form.get('a.js') as File;
		expect(script.type).toBe('application/javascript+module');
		expect(await script.text()).toBe('export default {}');
		const parsed = form.get('php.wasm') as File;
		expect(parsed.type).toBe('application/wasm');
		expect(new Uint8Array(await parsed.arrayBuffer())).toEqual(wasm);
		expect((form.get('empty') as File).size).toBe(0);
	});

	it('sends a part as base64 when asked, across more than one slice', async () => {
		const asset = bytesOf(300_007);
		const built = multipartBody([
			{
				name: 'abc',
				filename: 'abc',
				contentType: 'application/null',
				bytes: asset,
				base64: true
			}
		]);
		const form = await new Response(built.body, {
			headers: { 'content-type': built.contentType }
		}).formData();
		expect(await (form.get('abc') as File).text()).toBe(btoaOf(asset));
	});

	it('reports the exact length of what it sends', async () => {
		const built = multipartBody([
			{ name: 'metadata', bytes: bytesOf(33) },
			{
				name: 'x',
				filename: 'x',
				contentType: 'application/null',
				bytes: bytesOf(1000),
				base64: true
			},
			{ name: 'y', filename: 'y', bytes: bytesOf(70_000) }
		]);
		expect((await drain(built.body)).bytes.byteLength).toBe(built.length);
	});

	it('never emits a chunk larger than a slice, however big the part', async () => {
		const built = multipartBody([
			{ name: 'big', filename: 'big', bytes: bytesOf(2_000_000), base64: true }
		]);
		const { chunks } = await drain(built.body);
		expect(chunks.length).toBeGreaterThan(30);
		expect(Math.max(...chunks.map((c) => c.byteLength))).toBeLessThanOrEqual(64 * 1024);
	});

	it('escapes a quote and a line break in a name', async () => {
		const built = multipartBody([{ name: 'a"b\nc', filename: 'f"g', bytes: bytesOf(3) }]);
		const text = new TextDecoder().decode((await drain(built.body)).bytes);
		expect(text).toContain('name="a%22b%0Ac"; filename="f%22g"');
	});
});
