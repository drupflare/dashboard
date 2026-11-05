import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	checkIdempotency,
	createMemoryStore,
	parseIdempotencyKey,
	requestFingerprint
} from '../../../../src/server/utils/idempotency';
import { thrownBy } from './support';

describe('parseIdempotencyKey', () => {
	it('returns undefined when the header is absent', () => {
		expect(parseIdempotencyKey(undefined)).toBeUndefined();
		expect(parseIdempotencyKey(null)).toBeUndefined();
	});

	it('accepts keys of 8 and 128 characters', () => {
		expect(parseIdempotencyKey('abcdefgh')).toBe('abcdefgh');
		const longest = 'a'.repeat(128);
		expect(parseIdempotencyKey(longest)).toBe(longest);
	});

	it('refuses keys of 7 and 129 characters', () => {
		expect(thrownBy(() => parseIdempotencyKey('a'.repeat(7)))).toMatchObject({
			code: 'validation'
		});
		expect(thrownBy(() => parseIdempotencyKey('a'.repeat(129)))).toMatchObject({
			code: 'validation'
		});
	});

	it('accepts underscores and hyphens and refuses other characters', () => {
		expect(parseIdempotencyKey('key_with-dash')).toBe('key_with-dash');
		expect(thrownBy(() => parseIdempotencyKey('abc def.ghi'))).toMatchObject({
			code: 'validation'
		});
	});
});

describe('requestFingerprint', () => {
	it('is the SHA-256 of the method, path and body', async () => {
		const expected = createHash('sha256').update('GET /\n').digest('hex');
		expect(await requestFingerprint('GET', '/', '')).toBe(expected);
	});

	it('ignores key order in a JSON body', async () => {
		const a = await requestFingerprint('POST', '/x', '{"a":1,"b":{"d":2,"c":3}}');
		const b = await requestFingerprint('POST', '/x', '{ "b": { "c": 3, "d": 2 }, "a": 1 }');
		expect(a).toBe(b);
	});

	it('changes with the method, the path or the body', async () => {
		const base = await requestFingerprint('POST', '/x', '{"a":1}');
		expect(await requestFingerprint('PUT', '/x', '{"a":1}')).not.toBe(base);
		expect(await requestFingerprint('POST', '/y', '{"a":1}')).not.toBe(base);
		expect(await requestFingerprint('POST', '/x', '{"a":2}')).not.toBe(base);
	});
});

describe('memory store', () => {
	it('returns null for an unknown key', async () => {
		expect(await createMemoryStore().get('missing')).toBeNull();
	});

	it('returns what was put', async () => {
		const store = createMemoryStore();
		const record = { fingerprint: 'fp', status: 201, body: { id: 'site_1' } };
		await store.put('key-1', record);
		expect(await store.get('key-1')).toEqual(record);
	});
});

describe('checkIdempotency', () => {
	it('proceeds when no record exists', async () => {
		expect(await checkIdempotency(createMemoryStore(), 'key-1', 'fp')).toEqual({
			kind: 'proceed'
		});
	});

	it('replays the stored response for the same key and fingerprint', async () => {
		const store = createMemoryStore();
		await store.put('key-1', { fingerprint: 'fp', status: 201, body: { id: 'site_1' } });
		expect(await checkIdempotency(store, 'key-1', 'fp')).toEqual({
			kind: 'replay',
			status: 201,
			body: { id: 'site_1' }
		});
	});

	it('refuses the same key with a different fingerprint', async () => {
		const store = createMemoryStore();
		await store.put('key-1', { fingerprint: 'fp', status: 201, body: {} });
		await expect(checkIdempotency(store, 'key-1', 'other')).rejects.toMatchObject({
			code: 'unprocessable',
			status: 422
		});
	});
});
