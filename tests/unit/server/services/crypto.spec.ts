import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromBase64Url } from '../../../../contracts/src/common';
import {
	hmacSha256Base64Url,
	hmacSha256Hex,
	randomBytes,
	randomToken,
	sha256Base64Url,
	sha256Hex,
	timingSafeEqual,
	toHex
} from '../../../../src/server/services/crypto';

describe('timingSafeEqual', () => {
	it('compares strings and bytes', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(timingSafeEqual('abc', new Uint8Array([97, 98, 99]))).toBe(true);
		expect(timingSafeEqual('', '')).toBe(true);
	});

	it('refuses a difference in any position and in length', () => {
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('abc', 'xbc')).toBe(false);
		expect(timingSafeEqual('abc', 'ab')).toBe(false);
		expect(timingSafeEqual('ab', 'abc')).toBe(false);
		expect(timingSafeEqual('', 'a')).toBe(false);
		expect(timingSafeEqual('a', 'a\0')).toBe(false);
	});
});

describe('hashing', () => {
	it('matches node for sha256 in hex and base64url', async () => {
		const digest = createHash('sha256').update('hello').digest();
		expect(await sha256Hex('hello')).toBe(digest.toString('hex'));
		expect(await sha256Base64Url('hello')).toBe(digest.toString('base64url'));
		expect(await sha256Hex(new TextEncoder().encode('hello'))).toBe(digest.toString('hex'));
	});

	it('matches node for hmac with string and byte keys', async () => {
		const mac = createHmac('sha256', 'key').update('data').digest();
		expect(await hmacSha256Hex('key', 'data')).toBe(mac.toString('hex'));
		expect(await hmacSha256Base64Url('key', 'data')).toBe(mac.toString('base64url'));
		expect(
			await hmacSha256Hex(new TextEncoder().encode('key'), new TextEncoder().encode('data'))
		).toBe(mac.toString('hex'));
	});

	it('changes the mac when the key or the data changes', async () => {
		const base = await hmacSha256Hex('key', 'data');
		expect(await hmacSha256Hex('key2', 'data')).not.toBe(base);
		expect(await hmacSha256Hex('key', 'data2')).not.toBe(base);
	});

	it('encodes hex with leading zeros', () => {
		expect(toHex(new Uint8Array([0, 1, 255]))).toBe('0001ff');
	});
});

describe('random', () => {
	it('returns the requested number of bytes', () => {
		expect(randomBytes(0)).toHaveLength(0);
		expect(randomBytes(20)).toHaveLength(20);
	});

	it('makes url-safe tokens of the requested strength that do not repeat', () => {
		const token = randomToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(fromBase64Url(token)).toHaveLength(32);
		expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(new Set(Array.from({ length: 50 }, () => randomToken())).size).toBe(50);
	});
});
