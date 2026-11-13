import type { SqlConverter } from '../ports';
import { PermanentError } from '../step';
import { convertDump } from '../vendor/drangler/convert';
import { ConvertError } from '../vendor/drangler/errors';

const SEMICOLON = 59;
const NEWLINE = 10;
const BACKSLASH = 92;
const QUOTES = new Set([39, 34, 96]); // ' " `

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
	throw new PermanentError(
		'no_statement_boundary',
		'a statement in the database dump is wider than one conversion step'
	);
}

export function createSqlConverter(): SqlConverter {
	return {
		async convertChunk(bytes, last) {
			const cut = chunkEnd(bytes, last);
			const text = new TextDecoder().decode(bytes.subarray(0, cut));
			try {
				const result = convertDump(text, { from: 'mysql', to: 'sqlite' });
				return { cut, sql: result.sql, rows: result.rows, statements: result.statements };
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
	};
}
