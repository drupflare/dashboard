import { describe, expect, it } from 'vitest';
import {
	ADJECTIVES,
	generateName,
	generateUniqueName,
	hashName,
	isReserved,
	isValidName,
	NAME_SHARDS,
	NameExhaustedError,
	NOUNS,
	RESERVED_WORDS,
	shardKey,
	shardOf,
	suffixOwner,
	suggest
} from '../../../src/shared/names';

function seeded(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('word lists', () => {
	it('are lowercase ascii, unique and at least 150 long', () => {
		for (const list of [ADJECTIVES, NOUNS]) {
			expect(list.length).toBeGreaterThanOrEqual(150);
			expect(new Set(list).size).toBe(list.length);
			for (const word of list) expect(word).toMatch(/^[a-z]+$/);
		}
	});

	it('contain no reserved word, no reserved suffix word and no hash-shaped word', () => {
		const banned = new Set<string>([...RESERVED_WORDS, 'dev', 'staging', 'preview']);
		for (const word of [...ADJECTIVES, ...NOUNS]) {
			expect(banned.has(word)).toBe(false);
			expect(word).not.toMatch(/^[0-9a-f]{8}$/);
		}
	});
});

describe('generateName', () => {
	it('returns three valid, unreserved words in adjective-noun-noun order', () => {
		const random = seeded(1);
		for (let i = 0; i < 200; i++) {
			const name = generateName(random);
			const [adjective, first, second, ...rest] = name.split('-');
			expect(rest).toHaveLength(0);
			expect(ADJECTIVES).toContain(adjective);
			expect(NOUNS).toContain(first);
			expect(NOUNS).toContain(second);
			expect(first).not.toBe(second);
			expect(isValidName(name)).toBe(true);
			expect(isReserved(name)).toBe(false);
		}
	});

	it('still returns a name when the source repeats its lowest value', () => {
		const name = generateName(() => 0);
		expect(name.split('-')).toHaveLength(3);
	});
});

describe('generateUniqueName', () => {
	it('stays collision-free across 10,000 draws with a seeded source', () => {
		const random = seeded(42);
		const taken = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			const name = generateUniqueName(random, taken);
			taken.add(name);
			expect(isValidName(name)).toBe(true);
			expect(isReserved(name)).toBe(false);
		}
		expect(taken.size).toBe(10_000);
	});

	it('throws NameExhaustedError when every attempt lands on a taken name', () => {
		const random = () => 0;
		const taken = new Set([generateName(random)]);
		expect(() => generateUniqueName(random, taken)).toThrow(NameExhaustedError);
	});
});

describe('isValidName', () => {
	it('accepts dns labels of 3 to 63 characters without a leading, trailing or double hyphen', () => {
		expect(isValidName('calm-river-stone')).toBe(true);
		expect(isValidName('abc')).toBe(true);
		expect(isValidName('a'.repeat(63))).toBe(true);
	});

	it('rejects uppercase, underscores, short, long and hyphen-misplaced names', () => {
		expect(isValidName('Calm-River')).toBe(false);
		expect(isValidName('calm_river')).toBe(false);
		expect(isValidName('ab')).toBe(false);
		expect(isValidName('a'.repeat(64))).toBe(false);
		expect(isValidName('bad--name')).toBe(false);
		expect(isValidName('-lead')).toBe(false);
		expect(isValidName('trail-')).toBe(false);
	});
});

describe('isReserved and suffixOwner', () => {
	it('reserves the platform words and the customer suffixes and patterns', () => {
		expect(isReserved('api')).toBe(true);
		expect(isReserved('gate')).toBe(true);
		expect(isReserved('calm-river-staging')).toBe(true);
		expect(isReserved('calm-river-dev')).toBe(true);
		expect(isReserved('calm-river-preview-3')).toBe(true);
		expect(isReserved('deadbeef-calm-river')).toBe(true);
		expect(isReserved('deadbeefx-calm')).toBe(false);
		expect(isReserved('calm-river-stone')).toBe(false);
	});

	it('names who may obtain each reserved form', () => {
		for (const word of RESERVED_WORDS) expect(suffixOwner(word)).toBe('nobody');
		expect(suffixOwner('calm-river-staging')).toBe('paid-managed');
		expect(suffixOwner('calm-river-dev')).toBe('paid-managed');
		expect(suffixOwner('calm-river-preview-3')).toBe('paid-managed');
		expect(suffixOwner('deadbeef-calm-river')).toBe('paid-managed');
		expect(suffixOwner('calm-river-stone')).toBe(null);
	});

	it('keeps the plan list of platform words', () => {
		expect(RESERVED_WORDS).toEqual(['app', 'status', 'docs', 'api', 'www', 'admin', 'gate']);
	});
});

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j] as number;
			row[j] = Math.min(
				above + 1,
				(row[j - 1] as number) + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
			);
			diagonal = above;
		}
	}
	return row[b.length] as number;
}

describe('word lists and lookalikes', () => {
	it('keep every word at least two edits from every platform word', () => {
		for (const word of [...ADJECTIVES, ...NOUNS]) {
			for (const reserved of RESERVED_WORDS) {
				expect(distance(word, reserved), `${word} vs ${reserved}`).toBeGreaterThan(1);
			}
		}
	});
});

describe('shardOf and hashName', () => {
	it('is stable, in range, and keyed by the name alone', () => {
		expect(hashName('calm-river-stone')).toBe(hashName('calm-river-stone'));
		expect(shardOf('calm-river-stone')).toBe(shardOf('calm-river-stone'));
		for (let i = 0; i < 2_000; i++) {
			const shard = shardOf(suggest(i));
			expect(Number.isInteger(shard)).toBe(true);
			expect(shard).toBeGreaterThanOrEqual(0);
			expect(shard).toBeLessThan(NAME_SHARDS);
		}
		expect(shardKey('calm-river-stone')).toBe(`shard-${shardOf('calm-river-stone')}`);
	});

	it('reaches every shard across a few thousand names', () => {
		const seen = new Set<number>();
		for (let i = 0; i < 3_000; i++) seen.add(shardOf(suggest(i)));
		expect(seen.size).toBe(NAME_SHARDS);
	});

	it('honours another shard count', () => {
		for (let i = 0; i < 200; i++) expect(shardOf(suggest(i), 3)).toBeLessThan(3);
	});
});

describe('suggest', () => {
	it('is deterministic and builds adjective-noun-noun from the lists', () => {
		expect(suggest('seed')).toBe(suggest('seed'));
		expect(suggest(7)).toBe(suggest('7'));
		const [adjective, first, second, ...rest] = suggest('seed').split('-');
		expect(rest).toHaveLength(0);
		expect(ADJECTIVES).toContain(adjective);
		expect(NOUNS).toContain(first);
		expect(NOUNS).toContain(second);
	});

	it('varies with the seed', () => {
		const names = new Set(Array.from({ length: 200 }, (_, i) => suggest(`v${i}`)));
		expect(names.size).toBeGreaterThan(190);
	});

	it('never returns a reserved or invalid name across 5,000 seeds', () => {
		for (let i = 0; i < 5_000; i++) {
			const name = suggest(i);
			expect(isReserved(name)).toBe(false);
			expect(isValidName(name)).toBe(true);
		}
	});
});
