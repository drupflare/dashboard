import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	BILLING_SCHEMA_STATEMENTS,
	BILLING_TABLES
} from '../../../../src/server/db/billing-schema';

function applied(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	for (const statement of BILLING_SCHEMA_STATEMENTS) db.exec(statement);
	return db;
}

describe('billing schema', () => {
	it('creates every object only when it is missing and keeps semicolons out', () => {
		for (const statement of BILLING_SCHEMA_STATEMENTS) {
			expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
			expect(statement).not.toContain(';');
		}
	});

	it('applies twice and gives each table the columns its definition names', () => {
		const db = applied();
		for (const statement of BILLING_SCHEMA_STATEMENTS) db.exec(statement);
		for (const table of BILLING_TABLES) {
			const { name, columns } = getTableConfig(table);
			const present = (
				db.prepare('SELECT name FROM pragma_table_info(?)').all(name) as { name: string }[]
			)
				.map((c) => c.name)
				.sort();
			expect(present).toEqual(columns.map((c) => c.name).sort());
		}
	});

	it('refuses a status, an entitlement state or a review reason outside the lists', () => {
		const db = applied();
		const insert = (status: string, state: string, review: string | null) =>
			db
				.prepare(
					`INSERT INTO billing_accounts (organization_id, plan_id, add_ons, status,
					 entitlement_state, revision, last_event_at, review_reason, created_at, updated_at)
					 VALUES (?, 'managed-free', '[]', ?, ?, 0, 0, ?, 1, 1)`
				)
				.run(`org-${status}-${state}-${review}`, status, state, review);
		expect(() => insert('active', 'activated', null)).not.toThrow();
		expect(() => insert('active', 'activated', 'refunded')).not.toThrow();
		expect(() => insert('paid', 'activated', null)).toThrow(/CHECK/);
		expect(() => insert('active', 'live', null)).toThrow(/CHECK/);
		expect(() => insert('active', 'activated', 'angry')).toThrow(/CHECK/);
	});

	it('keeps one row per organisation, customer and event', () => {
		const db = applied();
		db.prepare(`INSERT INTO billing_customers VALUES ('cus_1', 'org-1')`).run();
		expect(() =>
			db.prepare(`INSERT INTO billing_customers VALUES ('cus_1', 'org-2')`).run()
		).toThrow(/UNIQUE/);
		db.prepare(`INSERT INTO stripe_events VALUES ('evt_1', 'invoice.paid', 1)`).run();
		expect(() =>
			db.prepare(`INSERT INTO stripe_events VALUES ('evt_1', 'invoice.paid', 2)`).run()
		).toThrow(/UNIQUE/);
	});

	it('keeps one credit per source id and refuses a credit of no units', () => {
		const db = applied();
		const credit = (source: string, units: number) =>
			db
				.prepare(`INSERT INTO billing_credits VALUES (?, 'org-1', 'support-hours', ?, 1)`)
				.run(source, units);
		credit('evt_1', 5);
		expect(() => credit('evt_1', 5)).toThrow(/UNIQUE/);
		expect(() => credit('evt_2', 0)).toThrow(/CHECK/);
		expect(() => credit('evt_3', -1)).toThrow(/CHECK/);
		const rows = db.prepare('SELECT count(*) AS n FROM billing_credits').get() as { n: number };
		expect(rows.n).toBe(1);
	});
});
