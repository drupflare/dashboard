import { describe, expect, it } from 'vitest';
import { SCHEMA_STATEMENTS } from '../../../src/server/db/schema';
import {
	CHECK_OPTIONS,
	isClassified,
	MASK,
	maskRow,
	SENSITIVE_NAME
} from '../../../src/server/domain/db-console';
import {
	capped,
	checkStatement,
	MAX_STATEMENT_CHARS,
	ROW_CAP
} from '../../../src/server/domain/sql-allow';

const check = (sql: string) => checkStatement(sql, CHECK_OPTIONS);

const HOSTILE: Record<string, string> = {
	'stacked drop': 'SELECT 1; DROP TABLE users',
	'stacked select': 'SELECT 1; SELECT 2',
	'double semicolon': 'SELECT 1;;',
	'trailing comment after semicolon': 'SELECT 1; -- x',
	'leading semicolon': ';SELECT 1',
	'stacked delete after a string': "SELECT 'a'; DELETE FROM sites",
	'spaced update': "SELECT 1 ; UPDATE sites SET name = 'x'",
	'newline insert': 'SELECT 1\n;\nINSERT INTO users VALUES (1)',
	'tab hidden drop': 'SELECT 1;\n\tDROP TABLE x',
	'mixed case drop': 'SELECT 1; dRoP table x',
	'line comment hides a drop': 'SELECT 1 -- ; DROP TABLE x',
	'block comment': 'SELECT 1 /* x */',
	'comment as whitespace': 'SELECT/**/1',
	'conditional comment': 'SELECT 1 /*! DROP TABLE x */',
	'empty line comment': 'SELECT 1 --',
	'leading comment': '/* hi */ SELECT 1',
	'comment inside a keyword': 'SEL/**/ECT 1',
	'unclosed block comment': 'SELECT 1 /* ; DELETE FROM sites',
	delete: 'DELETE FROM sites',
	insert: 'INSERT INTO sites VALUES (1)',
	update: "UPDATE sites SET name = 'x'",
	replace: 'REPLACE INTO sites VALUES (1)',
	drop: 'DROP TABLE sites',
	create: 'CREATE TABLE x (a)',
	alter: 'ALTER TABLE sites ADD COLUMN x',
	'write inside exists': 'SELECT 1 WHERE EXISTS (DELETE FROM sites)',
	vacuum: 'VACUUM',
	reindex: 'REINDEX',
	analyze: 'ANALYZE',
	begin: 'BEGIN',
	commit: 'COMMIT',
	rollback: 'ROLLBACK',
	savepoint: 'SAVEPOINT a',
	release: 'RELEASE a',
	pragma: 'PRAGMA table_info(sites)',
	'pragma table function': "SELECT * FROM pragma_table_info('sites')",
	'quoted pragma table function': `SELECT * FROM "pragma_table_info"('sites')`,
	'writable schema': 'PRAGMA writable_schema = 1',
	attach: "ATTACH DATABASE 'x.db' AS x",
	'stacked attach': "SELECT 1; ATTACH 'x' AS y",
	detach: 'DETACH DATABASE x',
	load_extension: "SELECT load_extension('x')",
	'LOAD_EXTENSION upper case': "SELECT LOAD_EXTENSION('/lib/x.so')",
	'cte then delete': 'WITH x AS (SELECT 1) DELETE FROM sites',
	'plain cte': 'WITH x AS (SELECT 1) SELECT * FROM x',
	'recursive cte bomb':
		'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c',
	'recursive cte in a subquery':
		'SELECT * FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)',
	'lower case cte insert': 'with x as (select 1) insert into sites select * from x',
	'update sqlite_master': "UPDATE sqlite_master SET sql = 'x'",
	'insert sqlite_master': 'INSERT INTO sqlite_master VALUES (1)',
	'delete sqlite_master': 'DELETE FROM sqlite_master',
	'stacked sqlite_master delete': 'SELECT 1; DELETE FROM sqlite_master',
	randomblob: 'SELECT randomblob(1000000000)',
	zeroblob: 'SELECT zeroblob(2000000000)',
	random: 'SELECT random()',
	printf: "SELECT printf('%1000000000d', 1)",
	'replace function': "SELECT replace('a', 'a', 'b')",
	'json_extract on the audit detail': "SELECT json_extract(detail, '$') FROM platform_audit",
	sqlite_version: 'SELECT sqlite_version()',
	'hex of random': 'SELECT hex(randomblob(10))',
	readfile: "SELECT readfile('/etc/passwd')",
	'unknown function': "SELECT edit('x')",
	'greek question mark': 'SELECT 1; DROP TABLE x',
	'fullwidth semicolon': 'SELECT 1； DROP TABLE x',
	'cyrillic S': 'ЅELECT 1',
	'accent in a string': "SELECT 'café'",
	'no-break space': 'SELECT 1',
	'line separator': 'SELECT 1',
	'null byte': 'SELECT 1\u0000; DROP TABLE x',
	'vertical tab': 'SELECT\x0b1',
	'form feed': 'SELECT 1\x0c',
	'positional parameter': 'SELECT ?',
	'named parameter': 'SELECT :a',
	'at parameter': 'SELECT @a',
	'dollar parameter': 'SELECT $a',
	empty: '',
	blank: '   ',
	'open string': "SELECT 'unterminated",
	'open quoted name': 'SELECT "unterminated',
	'open bracket name': 'SELECT [unterminated',
	'bracketed first token': '(SELECT 1)',
	values: 'VALUES (1)',
	explain: 'EXPLAIN SELECT 1',
	'select into': 'SELECT 1 INTO x',
	returning: 'SELECT * FROM sites RETURNING id',
	'longer than the cap': `SELECT ${'1,'.repeat(MAX_STATEMENT_CHARS)}1`,
	'secret column': 'SELECT key_hash FROM api_keys',
	'secret column under an alias': 'SELECT token_hash AS x FROM invites',
	'secret column quoted': 'SELECT "key_hash" FROM api_keys',
	'secret column in brackets': 'SELECT [ciphertext] FROM pending_secrets',
	'denied table': 'SELECT * FROM single_use',
	'denied table owner tokens': 'SELECT * FROM owner_tokens',
	'denied table quoted': 'SELECT * FROM "idempotency_keys"',
	'denied table behind a schema name': 'SELECT a.* FROM main.owner_tokens a',
	'join bomb': 'SELECT 1 FROM a JOIN b JOIN c JOIN d JOIN e JOIN f',
	'select bomb':
		'SELECT 1 FROM (SELECT 1 FROM (SELECT 1 FROM (SELECT 1 FROM (SELECT 1 FROM t))))',
	'mixed case delete': 'dElEtE FROM sites',
	'union star under a harmless first select (positional leak)':
		'SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 UNION SELECT * FROM api_keys',
	'union all star': 'SELECT id FROM sites UNION ALL SELECT * FROM members',
	'qualified star in a union': 'SELECT 1 UNION SELECT k.* FROM api_keys k',
	'except star': 'SELECT 1 EXCEPT SELECT * FROM api_keys',
	'bare pragma table': 'SELECT * FROM pragma_database_list',
	'bare pragma table in a join': 'SELECT 1 FROM sites JOIN pragma_table_list',
	'comma join bomb': 'SELECT count(*) FROM t a, t b, t c, t d, t e, t f',
	'comma join bomb in a subquery': 'SELECT 1 FROM (SELECT 1 FROM t a, t b, t c, t d, t e, t f)',
	'close bracket that ends the cap wrapper': 'SELECT 1) UNION SELECT id FROM sites WHERE (1'
};

describe('the read-only statement check', () => {
	it('has at least sixty hostile statements to refuse', () => {
		expect(Object.keys(HOSTILE).length).toBeGreaterThanOrEqual(60);
	});

	it.each(Object.entries(HOSTILE))('refuses %s', (_name, sql) => {
		expect(check(sql).ok).toBe(false);
	});

	it.each([
		'SELECT 1',
		'SELECT a.id, b.id FROM sites a, members b LIMIT 5',
		'SELECT id FROM sites UNION SELECT id FROM members',
		'SELECT count(*) FROM sites UNION SELECT 2 * 3',
		'SELECT 2 * id FROM sites',
		"select id, name, state from sites where state = 'active' order by created_at desc limit 10",
		'SELECT 1;',
		'SELECT count(*) AS n, status FROM operations GROUP BY status',
		"SELECT 'a; DROP TABLE x' AS t",
		"SELECT '--' AS t",
		"SELECT '/* x */' AS t",
		'SELECT "delete" FROM t',
		"SELECT id FROM sites WHERE name LIKE 'a%' AND id IN (1, 2)",
		'SELECT cast(created_at AS text) FROM sites',
		'SELECT * FROM sqlite_master',
		'SELECT a.id, b.id FROM sites a JOIN operations b ON a.id = b.site_id'
	])('passes %s', (sql) => {
		const verdict = check(sql);
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.statement.endsWith(';')).toBe(false);
	});

	it('keeps a semicolon that sits inside a string when no statement end follows', () => {
		const verdict = check("SELECT 'a;b' AS t");
		expect(verdict).toMatchObject({ ok: true, statement: "SELECT 'a;b' AS t" });
	});

	it('holds a huge LIMIT to the row cap instead of refusing it', () => {
		const verdict = check('SELECT * FROM sites LIMIT 999999999');
		expect(verdict.ok).toBe(true);
		if (verdict.ok) {
			expect(capped(verdict.statement)).toBe(
				`SELECT * FROM (SELECT * FROM sites LIMIT 999999999) LIMIT ${ROW_CAP + 1}`
			);
		}
	});

	it('names the reason for a refusal', () => {
		expect(check('DELETE FROM sites')).toEqual({
			ok: false,
			reason: 'Only a SELECT statement is allowed'
		});
		expect(check('SELECT 1; SELECT 2')).toEqual({
			ok: false,
			reason: 'Only one statement is allowed'
		});
		expect(check('SELECT key_hash FROM api_keys')).toMatchObject({ ok: false });
	});
});

describe('the column deny-list', () => {
	it('masks a secret column that comes back under its own name', () => {
		expect(maskRow({ id: 'a', key_hash: 'x', Ciphertext: 'y' })).toEqual({
			id: 'a',
			key_hash: MASK,
			Ciphertext: MASK
		});
	});

	// a table added later with a column like token_hash fails here until the column is classified
	it('classifies every column whose name looks sensitive, across the whole schema', () => {
		const missing: string[] = [];
		for (const statement of SCHEMA_STATEMENTS) {
			const table = /CREATE TABLE IF NOT EXISTS (\w+) \(/.exec(statement)?.[1];
			if (table === undefined) continue;
			for (const line of statement.split('\n')) {
				const column = /^\s*(\w+)\s+(?:TEXT|INTEGER|REAL|BLOB)\b/.exec(line)?.[1];
				if (column === undefined || !SENSITIVE_NAME.test(column)) continue;
				if (!isClassified(table, column)) missing.push(`${table}.${column}`);
			}
		}
		expect(missing).toEqual([]);
	});
});
