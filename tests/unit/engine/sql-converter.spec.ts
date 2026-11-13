import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	chunkEnd,
	createSqlConverter,
	pgChunkEnd
} from '../../../engine/src/adapters/sql-converter';
import type { SqlConverter } from '../../../engine/src/ports';
import { convertDump } from '../../../engine/src/vendor/drangler/convert';

const CREATE_NODE =
	'CREATE TABLE `node` (`nid` int(10) unsigned NOT NULL, `title` varchar(255) DEFAULT NULL, ' +
	'PRIMARY KEY (`nid`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;';
const CREATE_TERM =
	'CREATE TABLE `term` (`tid` int(10) unsigned NOT NULL, `name` varchar(64) DEFAULT NULL, ' +
	'PRIMARY KEY (`tid`)) ENGINE=InnoDB;';

const rows = (table: string, count: number) =>
	Array.from(
		{ length: count },
		(_, i) => `INSERT INTO \`${table}\` VALUES (${i},'row ${i}');`
	).join('\n');

// rows of one table, then a table created after them, as mysqldump can emit
const DUMP = [CREATE_NODE, rows('node', 40), CREATE_TERM, rows('term', 20)].join('\n') + '\n';

const bytesOf = (text: string) => new TextEncoder().encode(text);

async function convertChunked(converter: SqlConverter, text: string, window: number) {
	const bytes = bytesOf(text);
	let offset = 0;
	let chunks = 0;
	const parts: string[] = [];
	while (offset < bytes.length) {
		const last = offset + window >= bytes.length;
		const slice = bytes.subarray(offset, Math.min(bytes.length, offset + window));
		const out = await converter.convertChunk(slice, last);
		parts.push(out.sql);
		offset += out.cut;
		chunks++;
	}
	return { sql: parts.join(''), chunks };
}

describe('chunkEnd', () => {
	it('takes the final chunk whole', () => {
		expect(chunkEnd(bytesOf('abc'), true)).toBe(3);
	});

	it('cuts just past the last semicolon and newline in the window', () => {
		expect(chunkEnd(bytesOf('a;\nb;\nccc'), false)).toBe(6);
	});

	it('ignores a semicolon and newline inside a string or identifier', () => {
		expect(chunkEnd(bytesOf("x='a;\nb';\n"), false)).toBe(10);
		expect(chunkEnd(bytesOf("x='it\\'s;\nok';\n"), false)).toBe(15);
		expect(() => chunkEnd(bytesOf("x='a;\n"), false)).toThrow(/wider than one conversion step/);
	});

	it('refuses a window with no statement boundary', () => {
		expect(() => chunkEnd(bytesOf('INSERT INTO t VALUES (1);'), false)).toThrow(
			/wider than one conversion step/
		);
	});
});

describe('createSqlConverter', () => {
	const converter = createSqlConverter();

	it('converts in chunks to the same SQL as the whole dump', async () => {
		const whole = await converter.convertChunk(bytesOf(DUMP), true);
		const chunked = await convertChunked(converter, DUMP, 512);

		expect(chunked.chunks).toBeGreaterThan(3);
		expect(chunked.sql).toBe(whole.sql);
		expect(whole.rows).toBe(60);
	});

	it('refuses a statement wider than the window', async () => {
		const wide = `INSERT INTO node VALUES (1,'${'x'.repeat(3000)}');\n`;

		await expect(
			converter.convertChunk(bytesOf(wide).subarray(0, 1024), false)
		).rejects.toMatchObject({ code: 'no_statement_boundary' });
	});

	it('refuses a trigger', async () => {
		const dump = `${CREATE_NODE}\nCREATE TRIGGER t BEFORE INSERT ON node FOR EACH ROW SET NEW.title = 'x';\n`;

		await expect(converter.convertChunk(bytesOf(dump), true)).rejects.toMatchObject({
			code: 'unsupported_statement',
			message: expect.stringMatching(/TRIGGER is not converted/)
		});
	});

	it('refuses a row over the statement ceiling of the target', async () => {
		const huge = `${CREATE_NODE}\nINSERT INTO \`node\` VALUES (1,'${'x'.repeat(100_010)}');\n`;

		await expect(converter.convertChunk(bytesOf(huge), true)).rejects.toMatchObject({
			code: 'unsupported_statement',
			message: expect.stringMatching(/100,000-character ceiling/)
		});
	});

	it('does not cut inside a string that holds a semicolon and newline', async () => {
		const text = `${CREATE_NODE}\nINSERT INTO \`node\` VALUES (1,'alpha;\nbeta');\nINSERT INTO \`node\` VALUES (2,'gamma');\n`;
		const whole = await converter.convertChunk(bytesOf(text), true);
		const window = text.indexOf('alpha;\n') + 'alpha;\n'.length;
		const bytes = bytesOf(text);
		const first = await converter.convertChunk(bytes.subarray(0, window), false);
		const rest = await converter.convertChunk(bytes.subarray(first.cut), true);

		expect(first.cut).toBe(CREATE_NODE.length + 1);
		expect(first.sql + rest.sql).toBe(whole.sql);
	});
});

// #region PostgreSQL

const FUNCTION = [
	'CREATE FUNCTION public.greatest(numeric, numeric) RETURNS numeric',
	'    LANGUAGE sql AS $$SELECT CASE WHEN $1 > $2 THEN $1 ELSE $2 END;',
	'$$;'
].join('\n');

const copyOf = (table: string, rows: string[]) =>
	`COPY public.${table} (id, body, flag, blob) FROM stdin;\n${rows.map((row) => `${row}\n`).join('')}\\.\n`;

const createOf = (table: string) =>
	`CREATE TABLE public.${table} (\n    id integer NOT NULL,\n    body text,\n    flag boolean,\n    blob bytea\n);\n`;

const keysOf = (table: string) =>
	`ALTER TABLE ONLY public.${table}\n    ADD CONSTRAINT ${table}_pkey PRIMARY KEY (id);\nCREATE INDEX ${table}_body_idx ON public.${table} USING btree (body);\n`;

// tokens that a field can hold: statement punctuation, quotes, comment openers, dollar tags, escapes
const TOKENS = [
	'a',
	'b c',
	"it's",
	';',
	'";"',
	'$$',
	'$x$',
	'--',
	'/*',
	'*/',
	"E'",
	'\\\\',
	'\\t',
	'\\n',
	';;',
	'café',
	'日本'
];

// a small seeded generator, so a failure names the seed
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function pgDumpOf(seed: number): string {
	const next = random(seed);
	const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
	const names = ['node', 'users', 'cache_a', 'term', 'menu'];
	const row = (id: number) => {
		const body = Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(TOKENS)).join(
			''
		);
		const flag = next() < 0.5 ? 't' : 'f';
		const blob = next() < 0.3 ? '\\N' : '\\\\x6162';
		// a row can end in a semicolon, which a MySQL cut rule would take for a boundary
		return `${id}\t${body}${next() < 0.2 ? ';' : ''}\t${flag}\t${blob}`;
	};
	const parts = [
		'--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\n',
		FUNCTION,
		'\n'
	];
	for (const name of names.slice(0, 4)) parts.push(createOf(name));
	for (const name of names.slice(0, 4)) {
		const count = name === 'term' ? 0 : Math.floor(next() * 60);
		parts.push(
			copyOf(
				name,
				Array.from({ length: count }, (_, i) => row(i))
			)
		);
	}
	// a table created after a COPY, and a statement that holds a ';' and a newline
	parts.push(createOf('menu'), copyOf('menu', [row(1), row(2)]));
	parts.push("SELECT pg_catalog.setval('public.node_seq', 2, true);\n");
	for (const name of names) parts.push(keysOf(name));
	return parts.join('');
}

describe('pgChunkEnd', () => {
	const end = (text: string, last = false) => pgChunkEnd(bytesOf(text), last);

	it('takes the final window whole', () => {
		expect(end('abc', true)).toBe(3);
	});

	it('cuts after the last statement that ends inside the window', () => {
		expect(end('SET a = 1;\nSET b = 2;\nSET c')).toBe('SET a = 1;\nSET b = 2;\n'.length);
	});

	it('cuts after a COPY block and its terminator line, never inside the rows', () => {
		const block = `${createOf('node')}${copyOf('node', ['1\tx;', '2\ty;'])}`;
		expect(end(`${block}SET a = 1`)).toBe(block.length);
		// the window ends inside the block: the cut is the statement before it
		expect(end(`${createOf('node')}COPY public.node (id) FROM stdin;\n1\n2;\n3`)).toBe(
			createOf('node').length
		);
	});

	it('reads a row that ends in a semicolon as data, not a statement end', () => {
		const text = `${createOf('node')}COPY public.node (id, body) FROM stdin;\n1\ta;\n2\tb;\n`;
		expect(end(text)).toBe(createOf('node').length);
	});

	it('ignores a semicolon inside a string, a dollar-quoted body, a comment and an identifier', () => {
		expect(end("SELECT 'a;\nb';\nSELECT 1")).toBe("SELECT 'a;\nb';\n".length);
		expect(end(`${FUNCTION}\nSELECT 1`)).toBe(`${FUNCTION}\n`.length);
		expect(end('-- a;\nSET a = 1;\n-- b; and /* c')).toBe('-- a;\nSET a = 1;\n'.length);
		expect(end('/* a;\nb; */ SET a = 1;\nSET b')).toBe('/* a;\nb; */ SET a = 1;\n'.length);
		expect(end('SELECT "a;\nb" FROM t;\nSELECT')).toBe('SELECT "a;\nb" FROM t;\n'.length);
	});

	it("reads backslashes in E'' strings only", () => {
		expect(end("SELECT E'it\\';\nx';\nSELECT")).toBe("SELECT E'it\\';\nx';\n".length);
		expect(end("SELECT 'it\\';\nSELECT")).toBe("SELECT 'it\\';\n".length);
	});

	it('reads a CRLF dump', () => {
		const text = 'SET a = 1;\r\nCOPY public.t (id) FROM stdin;\r\n1\r\n\\.\r\nSET b';
		expect(end(text)).toBe(text.length - 'SET b'.length);
	});

	it('refuses a window with no boundary, loudly', () => {
		const wide = `${createOf('node')}${copyOf(
			'node',
			Array.from({ length: 30 }, (_, i) => `${i}\tx`)
		)}`;
		const window = bytesOf(wide).subarray(0, createOf('node').length - 4);
		expect(() => pgChunkEnd(window, false)).toThrow(/wider than one conversion step/);
		expect(() => pgChunkEnd(bytesOf(wide).subarray(0, wide.length - 20), false)).not.toThrow();
		const block = copyOf(
			'node',
			Array.from({ length: 30 }, (_, i) => `${i}\tx`)
		);
		expect(() => pgChunkEnd(bytesOf(block).subarray(0, block.length - 5), false)).toThrow(
			expect.objectContaining({ code: 'no_statement_boundary' })
		);
	});
});

describe('the PostgreSQL steps', () => {
	const converter = createSqlConverter();

	async function convertPgChunked(text: string, window: number) {
		const bytes = bytesOf(text);
		const cuts: number[] = [];
		const ddls: string[] = [];
		let offset = 0;
		while (offset < bytes.length) {
			const last = offset + window >= bytes.length;
			const slice = bytes.subarray(offset, Math.min(bytes.length, offset + window));
			const scanned = await converter.scanPg(slice, last);
			cuts.push(scanned.cut);
			ddls.push(scanned.ddl);
			offset += scanned.cut;
		}
		const ddl = ddls.join('\n');
		const schema = await converter.schemaPg(ddl);
		let at = 0;
		let data = '';
		for (const cut of cuts) {
			data += (await converter.dataPg(bytes.subarray(at, at + cut), ddl)).sql;
			at += cut;
		}
		return { sql: schema.tables + data + schema.indexes, cuts, lossy: schema.lossy };
	}

	it('converts in windows to the same SQL as the whole dump, on dumps built from awkward fields', async () => {
		let windows = 0;
		for (let seed = 1; seed <= 12; seed++) {
			const text = pgDumpOf(seed);
			const whole = convertDump(text, { from: 'pgsql', to: 'sqlite' });
			expect(whole.rows).toBeGreaterThan(0);
			for (const window of [700, 1500, 4000, text.length]) {
				let chunked;
				try {
					chunked = await convertPgChunked(text, window);
				} catch (error) {
					// a block wider than the window is the one allowed failure, and it is loud
					expect(error).toMatchObject({ code: 'no_statement_boundary' });
					continue;
				}
				windows += chunked.cuts.length;
				expect(chunked.sql, `seed ${seed}, window ${window}`).toBe(whole.sql);
				expect(chunked.lossy).toEqual(whole.lossy);
			}
		}
		expect(windows).toBeGreaterThan(40);
	});

	it('replays into a real database with the same rows as the whole dump', async () => {
		const text = pgDumpOf(5);
		const chunked = await convertPgChunked(text, 1500);
		const db = new DatabaseSync(':memory:');
		try {
			db.exec(chunked.sql);
			const total = (table: string) =>
				(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
			const whole = new DatabaseSync(':memory:');
			whole.exec(convertDump(text, { from: 'pgsql', to: 'sqlite' }).sql);
			for (const table of ['node', 'users', 'cache_a', 'term', 'menu']) {
				expect(total(table)).toBe(
					(whole.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
				);
			}
			whole.close();
		} finally {
			db.close();
		}
	});

	it('keeps rows and statements out of the statements that are not data', async () => {
		const scanned = await converter.scanPg(
			bytesOf(`${createOf('node')}${copyOf('node', ['1\tx', '2\ty'])}${keysOf('node')}`),
			true
		);
		expect(scanned.ddl).toContain('CREATE TABLE public.node');
		expect(scanned.ddl).toContain('PRIMARY KEY (id)');
		expect(scanned.ddl).not.toContain('COPY');
		expect(scanned.ddl).not.toContain('1\tx');
	});

	it('reports the functions it leaves behind', async () => {
		const schema = await converter.schemaPg(`${FUNCTION};\n${createOf('node')}`);
		// a restore onto a site that already has the table replaces it
		expect(schema.tables).toContain('DROP TABLE IF EXISTS "node";\nCREATE TABLE "node"');
		expect(schema.lossy.join(' ')).toContain('greatest');
		expect(schema.tables).toContain('CREATE TABLE "node"');
	});

	it('refuses a trigger and a type it cannot store, and does not skip them', async () => {
		await expect(
			converter.schemaPg(
				'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();'
			)
		).rejects.toMatchObject({ code: 'unsupported_statement' });
		await expect(converter.schemaPg('CREATE TABLE t (tags text[]);')).rejects.toMatchObject({
			code: 'unsupported_statement'
		});
	});

	it('types a COPY row by the tables of the whole dump, not of its own window', async () => {
		const ddl = `${createOf('node')}`;
		const rows = await converter.dataPg(
			bytesOf(copyOf('node', ['7\thello\tt\t\\\\x6162'])),
			ddl
		);
		expect(rows.sql).toContain("VALUES (7, 'hello', 1, x'6162')");
		expect(rows.rows).toBe(1);
	});
});

// #endregion
