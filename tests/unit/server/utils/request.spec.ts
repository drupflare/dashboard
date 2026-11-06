import { createApp, defineEventHandler, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody, parseQuery, readCappedBody } from '../../../../src/server/utils/request';
import { thrownBy } from './support';

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	status: z.enum(['open', 'closed']).optional()
});

describe('parseQuery', () => {
	it('returns typed values', () => {
		expect(parseQuery(querySchema, new URLSearchParams('limit=20&status=open'))).toEqual({
			limit: 20,
			status: 'open'
		});
	});

	it('lists the failing field paths in details', () => {
		const error = thrownBy(() =>
			parseQuery(querySchema, new URLSearchParams('limit=500&status=maybe'))
		);
		expect(error).toMatchObject({
			code: 'validation',
			status: 400,
			details: [{ path: 'limit' }, { path: 'status' }]
		});
	});
});

describe('parseBody', () => {
	const bodySchema = z.object({
		name: z.string().min(1),
		owner: z.object({ email: z.email() })
	});

	it('returns a typed value from valid JSON', () => {
		const text = '{"name":"site","owner":{"email":"a@example.com"}}';
		expect(parseBody(bodySchema, text, 1024)).toEqual({
			name: 'site',
			owner: { email: 'a@example.com' }
		});
	});

	it('refuses text that is not JSON', () => {
		expect(thrownBy(() => parseBody(bodySchema, '{name:', 1024))).toMatchObject({
			code: 'validation'
		});
	});

	it('uses dotted paths for nested fields', () => {
		const text = '{"name":"site","owner":{"email":"nope"}}';
		expect(thrownBy(() => parseBody(bodySchema, text, 1024))).toMatchObject({
			code: 'validation',
			details: [{ path: 'owner.email' }]
		});
	});

	it('counts bytes, not characters, against the cap', () => {
		const accented = String.fromCharCode(0xe9).repeat(10);
		const text = `{"name":"${accented}"}`;
		expect(text.length).toBeLessThan(25);
		expect(new TextEncoder().encode(text).byteLength).toBe(31);
		expect(thrownBy(() => parseBody(z.object({ name: z.string() }), text, 25))).toMatchObject({
			code: 'validation'
		});
		expect(parseBody(z.object({ name: z.string() }), text, 31)).toEqual({ name: accented });
	});
});

describe('readCappedBody', () => {
	async function read(body: BodyInit | ReadableStream | null, max: number, headers = {}) {
		const outcome: { text?: string; error?: unknown } = {};
		const app = createApp();
		app.use(
			defineEventHandler(async (event) => {
				try {
					outcome.text = await readCappedBody(event, max);
				} catch (error) {
					outcome.error = error;
				}
				return 'done';
			})
		);
		const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers, body };
		if (body instanceof ReadableStream) init.duplex = 'half';
		await toWebHandler(app)(new Request('http://localhost/', init));
		return outcome;
	}

	it('returns the body text when it fits, decoding utf-8', async () => {
		expect((await read('{"name":"é"}', 100)).text).toBe('{"name":"é"}');
	});

	it('returns an empty string when there is no body', async () => {
		expect((await read(null, 100)).text).toBe('');
	});

	it('accepts a body of exactly the cap and refuses one byte more', async () => {
		expect((await read('a'.repeat(32), 32)).text).toHaveLength(32);
		expect((await read('a'.repeat(33), 32)).error).toMatchObject({ code: 'validation' });
	});

	it('refuses at once when the declared length is over the cap, without reading', async () => {
		const outcome = await read('x', 10, { 'content-length': '5000' });
		expect(outcome.error).toMatchObject({
			code: 'validation',
			message: 'Request body is too large'
		});
	});

	it('counts bytes, not characters', async () => {
		const accented = String.fromCharCode(0xe9).repeat(10);
		expect((await read(accented, 19)).error).toMatchObject({ code: 'validation' });
		expect((await read(accented, 20)).text).toBe(accented);
	});

	it('stops pulling from a stream that never ends, a few chunks past the cap', async () => {
		let pulled = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024).fill(97));
			},
			cancel() {
				cancelled = true;
			}
		});
		const outcome = await read(stream, 4096);
		expect(outcome.error).toMatchObject({ code: 'validation' });
		expect(cancelled).toBe(true);
		// the stream's own buffer may run a little ahead of the reader; it must stay near the cap
		expect(pulled).toBeLessThan(16);
	});

	it('refuses a body that is longer than its declared length says', async () => {
		const chunks = [
			new Uint8Array(8).fill(97),
			new Uint8Array(8).fill(97),
			new Uint8Array(8).fill(97)
		];
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = chunks.shift();
				if (next) controller.enqueue(next);
				else controller.close();
			}
		});
		const outcome = await read(stream, 16, { 'content-length': '4' });
		expect(outcome.error).toMatchObject({ code: 'validation' });
	});
});
