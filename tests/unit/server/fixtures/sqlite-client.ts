import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA_STATEMENTS, SCHEMA_TRIGGERS } from '../../../../src/server/db/schema';

// the schema on an in-memory SQLite, behind the first, all and run calls the repos make
export function sqliteClient(): { raw: DatabaseSync; client: CollegeDBClient } {
	const raw = new DatabaseSync(':memory:');
	for (const statement of [...SCHEMA_STATEMENTS, ...SCHEMA_TRIGGERS]) raw.exec(statement);
	const client = {
		async first(_organizationId: string, sql: string, params: SQLInputValue[] = []) {
			return raw.prepare(sql).get(...params) ?? null;
		},
		async all(_organizationId: string, sql: string, params: SQLInputValue[] = []) {
			return { results: raw.prepare(sql).all(...params) };
		},
		async run(_organizationId: string, sql: string, params: SQLInputValue[] = []) {
			const result = raw.prepare(sql).run(...params);
			return { meta: { changes: Number(result.changes) } };
		}
	};
	return { raw, client: client as unknown as CollegeDBClient };
}

export function addReadySite(raw: DatabaseSync, organizationId: string, id: string): void {
	raw.prepare(
		`INSERT INTO sites (id, organization_id, name, plane, state, ready_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'managed', 'active', 1, 1, 1)`
	).run(id, organizationId, id);
}

export function addBackup(
	raw: DatabaseSync,
	row: {
		id: string;
		organizationId: string;
		siteId: string;
		createdAt: number;
		verified?: 0 | 1;
		label?: string | null;
	}
): void {
	raw.prepare(
		`INSERT INTO backups (id, site_id, organization_id, operation_id, bytes, sha256, parts,
				restorable, verified, label, created_at)
			 VALUES (?, ?, ?, ?, 1024, 'abc', 1, 1, ?, ?, ?)`
	).run(
		row.id,
		row.siteId,
		row.organizationId,
		`op_${row.id}`,
		row.verified ?? 0,
		row.label ?? null,
		row.createdAt
	);
}
