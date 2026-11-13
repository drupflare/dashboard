import type { SqlConverter } from '../ports';
import { PermanentError } from '../step';
import { convertDump, convertPgParts, splitPgStatements } from '../vendor/drangler/convert';
import { ConvertError } from '../vendor/drangler/errors';

const SEMICOLON = 59;
const NEWLINE = 10;
const RETURN = 13;
const BACKSLASH = 92;
const SLASH = 47;
const STAR = 42;
const DASH = 45;
const DOLLAR = 36;
const DOT = 46;
const SINGLE = 39;
const DOUBLE = 34;
const QUOTES = new Set([39, 34, 96]); // ' " `

const NO_BOUNDARY = 'a statement in the database dump is wider than one conversion step';

// the offset just past the last ';' and newline outside a quoted string or identifier; the final
// chunk of a dump is taken whole. A ';' newline inside a literal is not a boundary, or the chunk
// would end mid-string and convert into wrong SQL without an error.
export function chunkEnd(bytes: Uint8Array, last: boolean): number {
	if (last) return bytes.length;
	let quote = 0;
	let end = -1;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (quote !== 0) {
			if (byte === BACKSLASH && quote !== 96) i++;
			else if (byte === quote) quote = 0;
			continue;
		}
		if (QUOTES.has(byte)) quote = byte;
		else if (byte === NEWLINE && i > 0 && bytes[i - 1] === SEMICOLON) end = i + 1;
	}
	if (end > 0) return end;
	throw new PermanentError('no_statement_boundary', NO_BOUNDARY);
}

// #region a pg_dump

const isSpace = (byte: number) => byte === 32 || byte === 9 || byte === NEWLINE || byte === RETURN;
const isLetter = (byte: number) =>
	(byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 95;
const isWord = (byte: number) => isLetter(byte) || (byte >= 48 && byte <= 57);
const COPY_HEAD = /^COPY\b[\s\S]*\bFROM\s+stdin$/i;

// the length of a `$tag$` that opens at `at`, or 0; the same rule drangler's splitter reads
function dollarTag(bytes: Uint8Array, at: number): number {
	let j = at + 1;
	while (j < bytes.length && j < at + 63 && isLetter(bytes[j]!)) j++;
	return bytes[j] === DOLLAR ? j - at + 1 : 0;
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from: number): number {
	outer: for (let i = from; i + needle.length <= bytes.length; i++) {
		for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
		return i;
	}
	return -1;
}

// the index just past a quoted run that starts at `start`; a window that ends inside one returns its length
function quotedEnd(bytes: Uint8Array, start: number, escaped: boolean): number {
	const quote = bytes[start]!;
	let i = start + 1;
	while (i < bytes.length) {
		const byte = bytes[i]!;
		if (escaped && byte === BACKSLASH && i + 1 < bytes.length) {
			i += 2;
			continue;
		}
		if (byte === quote) {
			if (bytes[i + 1] === quote) {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i++;
	}
	return bytes.length;
}

// the offset just past the line that holds only `\.`, or -1 when the window ends first; the rows of
// the block start on the line after the statement and hold no ';' that means anything
function copyEnd(bytes: Uint8Array, from: number): number {
	const eol = bytes.indexOf(NEWLINE, from);
	if (eol < 0) return -1;
	let at = eol + 1;
	while (at < bytes.length) {
		const next = bytes.indexOf(NEWLINE, at);
		if (next < 0) return -1;
		const stop = bytes[next - 1] === RETURN ? next - 1 : next;
		if (stop - at === 2 && bytes[at] === BACKSLASH && bytes[at + 1] === DOT) return next + 1;
		at = next + 1;
	}
	return -1;
}

function isCopyHead(bytes: Uint8Array, from: number, to: number): boolean {
	const word = String.fromCharCode(...bytes.subarray(from, Math.min(to, from + 4))).toUpperCase();
	return (
		word === 'COPY' && COPY_HEAD.test(new TextDecoder().decode(bytes.subarray(from, to)).trim())
	);
}

// the offset just past the last statement, or `COPY` block with its `\.` line, that ends inside the
// window. A cut never falls inside a block, a string, a dollar-quoted body or a comment, and a block
// wider than the window has no cut. Every window starts at a cut, so it starts outside a block.
export function pgChunkEnd(bytes: Uint8Array, last: boolean): number {
	if (last) return bytes.length;
	const n = bytes.length;
	let end = -1;
	// where the statement under the scanner begins, past its leading space and comments
	let first = -1;
	let i = 0;
	while (i < n) {
		const byte = bytes[i]!;
		if (byte === DASH && bytes[i + 1] === DASH) {
			const eol = bytes.indexOf(NEWLINE, i);
			i = eol < 0 ? n : eol;
			continue;
		}
		if (byte === SLASH && bytes[i + 1] === STAR) {
			const close = indexOfBytes(bytes, Uint8Array.of(STAR, SLASH), i + 2);
			i = close < 0 ? n : close + 2;
			continue;
		}
		if (isSpace(byte)) {
			i++;
			continue;
		}
		if (first < 0) first = i;
		if (byte === DOLLAR) {
			const length = dollarTag(bytes, i);
			if (length > 0) {
				const close = indexOfBytes(bytes, bytes.subarray(i, i + length), i + length);
				i = close < 0 ? n : close + length;
				continue;
			}
		}
		if (byte === SINGLE || byte === DOUBLE) {
			// E'...' is the one form that reads backslashes, as in drangler's splitter
			const escaped =
				byte === SINGLE &&
				i > 0 &&
				(bytes[i - 1] === 69 || bytes[i - 1] === 101) &&
				(i < 2 || !isWord(bytes[i - 2]!));
			i = quotedEnd(bytes, i, escaped);
			continue;
		}
		if (byte === SEMICOLON) {
			const semicolon = i;
			i++;
			if (isCopyHead(bytes, first, semicolon)) {
				const stop = copyEnd(bytes, i);
				if (stop < 0) break;
				i = stop;
			} else if (bytes[i] === RETURN && bytes[i + 1] === NEWLINE) {
				i += 2;
			} else if (bytes[i] === NEWLINE) {
				i++;
			}
			end = i;
			first = -1;
			continue;
		}
		i++;
	}
	if (end > 0) return end;
	throw new PermanentError('no_statement_boundary', NO_BOUNDARY);
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const isData = (statement: { sql: string; copy?: string[] }) =>
	statement.copy !== undefined || /^INSERT\b/i.test(statement.sql);

// a conversion the converter refuses is a refusal of the dump, never a skipped statement
function refusing<T>(convert: () => T): T {
	try {
		return convert();
	} catch (error) {
		if (error instanceof ConvertError) {
			throw new PermanentError(
				'unsupported_statement',
				`the database dump holds a statement that cannot be converted: ${error.message}`
			);
		}
		throw error;
	}
}

// #endregion

export function createSqlConverter(): SqlConverter {
	return {
		async convertChunk(bytes, last) {
			const cut = chunkEnd(bytes, last);
			const text = decode(bytes.subarray(0, cut));
			const result = refusing(() => convertDump(text, { from: 'mysql', to: 'sqlite' }));
			return { cut, sql: result.sql, rows: result.rows, statements: result.statements };
		},
		async scanPg(bytes, last) {
			const cut = pgChunkEnd(bytes, last);
			const ddl = splitPgStatements(decode(bytes.subarray(0, cut)))
				.filter((statement) => !isData(statement))
				.map((statement) => `${statement.sql};`)
				.join('\n');
			return { cut, ddl };
		},
		async schemaPg(ddl) {
			const result = refusing(() => convertPgParts(ddl));
			return { tables: result.schemaSql, indexes: result.indexSql, lossy: result.lossy };
		},
		async dataPg(bytes, ddl) {
			const data = splitPgStatements(decode(bytes))
				.filter(isData)
				.map(({ sql, copy }) =>
					copy === undefined
						? `${sql};`
						: `${sql};\n${copy.map((row) => `${row}\n`).join('')}\\.`
				)
				.join('\n');
			const result = refusing(() => convertPgParts(`${ddl}\n${data}`));
			return {
				cut: bytes.length,
				sql: result.dataSql,
				rows: result.rows,
				statements: result.rows
			};
		}
	};
}
