import { utf8 } from '@contracts/common';
import { parseTar, tarEntryTree, TarParseError, TarPathError } from '@drupflare/untarl';
import { joinParts } from './backup-parts';
import { ImportError } from './import-parts';

// the worker stores a file in chunks of this size (FILE_CHUNK_BYTES in its file store)
export const FILE_CHUNK_BYTES = 200_000;

// the widest literal one statement carries; wider values are built across appends, as the worker's export does
const LITERAL_BUDGET = 40_000;

// unreviewed: files a restore body may carry, so a replay of one import stays a bounded job
export const MAX_FILE_ENTRIES = 5_000;

// unreviewed: the longest file path carried
export const MAX_PATH_CHARS = 1_024;

// the most a header, a long name and the padding add to one entry of a tar
const ENTRY_ARCHIVE_OVERHEAD = 2_048;
const BLOCK = 512;

// every file byte costs two hex digits in the body, so an archive of more than half the room plus its
// own headers cannot fit
export function filesArchiveLimit(roomBytes: number): number {
	return Math.max(0, Math.floor(roomBytes / 2)) + MAX_FILE_ENTRIES * ENTRY_ARCHIVE_OVERHEAD;
}

export function tooLarge(ceilingBytes: number): ImportError {
	return new ImportError(
		'restore_too_large',
		`the database and the files together are larger than the ${ceilingBytes} bytes an import carries in one restore`
	);
}

// the worker's own list, which is advisory metadata on the stored row
const MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	css: 'text/css',
	js: 'text/javascript',
	json: 'application/json',
	txt: 'text/plain',
	html: 'text/html'
};

export function mimeOf(path: string): string | null {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot < 0 ? null : (MIME[name.slice(dot + 1).toLowerCase()] ?? null);
}

// the tables as the worker creates them, so a body that arrives before the site touched a file
// still has somewhere to land
export const TABLES = [
	`CREATE TABLE IF NOT EXISTS cfw_file (
      uri TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      modified INTEGER NOT NULL,
      mime TEXT,
      chunks INTEGER NOT NULL,
      mirrored INTEGER NOT NULL DEFAULT 0,
      rev INTEGER NOT NULL DEFAULT 0,
      touched INTEGER NOT NULL DEFAULT 0,
      evicted INTEGER NOT NULL DEFAULT 0,
      hash TEXT,
      r2site TEXT
    );`,
	`CREATE TABLE IF NOT EXISTS cfw_file_chunk (
      uri TEXT NOT NULL,
      seq INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (uri, seq)
    );`,
	`CREATE TABLE IF NOT EXISTS cfw_file_mirror_queue (
      uri TEXT PRIMARY KEY,
      op TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );`
];

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

function hex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
	return out;
}

// one chunk row; a value over the budget is an insert of its first slice as text, appends for the
// rest and one unhex, because `||` on a blob yields text
export function chunkStatements(uri: string, seq: number, bytes: Uint8Array): string[] {
	const literal = `x'${hex(bytes)}'`;
	const head = `INSERT INTO "cfw_file_chunk" ("uri", "seq", "bytes") VALUES (${quote(uri)}, ${seq}, `;
	if (literal.length <= LITERAL_BUDGET) return [`${head}${literal});`];
	const body = literal.slice(2, -1);
	const width = Math.max(2, (LITERAL_BUDGET - 4) & ~1);
	const slices: string[] = [];
	for (let at = 0; at < body.length; at += width) slices.push(body.slice(at, at + width));
	const where = `WHERE "uri" = ${quote(uri)} AND "seq" = ${seq}`;
	return [
		`${head}'${slices[0]}');`,
		...slices
			.slice(1)
			.map(
				(slice) => `UPDATE "cfw_file_chunk" SET "bytes" = "bytes" || '${slice}' ${where};`
			),
		`UPDATE "cfw_file_chunk" SET "bytes" = unhex("bytes") ${where};`
	];
}

// the rows of one file ahead of its chunks: the old chunks go, and the row is written resident
// (not evicted, no hash, no other site's prefix) so the site reads the bytes from its own database
export function fileRowStatements(file: {
	uri: string;
	size: number;
	chunks: number;
	mime: string | null;
	modified: number;
	nowMs: number;
}): string[] {
	const { uri, size, chunks, mime, modified, nowMs } = file;
	return [
		`DELETE FROM "cfw_file_chunk" WHERE "uri" = ${quote(uri)};`,
		`INSERT OR REPLACE INTO "cfw_file" ("uri", "size", "modified", "mime", "chunks", "mirrored", "rev", "touched", "evicted", "hash", "r2site") VALUES (${quote(uri)}, ${size}, ${modified}, ${mime === null ? 'NULL' : quote(mime)}, ${chunks}, 0, 1, ${nowMs}, 0, NULL, NULL);`
	];
}

// the queue row is what makes the new site offload the file to its own bucket
export const mirrorStatement = (uri: string, nowMs: number) =>
	`INSERT OR REPLACE INTO "cfw_file_mirror_queue" ("uri", "op", "queued_at", "attempts", "last_error") VALUES (${quote(uri)}, 'put', ${nowMs}, 0, NULL);`;

export function chunkCount(size: number): number {
	return Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES));
}

function fileStatements(uri: string, bytes: Uint8Array, mime: string | null, nowMs: number) {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += FILE_CHUNK_BYTES) {
		chunks.push(bytes.subarray(at, Math.min(at + FILE_CHUNK_BYTES, bytes.length)));
	}
	if (chunks.length === 0) chunks.push(new Uint8Array(0));
	return [
		...fileRowStatements({
			uri,
			size: bytes.length,
			chunks: chunks.length,
			mime,
			modified: nowMs,
			nowMs
		}),
		...chunks.flatMap((chunk, seq) => chunkStatements(uri, seq, chunk)),
		mirrorStatement(uri, nowMs)
	];
}

// a path that is not plain text, or that is too long to be a Drupal file, is refused rather than altered
function badPath(path: string): boolean {
	// eslint-disable-next-line no-control-regex
	return path.length > MAX_PATH_CHARS || /[\u0000-\u001f\u007f�\\]/.test(path);
}

function octal(bytes: Uint8Array, at: number, length: number): number {
	let value = 0;
	for (let i = at; i < at + length; i++) {
		const byte = bytes[i] ?? 0;
		if (byte >= 0x30 && byte <= 0x37) value = value * 8 + (byte - 0x30);
	}
	return value;
}

// the parser drops hard and symbolic links, so they are counted from the headers to be reported
function countLinks(bytes: Uint8Array): number {
	let at = 0;
	let links = 0;
	while (at + BLOCK <= bytes.length && (bytes[at] ?? 0) !== 0) {
		const flag = bytes[at + 156];
		if (flag === 0x31 || flag === 0x32) links++;
		at += BLOCK + Math.ceil(octal(bytes, at + 124, 12) / BLOCK) * BLOCK;
	}
	return links;
}

// a tar always ends in zero blocks, so an archive cut at a block boundary is told by its tail
function closed(bytes: Uint8Array): boolean {
	if (bytes.length < BLOCK * 2) return false;
	for (let i = bytes.length - BLOCK * 2; i < bytes.length; i++) if (bytes[i] !== 0) return false;
	return true;
}

export interface FilesConversion {
	sql: Uint8Array;
	files: number;
	// file bytes carried
	bytes: number;
	// hard and symbolic links left behind
	links: number;
}

export interface FilesConvertOptions {
	nowMs: number;
	ceilingBytes: number;
	// the converted database already counted against the ceiling
	databaseBytes: number;
	// public by default; the private folder's tar starts at the folder's own name, which is dropped
	scheme?: 'public' | 'private';
}

// turns a plain tar of the public files into the statements the worker's own export writes for its
// file store; nothing in the archive is followed or extracted, only read into rows
export function convertFiles(archive: Uint8Array, options: FilesConvertOptions): FilesConversion {
	const scheme = options.scheme ?? 'public';
	const room = options.ceilingBytes - options.databaseBytes;
	if (room <= 0 || archive.length > filesArchiveLimit(room)) throw tooLarge(options.ceilingBytes);
	if (!closed(archive)) {
		throw new ImportError(
			'files_unreadable',
			'the files archive was cut short or is not a tar'
		);
	}
	let tree: Map<string, Uint8Array>;
	let count = 0;
	try {
		const entries = parseTar(archive);
		count = entries.filter((entry) => entry.type === 'file').length;
		if (count > MAX_FILE_ENTRIES) {
			throw new ImportError(
				'files_too_many',
				`the files archive holds ${count} files, over the ${MAX_FILE_ENTRIES} an import carries`
			);
		}
		// the largest file that can fit at all, since each byte is two hex digits
		if (entries.some((entry) => entry.size > room / 2)) throw tooLarge(options.ceilingBytes);
		tree = tarEntryTree(entries, scheme === 'private' ? 1 : 0);
	} catch (error) {
		if (error instanceof TarParseError) {
			throw new ImportError(
				'files_unreadable',
				'the files archive was cut short or is not a tar'
			);
		}
		if (error instanceof TarPathError) {
			throw new ImportError(
				'files_bad_path',
				'the files archive names a path outside the files folder'
			);
		}
		throw error;
	}

	const pieces: Uint8Array[] = [];
	let total = 0;
	let carried = 0;
	const add = (text: string) => {
		const piece = utf8(text);
		total += piece.byteLength;
		if (total > room) throw tooLarge(options.ceilingBytes);
		pieces.push(piece);
	};
	for (const [path, bytes] of tree) {
		if (badPath(path)) {
			throw new ImportError(
				'files_bad_path',
				'a file in the archive has a name that cannot be carried'
			);
		}
		if (pieces.length === 0) add(`${TABLES.join('\n')}\n`);
		const uri = `${scheme}://${path}`;
		add(`${fileStatements(uri, bytes, mimeOf(path), options.nowMs).join('\n')}\n`);
		carried += bytes.byteLength;
	}
	return {
		sql: joinParts(pieces),
		files: tree.size,
		bytes: carried,
		links: countLinks(archive)
	};
}
