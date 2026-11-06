import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { OPERATION_STATUSES, OPERATION_TYPES } from '../../../../contracts/src/operations';
import { RESOURCE_KINDS } from '../../../../engine/src/provision-plan';
import {
	SCHEMA_STATEMENTS,
	SCHEMA_TRIGGERS,
	SCHEMA_VERSION,
	SITE_RESOURCE_KINDS,
	SchemaVersionError,
	checkSchemaVersion,
	operationSteps,
	operations,
	requireSchemaVersion,
	siteDiscovery,
	siteResources,
	sites
} from '../../../../src/server/db/schema';

describe('requireSchemaVersion', () => {
	it('accepts only the version this code reads', () => {
		expect(() => requireSchemaVersion(String(SCHEMA_VERSION))).not.toThrow();
	});

	it.each([null, '0', String(SCHEMA_VERSION + 1), 'one', ''])(
		'refuses a stored version of %j, so a missing or foreign row stops the isolate',
		(stored) => {
			expect(() => requireSchemaVersion(stored)).toThrow(SchemaVersionError);
		}
	);
});

describe('checkSchemaVersion', () => {
	it('accepts no stored version and any version up to the code version', () => {
		expect(() => checkSchemaVersion(null)).not.toThrow();
		expect(() => checkSchemaVersion('0')).not.toThrow();
		expect(() => checkSchemaVersion(String(SCHEMA_VERSION))).not.toThrow();
	});

	it('refuses a newer version', () => {
		expect(() => checkSchemaVersion(String(SCHEMA_VERSION + 1))).toThrow(SchemaVersionError);
	});

	it('refuses a stored value that is not a whole number', () => {
		expect(() => checkSchemaVersion('')).toThrow(SchemaVersionError);
		expect(() => checkSchemaVersion('one')).toThrow(SchemaVersionError);
		expect(() => checkSchemaVersion('1.5')).toThrow(SchemaVersionError);
	});
});

describe('schema statements', () => {
	it('creates every object only when it is missing', () => {
		const all = [...SCHEMA_STATEMENTS, ...SCHEMA_TRIGGERS];
		expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(0);
		for (const statement of all) {
			expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX|TRIGGER) IF NOT EXISTS /);
		}
	});

	it('keeps semicolons out of the batch that collegedb splits', () => {
		for (const statement of SCHEMA_STATEMENTS) expect(statement).not.toContain(';');
	});
});

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
	return (
		db
			.prepare('SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)')
			.all(table) as ColumnInfo[]
	).sort((a, b) => a.name.localeCompare(b.name));
}

function applyAll(db: DatabaseSync): void {
	for (const statement of [...SCHEMA_STATEMENTS, ...SCHEMA_TRIGGERS]) db.exec(statement);
}

describe('operation and site resource tables', () => {
	it('applies twice on an empty database and gives each table the columns its definition names', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		applyAll(db);
		for (const table of [sites, operations, operationSteps, siteResources, siteDiscovery]) {
			const { name, columns } = getTableConfig(table);
			expect(columnsOf(db, name).map((c) => c.name)).toEqual(
				columns.map((c) => c.name).sort()
			);
		}
	});

	it('refuses a category or config outside the contract', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		const insert = (category: string, config: string) =>
			db
				.prepare(
					`INSERT INTO sites (id, organization_id, name, plane, state, category, config,
					 created_at, updated_at) VALUES (?, 'o', 'n', 'managed', 'active', ?, ?, 1, 1)`
				)
				.run(`s_${category}_${config}`, category, config);
		expect(() => insert('workers', 'managed')).not.toThrow();
		expect(() => insert('servers', 'managed')).toThrow(/CHECK/);
		expect(() => insert('cms', 'free')).toThrow(/CHECK/);
	});

	it('defaults a site to drupal and refuses a kind outside the contract', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		db.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
			 VALUES ('site_kind', 'o', 'n', 'managed', 'active', 1, 1)`
		).run();
		expect(db.prepare('SELECT kind, ready_at, primary_hostname FROM sites').get()).toEqual({
			kind: 'drupal',
			ready_at: null,
			primary_hostname: null
		});
		expect(() =>
			db
				.prepare(
					`INSERT INTO sites (id, organization_id, name, plane, state, kind, created_at, updated_at)
					 VALUES ('site_bad', 'o', 'n', 'managed', 'active', 'wordpress', 1, 1)`
				)
				.run()
		).toThrow(/CHECK/);
	});

	it('accepts every operation type and status of the contract and refuses any other', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		const insert = db.prepare(
			`INSERT INTO operations (id, organization_id, type, status, idempotency_key, target_ids,
			 preconditions, plan_digest, fencing_epoch, blast_radius, verification, budget,
			 created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, '[]', '[]', 'sha256:x', 0, '{}', 'pending', '{}', 1, 1)`
		);
		for (const type of OPERATION_TYPES)
			insert.run(`op_${type}`, 'org_a', type, 'planned', type);
		for (const status of OPERATION_STATUSES) {
			insert.run(`op_${status}`, 'org_a', 'site.create', status, `key-${status}`);
		}
		expect(() => insert.run('op_bad', 'org_a', 'site.explode', 'planned', 'k1')).toThrow(
			/CHECK/
		);
		expect(() => insert.run('op_bad', 'org_a', 'site.create', 'lost', 'k2')).toThrow(/CHECK/);
	});

	it('keeps one idempotency key per organization and one position per step', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		const op = db.prepare(
			`INSERT INTO operations (id, organization_id, type, status, idempotency_key, target_ids,
			 preconditions, plan_digest, fencing_epoch, blast_radius, verification, budget,
			 created_at, updated_at)
			 VALUES (?, ?, 'site.create', 'planned', ?, '[]', '[]', 'sha256:x', 0, '{}', 'pending', '{}', 1, 1)`
		);
		op.run('op_1', 'org_a', 'k');
		expect(() => op.run('op_2', 'org_a', 'k')).toThrow(/UNIQUE/);
		expect(() => op.run('op_3', 'org_b', 'k')).not.toThrow();
		const step = db.prepare(
			`INSERT INTO operation_steps (operation_id, id, position, name, state)
			 VALUES ('op_1', ?, ?, 'n', 'pending')`
		);
		step.run('a', 0);
		expect(() => step.run('b', 0)).toThrow(/UNIQUE/);
		expect(() => step.run('a', 1)).toThrow(/UNIQUE/);
		expect(() => step.run('b', 1)).not.toThrow();
	});

	it('holds one live resource per site binding and never repeats a provider id in an account', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		const resource = db.prepare(
			`INSERT INTO site_resources (id, site_id, account_id, kind, binding, name, provider_id,
			 created_by_operation, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 'n', ?, 'op_1', 1, ?)`
		);
		resource.run('r1', 'site_a', 'acct', 'kv', 'CONFIG_KV', 'kv-1', null);
		expect(() => resource.run('r2', 'site_a', 'acct', 'kv', 'CONFIG_KV', 'kv-2', null)).toThrow(
			/UNIQUE/
		);
		expect(() => resource.run('r3', 'site_a', 'acct', 'kv', 'CONFIG_KV', 'kv-1', 5)).toThrow(
			/UNIQUE/
		);
		expect(() =>
			resource.run('r4', 'site_a', 'acct', 'kv', 'PAGE_KV', 'kv-3', null)
		).not.toThrow();
		expect(() =>
			resource.run('r5', 'site_b', 'acct2', 'kv', 'CONFIG_KV', 'kv-1', null)
		).not.toThrow();
		db.prepare(`UPDATE site_resources SET deleted_at = 9 WHERE id = 'r1'`).run();
		expect(() =>
			resource.run('r6', 'site_a', 'acct', 'kv', 'CONFIG_KV', 'kv-9', null)
		).not.toThrow();
		expect(() => resource.run('r7', 'site_a', 'acct', 'queue', 'Q', 'q-1', null)).toThrow(
			/CHECK/
		);
	});

	it('lists the same resource kinds as the provisioning plan', () => {
		expect([...SITE_RESOURCE_KINDS]).toEqual([...RESOURCE_KINDS]);
	});
});
