import { describe, expect, it, vi } from 'vitest';
import {
	API_KEY_PREFIX,
	EXPIRY_PRESETS,
	generateApiKey,
	hashApiKey,
	parseApiKey,
	verifyApiKey,
	type ExpiryPreset
} from '../../../../src/server/services/api-keys';
import * as cryptoModule from '../../../../src/server/services/crypto';

const NOW = 1_700_000_000_000;
const make = (overrides: Partial<Parameters<typeof generateApiKey>[0]> = {}) =>
	generateApiKey({ scopes: ['site.read'], expiry: '90d', now: NOW, ...overrides });

describe('generateApiKey', () => {
	it('makes a dfk_ token whose public prefix is its display prefix', async () => {
		const { token, data } = await make();
		expect(token).toMatch(/^dfk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
		expect(token.startsWith(data.displayPrefix)).toBe(true);
		expect(data.displayPrefix).toBe(`${API_KEY_PREFIX}${data.lookupId}`);
		expect(parseApiKey(token)).toEqual({
			lookupId: data.lookupId,
			displayPrefix: data.displayPrefix
		});
	});

	it('stores a hash and never the secret', async () => {
		const { token, data } = await make();
		const secret = token.slice(data.displayPrefix.length + 1);
		expect(data.keyHash).toBe(await hashApiKey(token));
		expect(data.keyHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(data)).not.toContain(secret);
	});

	it('makes a different key every time', async () => {
		const keys = await Promise.all(Array.from({ length: 20 }, () => make()));
		expect(new Set(keys.map((k) => k.token)).size).toBe(20);
		expect(new Set(keys.map((k) => k.data.keyHash)).size).toBe(20);
	});

	it.each(Object.keys(EXPIRY_PRESETS) as ExpiryPreset[])(
		'sets expiry for the %s preset',
		async (expiry) => {
			const { data } = await make({ expiry });
			expect(data.expiresAt).toBe(NOW + EXPIRY_PRESETS[expiry]);
		}
	);

	it('carries scopes and restrictions as copied data', async () => {
		const scopes = ['site.read', 'site.deploy'];
		const orgIds = ['org_1'];
		const siteIds = ['site_1', 'site_2'];
		const { data } = await make({ scopes, orgIds, siteIds });
		expect(data.scopes).toEqual(scopes);
		expect(data.orgIds).toEqual(orgIds);
		expect(data.siteIds).toEqual(siteIds);
		scopes.push('site.delete');
		orgIds.push('org_2');
		expect(data.scopes).toHaveLength(2);
		expect(data.orgIds).toEqual(['org_1']);
	});

	it('leaves the restrictions off when none are given', async () => {
		const { data } = await make();
		expect('orgIds' in data).toBe(false);
		expect('siteIds' in data).toBe(false);
	});
});

describe('parseApiKey', () => {
	it.each([
		'',
		'dfk_',
		'sk_123456789abc_' + 'a'.repeat(43),
		'dfk_123456789ABC_' + 'a'.repeat(43),
		'dfk_123456789abc_' + 'a'.repeat(42),
		'dfk_123456789abc_' + 'a'.repeat(44),
		'dfk_123456789abc_' + 'a'.repeat(42) + '+',
		' dfk_123456789abc_' + 'a'.repeat(43)
	])('refuses %j', (text) => {
		expect(parseApiKey(text)).toBeNull();
	});
});

describe('verifyApiKey', () => {
	it('accepts the key it generated', async () => {
		const { token, data } = await make();
		expect(await verifyApiKey(token, data, NOW)).toEqual({ ok: true });
	});

	it('refuses a wrong secret with the right prefix', async () => {
		const { token, data } = await make();
		const wrong = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
		expect(await verifyApiKey(wrong, data, NOW)).toEqual({ ok: false, reason: 'mismatch' });
		const other = await make();
		expect(await verifyApiKey(other.token, data, NOW)).toEqual({
			ok: false,
			reason: 'mismatch'
		});
	});

	it('refuses a token that is not a dfk_ key', async () => {
		const { data } = await make();
		expect(await verifyApiKey('nope', data, NOW)).toEqual({ ok: false, reason: 'malformed' });
	});

	it('refuses an expired key at and after the expiry instant', async () => {
		const { token, data } = await make();
		expect(await verifyApiKey(token, data, data.expiresAt - 1)).toEqual({ ok: true });
		expect(await verifyApiKey(token, data, data.expiresAt)).toEqual({
			ok: false,
			reason: 'expired'
		});
		expect(await verifyApiKey(token, data, data.expiresAt + 1)).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('refuses a revoked key and reports revoked before expired', async () => {
		const { token, data } = await make();
		const stored = { ...data, revokedAt: NOW + 10, expiresAt: NOW };
		expect(await verifyApiKey(token, stored, NOW + 9)).toEqual({
			ok: false,
			reason: 'expired'
		});
		expect(await verifyApiKey(token, stored, NOW + 10)).toEqual({
			ok: false,
			reason: 'revoked'
		});
	});

	it('treats a null or absent expiry and revocation as none', async () => {
		const { token, data } = await make();
		expect(
			await verifyApiKey(
				token,
				{ keyHash: data.keyHash, expiresAt: null, revokedAt: null },
				NOW
			)
		).toEqual({ ok: true });
		expect(await verifyApiKey(token, { keyHash: data.keyHash }, NOW)).toEqual({ ok: true });
	});

	it('compares the hashes through timingSafeEqual and never with ===', async () => {
		const { token, data } = await make();
		const spy = vi.spyOn(cryptoModule, 'timingSafeEqual');
		try {
			await verifyApiKey(token, data, NOW);
			await verifyApiKey(token, { ...data, keyHash: 'f'.repeat(64) }, NOW);
			expect(spy).toHaveBeenCalledTimes(2);
			expect(spy).toHaveBeenNthCalledWith(1, data.keyHash, data.keyHash);
		} finally {
			spy.mockRestore();
		}
	});

	it('checks the secret before the state, so a wrong secret on a dead key says mismatch', async () => {
		const { token, data } = await make();
		const other = await make();
		const dead = { ...data, revokedAt: NOW - 1, expiresAt: NOW - 1 };
		expect(await verifyApiKey(other.token, dead, NOW)).toEqual({
			ok: false,
			reason: 'mismatch'
		});
		expect(await verifyApiKey(token, dead, NOW)).toEqual({ ok: false, reason: 'revoked' });
	});
});
