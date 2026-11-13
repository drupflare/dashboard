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
import { IMPORT_CREDENTIAL_SQL } from '../../../../src/shared/custody/import-credentials';

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

describe('import_credentials and imported_from', () => {
	it('gives the table the columns the shared statements name, and sites an imported_from column', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		expect(columnsOf(db, 'import_credentials').map((c) => c.name)).toEqual(
			[
				'id',
				'organization_id',
				'user_id',
				'key_envelope',
				'public_key',
				'host',
				'port',
				'username',
				'host_key_fingerprint',
				'host_key_type',
				'created_at',
				'expires_at',
				'used_at'
			].sort()
		);
		expect(columnsOf(db, 'sites').map((c) => c.name)).toContain('imported_from');
		expect(getTableConfig(sites).columns.map((c) => c.name)).toContain('imported_from');
	});

	it('gives sites a nullable node_id the self-hosted site map reads', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		expect(columnsOf(db, 'sites').find((c) => c.name === 'node_id')).toMatchObject({
			notnull: 0
		});
		expect(getTableConfig(sites).columns.map((c) => c.name)).toContain('node_id');
	});

	it('gives the run table the columns the engine writes and the usage check reads', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		expect(columnsOf(db, 'import_runs').map((c) => c.name)).toEqual(
			['operation_id', 'organization_id', 'started_at', 'ended_at', 'wall_ms'].sort()
		);
	});

	it('gives the domain ledger one row per hostname and an epoch that starts at 1', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		expect(columnsOf(db, 'custom_domains').map((c) => c.name)).toEqual(
			[
				'hostname',
				'organization_id',
				'site_id',
				'operation_id',
				'epoch',
				'state',
				'provider_id',
				'ownership_epoch',
				'created_at',
				'updated_at'
			].sort()
		);
		const insert = (hostname: string, epoch: number, state: string) =>
			db
				.prepare(
					`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
					state, provider_id, created_at, updated_at) VALUES (?, 'o', 's', 'op', ?, ?, NULL, 1, 1)`
				)
				.run(hostname, epoch, state);
		insert('a.example.test', 1, 'claimed');
		expect(() => insert('a.example.test', 2, 'claimed')).toThrow();
		expect(() => insert('b.example.test', 0, 'claimed')).toThrow();
		expect(() => insert('c.example.test', 1, 'lost')).toThrow();
	});

	it('runs the statements the dashboard and the engine share against it', () => {
		const db = new DatabaseSync(':memory:');
		applyAll(db);
		db.prepare(IMPORT_CREDENTIAL_SQL.insert).run(
			'imc_1',
			'org_a',
			'usr_1',
			'{}',
			'ssh-ed25519 AAAA x',
			'host.example',
			22,
			'deploy',
			1,
			100
		);
		expect(db.prepare(IMPORT_CREDENTIAL_SQL.select).get('org_a', 'imc_1')).toMatchObject({
			host: 'host.example',
			host_key_fingerprint: null
		});
		expect(db.prepare(IMPORT_CREDENTIAL_SQL.select).get('org_b', 'imc_1')).toBeUndefined();
		const first = db
			.prepare(IMPORT_CREDENTIAL_SQL.confirmHostKey)
			.run('SHA256:a', 'ssh-ed25519', 'org_a', 'imc_1');
		const second = db
			.prepare(IMPORT_CREDENTIAL_SQL.confirmHostKey)
			.run('SHA256:b', 'ssh-ed25519', 'org_a', 'imc_1');
		expect([Number(first.changes), Number(second.changes)]).toEqual([1, 0]);
		expect(
			db.prepare('SELECT host_key_fingerprint AS f FROM import_credentials').get()
		).toEqual({
			f: 'SHA256:a'
		});
		expect(db.prepare(IMPORT_CREDENTIAL_SQL.expired).all(100)).toHaveLength(1);
		expect(db.prepare(IMPORT_CREDENTIAL_SQL.expired).all(99)).toHaveLength(0);
		expect(Number(db.prepare(IMPORT_CREDENTIAL_SQL.purge).run('imc_1', 99).changes)).toBe(0);
		expect(Number(db.prepare(IMPORT_CREDENTIAL_SQL.purge).run('imc_1', 100).changes)).toBe(1);
	});
});
