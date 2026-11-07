import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { SCHEMA_VERSION, SchemaVersionError, TABLES } from '../../../src/server/db/schema';
import {
	createSchemaGate,
	loadSchema,
	requireSchema,
	SCHEMA_UNAVAILABLE
} from '../../../src/server/db/schema-gate';
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

	it('skips the DDL while the stored hash matches and runs it again when the hash differs', async () => {
		const exists = async () =>
			(await env.DB.prepare(
				`SELECT 1 FROM sqlite_master WHERE name = 'single_use'`
			).first()) !== null;
		const db = createCollegeDB(env);
		await applySchema(db);
		await env.DB.prepare('DROP TABLE single_use').run();
		await applySchema(db);
		expect(await exists()).toBe(false);
		await env.DB.prepare(
			`UPDATE schema_meta SET value = 'old' WHERE key = 'schema_hash'`
		).run();
		await applySchema(db);
		expect(await exists()).toBe(true);
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

describe('the schema gate fails closed', () => {
	const setVersion = (value: string) =>
		env.DB.prepare(`UPDATE schema_meta SET value = ? WHERE key = 'schema_version'`)
			.bind(value)
			.run();

	async function gateOutcome() {
		const gate = createSchemaGate(loadSchema);
		return requireSchema(gate, env).then(
			() => 'open' as const,
			(error: unknown) => error
		);
	}

	it('opens when every shard holds the version this code reads', async () => {
		await ensureCollegeDB(env);
		expect(await gateOutcome()).toBe('open');
	});

	it('answers a typed 503 when a shard records a newer version', async () => {
		await ensureCollegeDB(env);
		await setVersion(String(SCHEMA_VERSION + 1));
		try {
			expect(await gateOutcome()).toMatchObject({
				statusCode: 503,
				data: { code: SCHEMA_UNAVAILABLE }
			});
		} finally {
			await setVersion(String(SCHEMA_VERSION));
		}
	});

	it('answers a typed 503 when the version row is gone', async () => {
		await ensureCollegeDB(env);
		await env.DB.prepare(`DELETE FROM schema_meta WHERE key = 'schema_version'`).run();
		try {
			expect(await gateOutcome()).toMatchObject({
				statusCode: 503,
				data: { code: SCHEMA_UNAVAILABLE }
			});
		} finally {
			await applySchema(createCollegeDB(env));
		}
		expect(await gateOutcome()).toBe('open');
	});

	it('answers a typed 503 when the version read itself fails', async () => {
		await ensureCollegeDB(env);
		await env.DB.prepare('ALTER TABLE schema_meta RENAME TO schema_meta_gone').run();
		try {
			expect(await gateOutcome()).toMatchObject({ statusCode: 503 });
		} finally {
			await env.DB.prepare('ALTER TABLE schema_meta_gone RENAME TO schema_meta').run();
		}
		expect(await gateOutcome()).toBe('open');
	});

	it('answers 503 for a version row that is not a number', async () => {
		await ensureCollegeDB(env);
		await setVersion('one');
		try {
			expect(await gateOutcome()).toMatchObject({ statusCode: 503 });
		} finally {
			await setVersion(String(SCHEMA_VERSION));
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
