import type { CollegeDBClient } from '@earth-app/collegedb';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	IDEMPOTENCY_CLAIM_TTL_MS,
	IDEMPOTENCY_RECORD_TTL_MS,
	checkIdempotency,
	collegeIdempotencyStore,
	createMemoryStore,
	parseIdempotencyKey,
	requestFingerprint
} from '../../../../src/server/utils/idempotency';
import { useClock } from '../services/auth-support';
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
	let clock: ReturnType<typeof useClock>;
	beforeEach(() => {
		clock = useClock();
	});
	afterEach(() => clock.stop());

	it('hands a free key to the first caller and reports it pending to the second', async () => {
		const store = createMemoryStore();
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'claimed' });
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'pending', fingerprint: 'fp' });
	});

	it('lets exactly one of many parallel claims win', async () => {
		const store = createMemoryStore();
		const claims = await Promise.all(Array.from({ length: 20 }, () => store.claim('k', 'fp')));
		expect(claims.filter((claim) => claim.kind === 'claimed')).toHaveLength(1);
		expect(claims.filter((claim) => claim.kind === 'pending')).toHaveLength(19);
	});

	it('returns what was put once the claim completes', async () => {
		const store = createMemoryStore();
		const record = { fingerprint: 'fp', status: 201, body: { id: 'site_1' } };
		await store.claim('key-1', 'fp');
		await store.put('key-1', record);
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'stored', record });
	});

	it('frees a released claim, and keeps a stored record when release is called late', async () => {
		const store = createMemoryStore();
		await store.claim('key-1', 'fp');
		await store.release('key-1');
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'claimed' });
		const record = { fingerprint: 'fp', status: 200, body: null };
		await store.put('key-1', record);
		await store.release('key-1');
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'stored', record });
	});

	it('frees a claim that never finished once the claim ttl has passed', async () => {
		const store = createMemoryStore();
		await store.claim('key-1', 'fp');
		clock.advance(IDEMPOTENCY_CLAIM_TTL_MS - 1);
		expect((await store.claim('key-1', 'fp')).kind).toBe('pending');
		clock.advance(1);
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'claimed' });
	});

	it('forgets a stored record after the record ttl', async () => {
		const store = createMemoryStore();
		await store.claim('key-1', 'fp');
		await store.put('key-1', { fingerprint: 'fp', status: 200, body: null });
		clock.advance(IDEMPOTENCY_RECORD_TTL_MS);
		expect(await store.claim('key-1', 'fp')).toEqual({ kind: 'claimed' });
	});
});

describe('checkIdempotency', () => {
	it('proceeds and takes the key when nothing holds it', async () => {
		const store = createMemoryStore();
		expect(await checkIdempotency(store, 'key-1', 'fp')).toEqual({ kind: 'proceed' });
		expect(await checkIdempotency(store, 'key-1', 'fp')).toEqual({ kind: 'pending' });
	});

	it('replays the stored response for the same key and fingerprint', async () => {
		const store = createMemoryStore();
		await store.claim('key-1', 'fp');
		await store.put('key-1', { fingerprint: 'fp', status: 201, body: { id: 'site_1' } });
		expect(await checkIdempotency(store, 'key-1', 'fp')).toEqual({
			kind: 'replay',
			status: 201,
			body: { id: 'site_1' }
		});
	});

	it('refuses the same key with a different fingerprint, stored or still running', async () => {
		const store = createMemoryStore();
		await store.claim('key-1', 'fp');
		await expect(checkIdempotency(store, 'key-1', 'other')).rejects.toMatchObject({
			code: 'unprocessable',
			status: 422
		});
		await store.put('key-1', { fingerprint: 'fp', status: 201, body: {} });
		await expect(checkIdempotency(store, 'key-1', 'other')).rejects.toMatchObject({
			code: 'unprocessable',
			status: 422
		});
	});
});

describe('collegeIdempotencyStore', () => {
	interface Call {
		method: string;
		key: string;
		sql: string;
		params: unknown[];
	}

	function fakeDb(answers: unknown[]) {
		const calls: Call[] = [];
		const db = {
			async first(key: string, sql: string, params: unknown[]) {
				calls.push({ method: 'first', key, sql, params });
				return answers.shift() ?? null;
			},
			async run(key: string, sql: string, params: unknown[]) {
				calls.push({ method: 'run', key, sql, params });
			}
		} as unknown as CollegeDBClient;
		return { calls, store: collegeIdempotencyStore(async () => db) };
	}

	const KEY = 'user:user-1|org-1|client-key-1';

	it('splits the key into the organisation column and the caller plus client key', async () => {
		const { calls, store } = fakeDb([{ request_hash: 'fp' }]);
		expect(await store.claim(KEY, 'fp')).toEqual({ kind: 'claimed' });
		expect(calls[0]!.key).toBe('org-1');
		expect(calls[0]!.params.slice(0, 3)).toEqual(['org-1', 'user:user-1|client-key-1', 'fp']);
		expect(calls[0]!.sql).toMatch(/ON CONFLICT .* DO UPDATE .* WHERE .*expires_at <= \?/s);
	});

	it('reads the holder back when the claim is refused', async () => {
		const pending = fakeDb([
			null,
			{ request_hash: 'fp', response_status: null, response_body: null }
		]);
		expect(await pending.store.claim(KEY, 'fp')).toEqual({
			kind: 'pending',
			fingerprint: 'fp'
		});
		const stored = fakeDb([
			null,
			{ request_hash: 'fp', response_status: 201, response_body: '{"id":"site_1"}' }
		]);
		expect(await stored.store.claim(KEY, 'fp')).toEqual({
			kind: 'stored',
			record: { fingerprint: 'fp', status: 201, body: { id: 'site_1' } }
		});
	});

	it('claims again when the holder released before the read, and gives up after three tries', async () => {
		const retried = fakeDb([null, null, { request_hash: 'fp' }]);
		expect(await retried.store.claim(KEY, 'fp')).toEqual({ kind: 'claimed' });
		const stuck = fakeDb([null, null, null, null, null, null]);
		await expect(stuck.store.claim(KEY, 'fp')).rejects.toMatchObject({ code: 'conflict' });
	});

	it('completes with the response and releases only a claim with no response', async () => {
		const { calls, store } = fakeDb([]);
		await store.put(KEY, { fingerprint: 'fp', status: 202, body: { ok: true } });
		await store.release(KEY);
		expect(calls[0]!.params.slice(0, 2)).toEqual([202, '{"ok":true}']);
		expect(calls[0]!.params.slice(3)).toEqual(['org-1', 'user:user-1|client-key-1', 'fp']);
		expect(calls[1]!.sql).toMatch(/response_status IS NULL/);
	});

	it('falls back to a dash for a key with no organisation part', async () => {
		const { calls, store } = fakeDb([{ request_hash: 'fp' }]);
		await store.claim('client-key-1', 'fp');
		expect(calls[0]!.key).toBe('-');
	});
});
