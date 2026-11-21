export const MAX_STATEMENT_CHARS = 2000;
export const ROW_CAP = 200;
export const TIME_CAP_MS = 5000;
// unreviewed: joins and nested selects multiply the work, so both are bounded
export const MAX_JOINS = 4;
export const MAX_SELECTS = 4;

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'punct';

interface Token {
	kind: TokenKind;
	text: string;
}

export type SqlVerdict =
	{ ok: true; statement: string; tokens: readonly string[] } | { ok: false; reason: string };

const refuse = (reason: string): SqlVerdict => ({ ok: false, reason });

// every word that writes, changes the connection, reads the file system or runs more than one
// query; a word here is refused wherever it stands outside a quoted name or a string
const DENIED_WORDS: ReadonlySet<string> = new Set([
	'INSERT',
	'UPDATE',
	'DELETE',
	'REPLACE',
	'UPSERT',
	'DROP',
	'CREATE',
	'ALTER',
	'ATTACH',
	'DETACH',
	'PRAGMA',
	'VACUUM',
	'REINDEX',
	'ANALYZE',
	'BEGIN',
	'COMMIT',
	'END',
	'ROLLBACK',
	'SAVEPOINT',
	'RELEASE',
	'EXPLAIN',
	'WITH',
	'RECURSIVE',
	'INTO',
	'RETURNING',
	'TRIGGER',
	'VIRTUAL',
	'LOAD_EXTENSION',
	'TEMP',
	'TEMPORARY'
]);

// pure functions of their arguments; nothing that allocates by size, reads randomness or the clock
export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
	'COUNT',
	'SUM',
	'AVG',
	'MIN',
	'MAX',
	'TOTAL',
	'GROUP_CONCAT',
	'ABS',
	'LENGTH',
	'LOWER',
	'UPPER',
	'SUBSTR',
	'INSTR',
	'TRIM',
	'LTRIM',
	'RTRIM',
	'COALESCE',
	'IFNULL',
	'NULLIF',
	'IIF',
	'ROUND',
	'TYPEOF',
	'DATE',
	'DATETIME',
	'STRFTIME',
	'UNIXEPOCH',
	'CAST'
]);

// words that may stand in front of a bracket without being a function call
const BEFORE_PAREN: ReadonlySet<string> = new Set([
	'AND',
	'OR',
	'NOT',
	'ON',
	'WHERE',
	'FROM',
	'JOIN',
	'SELECT',
	'BY',
	'USING',
	'HAVING',
	'LIKE',
	'GLOB',
	'BETWEEN',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'AS',
	'DISTINCT',
	'ALL',
	'UNION',
	'EXCEPT',
	'INTERSECT',
	'LIMIT',
	'OFFSET',
	'IS',
	'IN',
	'EXISTS',
	'COLLATE',
	'ESCAPE'
]);

const CLAUSE_END: ReadonlySet<string> = new Set([
	'WHERE',
	'GROUP',
	'ORDER',
	'LIMIT',
	'HAVING',
	'UNION',
	'EXCEPT',
	'INTERSECT',
	'WINDOW'
]);

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const PRINTABLE = /^[\t\n\r\x20-\x7e]*$/;
const PUNCT = new Set([
	'(',
	')',
	',',
	'.',
	'*',
	'+',
	'-',
	'/',
	'%',
	'=',
	'<',
	'>',
	'!',
	'|',
	'&',
	'~'
]);

type Lexed = { ok: true; tokens: Token[]; semicolons: number } | { ok: false; reason: string };

// reads the statement the way SQLite does, so a word inside a string or a quoted name never
// counts and nothing outside one can hide
function lex(sql: string): Lexed {
	const tokens: Token[] = [];
	let semicolons = 0;
	let i = 0;
	while (i < sql.length) {
		const c = sql[i] as string;
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			i++;
			continue;
		}
		if (c === '-' && sql[i + 1] === '-')
			return { ok: false, reason: 'Comments are not allowed' };
		if (c === '/' && sql[i + 1] === '*')
			return { ok: false, reason: 'Comments are not allowed' };
		if (c === "'" || c === '"' || c === '`') {
			let j = i + 1;
			let closed = false;
			while (j < sql.length) {
				if (sql[j] === c) {
					if (sql[j + 1] === c) {
						j += 2;
						continue;
					}
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) return { ok: false, reason: 'A quote is never closed' };
			tokens.push({ kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j + 1) });
			i = j + 1;
			continue;
		}
		if (c === '[') {
			const end = sql.indexOf(']', i + 1);
			if (end === -1) return { ok: false, reason: 'A bracket name is never closed' };
			tokens.push({ kind: 'quoted', text: sql.slice(i, end + 1) });
			i = end + 1;
			continue;
		}
		if (c === ';') {
			semicolons++;
			tokens.push({ kind: 'punct', text: ';' });
			i++;
			continue;
		}
		if (WORD_START.test(c)) {
			let j = i + 1;
			while (j < sql.length && WORD_PART.test(sql[j] as string)) j++;
			tokens.push({ kind: 'word', text: sql.slice(i, j) });
			i = j;
			continue;
		}
		if (DIGIT.test(c)) {
			let j = i + 1;
			while (j < sql.length && /[0-9A-Za-z_.]/.test(sql[j] as string)) j++;
			tokens.push({ kind: 'number', text: sql.slice(i, j) });
			i = j;
			continue;
		}
		if (PUNCT.has(c)) {
			tokens.push({ kind: 'punct', text: c });
			i++;
			continue;
		}
		return { ok: false, reason: `The character ${JSON.stringify(c)} is not allowed` };
	}
	return { ok: true, tokens, semicolons };
}

export interface CheckOptions {
	// table names the statement may not mention, from the column classification
	deniedTables?: ReadonlySet<string>;
	// column names the statement may not mention
	maskedColumns?: ReadonlySet<string>;
}

const bare = (token: Token): string =>
	token.kind === 'quoted' ? token.text.slice(1, -1).toLowerCase() : token.text.toLowerCase();

// one SELECT, parsed into tokens and checked against the allow-list; the returned statement has
// its trailing semicolon removed. Nothing here guesses with a pattern over the whole text
export function checkStatement(sql: string, options: CheckOptions = {}): SqlVerdict {
	if (typeof sql !== 'string') return refuse('The statement is missing');
	if (sql.length > MAX_STATEMENT_CHARS) {
		return refuse(`The statement is longer than ${MAX_STATEMENT_CHARS} characters`);
	}
	if (!PRINTABLE.test(sql)) return refuse('Only plain ASCII characters are allowed');
	const lexed = lex(sql);
	if (!lexed.ok) return refuse(lexed.reason);
	const { tokens } = lexed;

	// one trailing semicolon is fine; anything after the first is a second statement
	let body = tokens;
	if (lexed.semicolons > 0) {
		const first = tokens.findIndex((t) => t.kind === 'punct' && t.text === ';');
		if (lexed.semicolons > 1 || first !== tokens.length - 1) {
			return refuse('Only one statement is allowed');
		}
		body = tokens.slice(0, first);
	}
	if (body.length === 0) return refuse('The statement is empty');
	const head = body[0] as Token;
	if (head.kind !== 'word' || head.text.toUpperCase() !== 'SELECT') {
		return refuse('Only a SELECT statement is allowed');
	}

	let joins = 0;
	let selects = 0;
	let depth = 0;
	let compound = false;
	let resultStar = false;
	// whether the clause at each bracket depth is a FROM list, where a comma joins two tables
	const inFrom: boolean[] = [false];
	for (let n = 0; n < body.length; n++) {
		const token = body[n] as Token;
		const next = body[n + 1];
		const prev = body[n - 1];
		if (token.kind === 'punct') {
			if (token.text === '(') inFrom[++depth] = false;
			if (token.text === ')') {
				if (--depth < 0) return refuse('A closing bracket has no opening one');
			}
			if (token.text === ',' && inFrom[depth]) joins++;
			if (token.text === '*' && prev !== undefined) {
				const afterList = prev.kind === 'punct' && (prev.text === ',' || prev.text === '.');
				const afterWord =
					prev.kind === 'word' &&
					['SELECT', 'DISTINCT', 'ALL'].includes(prev.text.toUpperCase());
				if (afterList || afterWord) resultStar = true;
			}
		}
		if (token.kind === 'word') {
			const upper = token.text.toUpperCase();
			if (DENIED_WORDS.has(upper)) return refuse(`${upper} is not allowed`);
			if (upper === 'SELECT') selects++;
			if (upper === 'FROM') inFrom[depth] = true;
			else if (CLAUSE_END.has(upper)) inFrom[depth] = false;
			if (upper === 'UNION' || upper === 'EXCEPT' || upper === 'INTERSECT') compound = true;
			if (upper === 'JOIN') joins++;
			if (next?.kind === 'punct' && next.text === '(') {
				if (!ALLOWED_FUNCTIONS.has(upper) && !BEFORE_PAREN.has(upper)) {
					return refuse(`The function ${token.text.toLowerCase()} is not allowed`);
				}
			}
		}
		if (token.kind === 'word' || token.kind === 'quoted') {
			const name = bare(token);
			if (name.startsWith('pragma_')) return refuse('The pragma tables are not allowed');
			if (options.deniedTables?.has(name))
				return refuse(`The table ${name} cannot be read here`);
			if (options.maskedColumns?.has(name)) {
				return refuse(`The column ${name} is masked and cannot be selected`);
			}
		}
		// a quoted name followed by "(" is a function call spelled with quotes
		if (token.kind === 'quoted' && next?.kind === 'punct' && next.text === '(') {
			return refuse('A quoted function name is not allowed');
		}
	}
	if (depth !== 0) return refuse('A bracket is never closed');
	// a masked column is hidden by its name in the result, and a compound select names its columns
	// after the first select, so a star in any part of one could carry a secret under a harmless name
	if (compound && resultStar) {
		return refuse('A star select cannot be combined with UNION, EXCEPT or INTERSECT');
	}
	if (joins > MAX_JOINS) return refuse(`More than ${MAX_JOINS} joins are not allowed`);
	if (selects > MAX_SELECTS) return refuse(`More than ${MAX_SELECTS} selects are not allowed`);

	// the one semicolon is the last token, so only whitespace follows it
	const statement = (lexed.semicolons === 0 ? sql : sql.slice(0, sql.lastIndexOf(';'))).trim();
	return { ok: true, statement, tokens: body.map((t) => t.text) };
}

// whatever LIMIT the statement carries, the outer one holds the rows to the cap
export function capped(statement: string, cap = ROW_CAP): string {
	return `SELECT * FROM (${statement}) LIMIT ${cap + 1}`;
}
