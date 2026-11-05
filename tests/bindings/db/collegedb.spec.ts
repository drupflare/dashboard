import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIRECTORY_KEY, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { type Bindings, type OpenBindings, openBindings, TWO_SHARD_CONFIG } from '../support';

async function idsOn(database: D1Database, table: string): Promise<string[]> {
	const { results } = await database.prepare(`SELECT id FROM ${table}`).all<{ id: string }>();
	return results.map((row) => row.id);
}

describe('ensureCollegeDB on one shard', () => {
	let harness: OpenBindings;
	let env: Bindings;

	beforeAll(async () => {
		harness = await openBindings();
		env = harness.env;
	});

	afterAll(() => harness.close());

	it('returns the same client for the same env and leaves the schema in place', async () => {
		const first = await ensureCollegeDB(env);
		const second = await ensureCollegeDB(env);
		expect(second).toBe(first);
		const row = await env.DB.prepare(
			`SELECT value FROM schema_meta WHERE key = 'schema_version'`
		).first();
		expect(row).not.toBeNull();
	});
});

describe('ensureCollegeDB on two shards', () => {
	let harness: OpenBindings;
	let env: Bindings;

	beforeAll(async () => {
		harness = await openBindings(TWO_SHARD_CONFIG);
		env = harness.env;
	});

	afterAll(() => harness.close());

	it('spreads organisations over both shards and keeps each one on a single shard', async () => {
		const db = await ensureCollegeDB(env);
		const orgIds = Array.from({ length: 40 }, () => crypto.randomUUID());
		for (const id of orgIds) {
			await db.run(
				id,
				`INSERT INTO organizations (id, name, personal, created_by, created_at, updated_at)
				 VALUES (?, ?, 0, ?, 1, 1)`,
				[id, 'Org', 'user']
			);
		}
		const onOne = await idsOn(env.DB, 'organizations');
		const onTwo = await idsOn(env.DB_2 as D1Database, 'organizations');
		expect(onOne.length).toBeGreaterThan(0);
		expect(onTwo.length).toBeGreaterThan(0);
		expect(onOne.filter((id) => onTwo.includes(id))).toEqual([]);
		expect([...onOne, ...onTwo].sort()).toEqual([...orgIds].sort());
	});

	it('keeps the directory rows on a single shard', async () => {
		const db = await ensureCollegeDB(env);
		await db.run(
			DIRECTORY_KEY,
			'INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, NULL, 1, 1)',
			[crypto.randomUUID(), `directory-${crypto.randomUUID()}@example.test`]
		);
		const onOne = await idsOn(env.DB, 'users');
		const onTwo = await idsOn(env.DB_2 as D1Database, 'users');
		expect(onOne.length + onTwo.length).toBeGreaterThan(0);
		expect(onOne.length === 0 || onTwo.length === 0).toBe(true);
	});
});
