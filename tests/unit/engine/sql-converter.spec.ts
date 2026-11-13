import { describe, expect, it } from 'vitest';
import { chunkEnd, createSqlConverter } from '../../../engine/src/adapters/sql-converter';
import type { SqlConverter } from '../../../engine/src/ports';

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
