import { describe, expect, it } from 'vitest';
import {
	NoShardsError,
	discoverShards,
	isUniqueViolation
} from '../../../../src/server/db/collegedb';

const fakeD1 = () => ({ prepare: () => undefined });

describe('discoverShards', () => {
	it('returns the numbered DB bindings and ignores everything else', () => {
		const env = {
			KV: {},
			DB: fakeD1(),
			DB_2: fakeD1(),
			DB_3: 'not a database',
			DB_EAST: fakeD1(),
			DBX: fakeD1()
		};
		expect(Object.keys(discoverShards(env))).toEqual(['DB', 'DB_2']);
	});

	it('throws NoShardsError when no DB binding is present', () => {
		expect(() => discoverShards({ KV: {} })).toThrow(NoShardsError);
	});
});

describe('isUniqueViolation', () => {
	it('recognises the D1 unique constraint message', () => {
		const unique = new Error(
			'D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT'
		);
		expect(isUniqueViolation(unique)).toBe(true);
		expect(isUniqueViolation(new Error('D1_ERROR: no such table: users'))).toBe(false);
		expect(isUniqueViolation('UNIQUE constraint failed')).toBe(false);
	});
});
