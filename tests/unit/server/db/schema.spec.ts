import { describe, expect, it } from 'vitest';
import {
	SCHEMA_STATEMENTS,
	SCHEMA_TRIGGERS,
	SCHEMA_VERSION,
	SchemaVersionError,
	checkSchemaVersion
} from '../../../../src/server/db/schema';

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
