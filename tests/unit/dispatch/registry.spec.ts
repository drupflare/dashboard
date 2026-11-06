import { describe, expect, it } from 'vitest';
import {
	clampHold,
	DEFAULT_HOLD_MS,
	MAX_HOLD_MS,
	releaseIn,
	reserveIn,
	tombstoneIn
} from '../../../dispatch/src/registry';
import { isReserved, RESERVED_WORDS, shardKey, suggest } from '../../../src/shared/names';
import { memoryKv } from './fakes';

const NOW = 1_790_000_000_000;
const A = 'site_aaaaaaaa0001';
const B = 'site_bbbbbbbb0002';

describe('reserve', () => {
	it('answers reserved for a free name, and reserved again for the same site', () => {
		const kv = memoryKv();
		expect(reserveIn(kv, 'calm-river-stone', A, NOW)).toBe('reserved');
		expect(reserveIn(kv, 'calm-river-stone', A, NOW + 1)).toBe('reserved');
	});

	it('answers taken for another site', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		expect(reserveIn(kv, 'calm-river-stone', B, NOW)).toBe('taken');
	});

	it('answers reserved-word for every platform word, suffix and pattern', () => {
		const kv = memoryKv();
		const refused = [
			...RESERVED_WORDS.map((word) => word.padEnd(3, 'x')),
			'calm-river-staging',
			'calm-river-dev',
			'calm-river-preview-7',
			'deadbeef-calm-river'
		];
		for (const name of refused) expect(reserveIn(kv, name, A, NOW)).toBe('reserved-word');
		expect(kv.size()).toBe(0);
	});

	it('answers invalid for a name that is not a dns label', () => {
		const kv = memoryKv();
		for (const name of ['', 'ab', 'Calm-River', 'bad--name', '-lead', 'a b c']) {
			expect(reserveIn(kv, name, A, NOW)).toBe('invalid');
		}
		expect(kv.size()).toBe(0);
	});

	it('answers invalid for a name sent to a shard that does not own it', () => {
		const kv = memoryKv();
		const name = 'calm-river-stone';
		const wrong = shardKey(name) === 'shard-0' ? 'shard-1' : 'shard-0';
		expect(reserveIn(kv, name, A, NOW, wrong)).toBe('invalid');
		expect(reserveIn(kv, name, A, NOW, shardKey(name))).toBe('reserved');
	});

	it('gives one winner when many sites reserve one name at once', async () => {
		const kv = memoryKv();
		const answers = await Promise.all(
			Array.from({ length: 50 }, async (_, i) => {
				await Promise.resolve();
				return reserveIn(
					kv,
					'calm-river-stone',
					`site_${String(i).padStart(10, '0')}`,
					NOW
				);
			})
		);
		expect(answers.filter((a) => a === 'reserved')).toHaveLength(1);
		expect(answers.filter((a) => a === 'taken')).toHaveLength(49);
	});

	it('is synchronous, because the read and the write must share one turn of the object', () => {
		for (const fn of [reserveIn, releaseIn, tombstoneIn]) {
			expect(fn.constructor.name).toBe('Function');
		}
	});
});

describe('release and tombstone', () => {
	it('holds a released name for the hold period and frees it after', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		expect(releaseIn(kv, 'calm-river-stone', A, NOW)).toBe('released');
		expect(reserveIn(kv, 'calm-river-stone', A, NOW + 1)).toBe('held');
		expect(reserveIn(kv, 'calm-river-stone', B, NOW + DEFAULT_HOLD_MS - 1)).toBe('held');
		expect(reserveIn(kv, 'calm-river-stone', B, NOW + DEFAULT_HOLD_MS)).toBe('reserved');
	});

	it('honours a custom hold', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		releaseIn(kv, 'calm-river-stone', A, NOW, 1000);
		expect(reserveIn(kv, 'calm-river-stone', B, NOW + 999)).toBe('held');
		expect(reserveIn(kv, 'calm-river-stone', B, NOW + 1000)).toBe('reserved');
	});

	it('frees the name at once for a hold of zero', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		expect(releaseIn(kv, 'calm-river-stone', A, NOW, 0)).toBe('released');
		expect(reserveIn(kv, 'calm-river-stone', B, NOW)).toBe('reserved');
	});

	it('clamps a hold below zero to zero and one above the maximum to the maximum', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		releaseIn(kv, 'calm-river-stone', A, NOW, -5_000);
		expect(reserveIn(kv, 'calm-river-stone', B, NOW)).toBe('reserved');
		releaseIn(kv, 'calm-river-stone', B, NOW, MAX_HOLD_MS * 10);
		expect(reserveIn(kv, 'calm-river-stone', A, NOW + MAX_HOLD_MS - 1)).toBe('held');
		expect(reserveIn(kv, 'calm-river-stone', A, NOW + MAX_HOLD_MS)).toBe('reserved');
	});

	it('gives a hold that is not a number the default', () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(clampHold(bad)).toBe(DEFAULT_HOLD_MS);
		}
		expect([clampHold(0), clampHold(-1), clampHold(MAX_HOLD_MS + 1), clampHold(7)]).toEqual([
			0,
			0,
			MAX_HOLD_MS,
			7
		]);
		expect(DEFAULT_HOLD_MS).toBeLessThanOrEqual(MAX_HOLD_MS);
	});

	it('never issues a tombstoned name again', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		expect(tombstoneIn(kv, 'calm-river-stone', A)).toBe('tombstoned');
		for (const years of [0, 1, 10, 1000]) {
			const later = NOW + years * 365 * 86_400_000;
			expect(reserveIn(kv, 'calm-river-stone', A, later)).toBe('held');
			expect(reserveIn(kv, 'calm-river-stone', B, later)).toBe('held');
		}
	});

	it('refuses to release or tombstone a name the site does not hold', () => {
		const kv = memoryKv();
		reserveIn(kv, 'calm-river-stone', A, NOW);
		expect(releaseIn(kv, 'calm-river-stone', B, NOW)).toBe('not-owner');
		expect(tombstoneIn(kv, 'calm-river-stone', B)).toBe('not-owner');
		expect(releaseIn(kv, 'quiet-oak-hill', A, NOW)).toBe('unknown');
		expect(tombstoneIn(kv, 'quiet-oak-hill', A)).toBe('unknown');
		releaseIn(kv, 'calm-river-stone', A, NOW);
		expect(releaseIn(kv, 'calm-river-stone', A, NOW)).toBe('not-owner');
		expect(tombstoneIn(kv, 'calm-river-stone', A)).toBe('not-owner');
	});
});

describe('guard: the registry and the reserved rules agree', () => {
	it('refuses exactly the names isReserved refuses and stores nothing it refuses', () => {
		const kv = memoryKv();
		const samples = [
			...RESERVED_WORDS,
			'calm-river-staging',
			'x-dev',
			'calm-preview-12',
			'0123abcd-calm-river',
			'calm-river-previews',
			'devx-river-stone',
			...Array.from({ length: 300 }, (_, i) => suggest(`sample-${i}`))
		];
		let stored = 0;
		for (const name of samples) {
			const answer = reserveIn(kv, name, A, NOW);
			if (answer === 'invalid') continue;
			expect(answer === 'reserved-word', name).toBe(isReserved(name));
			if (answer === 'reserved') stored++;
		}
		expect(kv.size()).toBe(stored);
	});

	it('accepts every suggestion', () => {
		const kv = memoryKv();
		for (let i = 0; i < 500; i++) {
			const name = suggest(`seed-${i}`);
			expect(reserveIn(kv, name, A, NOW, shardKey(name))).toBe('reserved');
		}
	});
});
