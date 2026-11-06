import { describe, expect, it } from 'vitest';
import {
	NoShardsError,
	discoverShards,
	isUniqueViolation
} from '../../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../../src/server/db/repos/atomic-shards';

const fakeD1 = () => ({ prepare: () => undefined });

describe('withAtomicBatch', () => {
	function recordingD1() {
		const calls: { sql: string; bindings: unknown[] }[] = [];
		const batches: number[] = [];
		const d1 = {
			marker: 'raw',
			prepare(sql: string) {
				return {
					bind: (...bindings: unknown[]) => {
						calls.push({ sql, bindings });
						return { sql, bindings };
					}
				};
			},
			async batch(statements: unknown[]) {
				batches.push(statements.length);
				return statements.map(() => ({ results: [], success: true, meta: { changes: 1 } }));
			},
			describe() {
				return this.marker;
			}
		};
		return { d1, calls, batches };
	}

	it('gives each shard a runBatch that sends one D1 batch and declares it atomic', async () => {
		const { d1, calls, batches } = recordingD1();
		const env = withAtomicBatch({ KV: {}, DB: d1, OTHER: 'kept' } as never);
		const shard = discoverShards(env).DB as unknown as {
			runBatch(statements: { sql: string; bindings?: unknown[] }[]): Promise<unknown[]>;
			atomicBatch: boolean;
		};
		expect(shard.atomicBatch).toBe(true);
		const results = await shard.runBatch([
			{ sql: 'INSERT 1', bindings: [1, 'a'] },
			{ sql: 'INSERT 2' }
		]);
		expect(results).toHaveLength(2);
		expect(batches).toEqual([2]);
		expect(calls).toEqual([
			{ sql: 'INSERT 1', bindings: [1, 'a'] },
			{ sql: 'INSERT 2', bindings: [] }
		]);
		expect(env.OTHER).toBe('kept');
	});

	it('still behaves as the binding for everything else, with the binding as this', () => {
		const { d1 } = recordingD1();
		const env = withAtomicBatch({ KV: {}, DB: d1 } as never);
		const shard = discoverShards(env).DB as unknown as { describe(): string; marker: string };
		expect(shard.describe()).toBe('raw');
		expect(shard.marker).toBe('raw');
	});

	it('wraps once per env, so the client caches are shared', () => {
		const env = { KV: {}, DB: fakeD1() } as never;
		expect(withAtomicBatch(env)).toBe(withAtomicBatch(env));
	});

	it('reaches every numbered shard and leaves the original env untouched', () => {
		const original = { KV: {}, DB: fakeD1(), DB_2: fakeD1() };
		const env = withAtomicBatch(original as never);
		expect(Object.keys(discoverShards(env))).toEqual(['DB', 'DB_2']);
		expect(env.DB).not.toBe(original.DB);
		expect((original.DB as { atomicBatch?: boolean }).atomicBatch).toBeUndefined();
	});
});

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
