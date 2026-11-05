import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, createCollegeDB } from '../../../src/server/db/collegedb';
import { SCHEMA_VERSION, SchemaVersionError, TABLES } from '../../../src/server/db/schema';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
});

afterAll(() => harness.close());

async function storedVersion(): Promise<string | null> {
	const row = await env.DB.prepare(
		`SELECT value FROM schema_meta WHERE key = 'schema_version'`
	).first<{ value: string }>();
	return row?.value ?? null;
}

describe('applySchema on D1', () => {
	it('runs twice without error and records the schema version', async () => {
		const db = createCollegeDB(env);
		await applySchema(db);
		await applySchema(db);
		expect(await storedVersion()).toBe(String(SCHEMA_VERSION));
	});

	it('gives every table exactly the columns its Drizzle definition names', async () => {
		for (const table of TABLES) {
			const { name, columns } = getTableConfig(table);
			const { results } = await env.DB.prepare('SELECT name FROM pragma_table_info(?)')
				.bind(name)
				.all<{ name: string }>();
			expect(results.map((row) => row.name).sort()).toEqual(
				columns.map((column) => column.name).sort()
			);
		}
	});

	it('refuses a shard that records a newer schema and leaves the version unchanged', async () => {
		const newer = String(SCHEMA_VERSION + 1);
		await env.DB.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`)
			.bind(newer)
			.run();
		try {
			await expect(applySchema(createCollegeDB(env))).rejects.toBeInstanceOf(
				SchemaVersionError
			);
			expect(await storedVersion()).toBe(newer);
		} finally {
			await env.DB.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`)
				.bind(String(SCHEMA_VERSION))
				.run();
		}
	});
});

describe('audit_log is append-only', () => {
	it('rejects UPDATE and DELETE on rows that were written', async () => {
		await applySchema(createCollegeDB(env));
		const organizationId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO audit_log (organization_id, seq, prev_hash, hash, actor, action,
			 target, detail, created_at) VALUES (?, 0, '', 'h', 'a', 'x', 't', '{}', 1)`
		)
			.bind(organizationId)
			.run();
		await expect(
			env.DB.prepare('UPDATE audit_log SET actor = ? WHERE organization_id = ?')
				.bind('b', organizationId)
				.run()
		).rejects.toThrow(/append-only/);
		await expect(
			env.DB.prepare('DELETE FROM audit_log WHERE organization_id = ?')
				.bind(organizationId)
				.run()
		).rejects.toThrow(/append-only/);
	});
});
