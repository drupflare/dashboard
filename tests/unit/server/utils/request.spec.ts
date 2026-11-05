import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBody, parseQuery } from '../../../../src/server/utils/request';
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
