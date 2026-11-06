import { describe, expect, it } from 'vitest';
import { normalizeHost, resolveRoute } from '../../../dispatch/src/route';

const entry = { v: 1, siteId: 'site_testsite0001', script: 'calm-river-stone', epoch: 3 };

describe('normalizeHost', () => {
	it('lowercases and drops one trailing dot', () => {
		expect(normalizeHost('Calm-River-Stone.Drupflare.App.')).toBe(
			'calm-river-stone.drupflare.app'
		);
	});

	it('rejects empty, spaced, underscored and over-long hosts', () => {
		for (const bad of ['', 'a b.example', 'a_b.example', '-a.example', 'a'.repeat(254)]) {
			expect(normalizeHost(bad)).toBeNull();
		}
	});
});

describe('resolveRoute', () => {
	it('reads a strict entry into a site id, script and epoch', () => {
		expect(resolveRoute('a.example', JSON.stringify(entry))).toEqual({
			ok: true,
			value: { siteId: 'site_testsite0001', script: 'calm-river-stone', epoch: 3 }
		});
	});

	it('answers unknown_host for a missing entry or an invalid host', () => {
		expect(resolveRoute('a.example', null)).toEqual({ ok: false, code: 'unknown_host' });
		expect(resolveRoute('bad host', JSON.stringify(entry))).toEqual({
			ok: false,
			code: 'unknown_host'
		});
	});

	it('answers malformed_route for bad json, extra keys, a bad id or script and a negative epoch', () => {
		const bad = [
			'{not json',
			JSON.stringify({ ...entry, extra: 1 }),
			JSON.stringify({ ...entry, siteId: 'nope' }),
			JSON.stringify({ ...entry, script: 'Has Space' }),
			JSON.stringify({ ...entry, epoch: -1 }),
			JSON.stringify({ ...entry, v: 2 }),
			JSON.stringify([entry]),
			'null'
		];
		for (const raw of bad) {
			expect(resolveRoute('a.example', raw)).toEqual({ ok: false, code: 'malformed_route' });
		}
	});
});
