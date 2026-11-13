import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	convertFiles,
	FILE_CHUNK_BYTES,
	filesArchiveLimit,
	MAX_FILE_ENTRIES
} from '../../../engine/src/files-convert';
import { tarOf, type TarItem } from './import-fakes';

const MIB = 1024 * 1024;
const CEILING = 16 * MIB;
const NOW = 1_762_900_000_000;

const convert = (archive: Uint8Array, databaseBytes = 0, ceilingBytes = CEILING) =>
	convertFiles(archive, { nowMs: NOW, ceilingBytes, databaseBytes });

const failureOf = (run: () => unknown): Error & { code?: string } => {
	try {
		run();
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a refusal');
};

// the worker's quote-aware splitter (import-sql.ts), which is what reads the body at restore
function splitStatements(dump: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote: string | null = null;
	for (let i = 0; i < dump.length; i++) {
		const ch = dump[i] as string;
		if (quote !== null) {
			current += ch;
			if (ch === quote) {
				if (dump[i + 1] === quote) {
					current += quote;
					i++;
				} else quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ';') {
			if (current.trim() !== '') out.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim() !== '') out.push(current.trim());
	return out;
}

// a real SQLite stands in for the site's database; the read-back mirrors getFile in the worker
function replay(sql: Uint8Array, before: (db: DatabaseSync) => void = () => undefined) {
	const db = new DatabaseSync(':memory:');
	before(db);
	const statements = splitStatements(new TextDecoder().decode(sql));
	for (const statement of statements) db.exec(statement);
	const stat = (uri: string) =>
		db.prepare('SELECT * FROM cfw_file WHERE uri = ?').get(uri) as
			Record<string, string | number | null> | undefined;
	const read = (uri: string) => {
		const rows = db
			.prepare('SELECT bytes FROM cfw_file_chunk WHERE uri = ? ORDER BY seq')
			.all(uri) as { bytes: Uint8Array }[];
		const parts = rows.map((row) => new Uint8Array(row.bytes));
		const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
		let at = 0;
		for (const part of parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	};
	return { db, statements, stat, read };
}

const random = (length: number, seed: number) => {
	const bytes = new Uint8Array(length);
	let state = seed;
	for (let i = 0; i < length; i++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		bytes[i] = state >>> 24;
	}
	return bytes;
};

describe('convertFiles round trip', () => {
	const tree: Record<string, Uint8Array> = {
		'empty.txt': new Uint8Array(0),
		"it's a file.txt": new TextEncoder().encode("quote; and -- and 'quotes'"),
		'a/b;c--d.css': new TextEncoder().encode('body{}'),
		'café/ü.png': random(300, 1),
		'styles/thumb/exact.jpg': random(FILE_CHUNK_BYTES, 2),
		'one-over.pdf': random(FILE_CHUNK_BYTES + 1, 3),
		'wide/nul.bin': new Uint8Array(250_000),
		'wide/random.bin': random(400_001, 4),
		'near-budget.dat': random(19_999, 5),
		noext: random(10, 6)
	};
	const items: TarItem[] = [
		{ name: './', type: 'directory' },
		{ name: './a/', type: 'directory' },
		...Object.entries(tree).map(([name, body]) => ({ name: `./${name}`, body }))
	];

	it('lands every file with the same bytes and the row the worker writes', () => {
		const converted = convert(tarOf(items));
		expect(converted.files).toBe(Object.keys(tree).length);
		expect(converted.links).toBe(0);
		expect(converted.bytes).toBe(Object.values(tree).reduce((n, b) => n + b.length, 0));
		const site = replay(converted.sql);
		for (const [name, bytes] of Object.entries(tree)) {
			const uri = `public://${name}`;
			expect(Buffer.from(site.read(uri)).equals(Buffer.from(bytes)), name).toBe(true);
			expect(site.stat(uri), name).toMatchObject({
				size: bytes.length,
				chunks: Math.max(1, Math.ceil(bytes.length / FILE_CHUNK_BYTES)),
				mirrored: 0,
				rev: 1,
				touched: NOW,
				modified: NOW,
				evicted: 0,
				hash: null,
				r2site: null
			});
		}
		const queued = site.db.prepare('SELECT uri, op, attempts FROM cfw_file_mirror_queue').all();
		expect(queued).toHaveLength(Object.keys(tree).length);
		expect(queued[0]).toMatchObject({ op: 'put', attempts: 0 });
	});

	it('sets a type from the extension the way the worker does and leaves the rest empty', () => {
		const site = replay(convert(tarOf(items)).sql);
		expect(site.stat('public://café/ü.png')!.mime).toBe('image/png');
		expect(site.stat('public://a/b;c--d.css')!.mime).toBe('text/css');
		expect(site.stat('public://one-over.pdf')!.mime).toBe('application/pdf');
		expect(site.stat('public://noext')!.mime).toBeNull();
		expect(site.stat('public://wide/nul.bin')!.mime).toBeNull();
	});

	it('keeps every statement under the 100,000 characters a site accepts and builds wide chunks by append', () => {
		const { sql } = convert(tarOf(items));
		const statements = splitStatements(new TextDecoder().decode(sql));
		expect(Math.max(...statements.map((statement) => statement.length))).toBeLessThan(100_000);
		expect(statements.some((statement) => statement.includes('"bytes" || '))).toBe(true);
		expect(statements.some((statement) => statement.includes('unhex("bytes")'))).toBe(true);
		const wide = statements.filter((s) => s.startsWith('INSERT INTO "cfw_file_chunk"'));
		expect(wide.every((statement) => statement.length < 100_000)).toBe(true);
	});

	it('creates the tables when the site has not touched a file yet and keeps what it already holds', () => {
		const bare = replay(convert(tarOf([{ name: './x.txt', body: 'x' }])).sql);
		expect(bare.read('public://x.txt')).toEqual(new TextEncoder().encode('x'));
		const held = replay(convert(tarOf([{ name: './x.txt', body: 'new' }])).sql, (db) => {
			db.exec(
				`CREATE TABLE cfw_file (uri TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL,
				mime TEXT, chunks INTEGER NOT NULL, mirrored INTEGER NOT NULL DEFAULT 0,
				rev INTEGER NOT NULL DEFAULT 0, touched INTEGER NOT NULL DEFAULT 0,
				evicted INTEGER NOT NULL DEFAULT 0, hash TEXT, r2site TEXT);
				CREATE TABLE cfw_file_chunk (uri TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL,
				PRIMARY KEY (uri, seq));
				INSERT INTO cfw_file VALUES ('public://x.txt', 99, 1, NULL, 2, 1, 5, 1, 0, 'h', 'other');
				INSERT INTO cfw_file VALUES ('public://keep.txt', 1, 1, NULL, 1, 0, 1, 1, 0, NULL, NULL);
				INSERT INTO cfw_file_chunk VALUES ('public://x.txt', 0, x'6f6c64');
				INSERT INTO cfw_file_chunk VALUES ('public://x.txt', 1, x'6f6c64');`
			);
		});
		expect(held.read('public://x.txt')).toEqual(new TextEncoder().encode('new'));
		expect(held.stat('public://x.txt')).toMatchObject({ size: 3, chunks: 1, r2site: null });
		expect(held.stat('public://keep.txt')).toBeDefined();
	});

	it('carries nothing for an archive of folders', () => {
		const converted = convert(tarOf([{ name: './', type: 'directory' }]));
		expect(converted).toMatchObject({ files: 0, bytes: 0 });
		expect(converted.sql.byteLength).toBe(0);
	});
});

describe('a hostile or damaged archive', () => {
	it.each(['../etc/passwd', './a/../../b', '/etc/passwd', 'a/..'])(
		'refuses the path %s',
		(name) => {
			const error = failureOf(() => convert(tarOf([{ name, body: 'x' }])));
			expect(error).toMatchObject({ code: 'files_bad_path' });
		}
	);

	it('refuses a hostile folder name even though folders are dropped', () => {
		const error = failureOf(() => convert(tarOf([{ name: '../up/', type: 'directory' }])));
		expect(error).toMatchObject({ code: 'files_bad_path' });
	});

	it.each(['a\nb.txt', 'a\u0001.txt', 'back\\slash.txt', `${'x'.repeat(1025)}.txt`])(
		'refuses a name that is not plain text or is too long',
		(name) => {
			const error = failureOf(() => convert(tarOf([{ name: `./${name}`, body: 'x' }])));
			expect(error).toMatchObject({ code: 'files_bad_path' });
		}
	);

	it('never follows a link and reports how many it left behind', () => {
		const converted = convert(
			tarOf([
				{ name: './real.txt', body: 'real' },
				{ name: './soft', type: 'symlink' },
				{ name: './hard', type: 'hardlink' }
			])
		);
		expect(converted).toMatchObject({ files: 1, links: 2 });
		const text = new TextDecoder().decode(converted.sql);
		expect(text).not.toContain('soft');
		expect(text).not.toContain('hard');
		expect(text).not.toContain('passwd');
	});

	it('takes the later of two entries with one path, as tar does on extract', () => {
		const converted = convert(
			tarOf([
				{ name: './dup.txt', body: 'first' },
				{ name: './other.txt', body: 'other' },
				{ name: 'dup.txt', body: 'second' }
			])
		);
		expect(converted.files).toBe(2);
		const site = replay(converted.sql);
		expect(site.read('public://dup.txt')).toEqual(new TextEncoder().encode('second'));
		expect(site.db.prepare('SELECT COUNT(*) AS n FROM cfw_file').get()).toEqual({ n: 2 });
	});

	it('refuses a single file that cannot fit and names the limit', () => {
		const error = failureOf(() =>
			convert(tarOf([{ name: './big.bin', body: new Uint8Array(3000) }]), 0, 4096)
		);
		expect(error).toMatchObject({ code: 'restore_too_large' });
		expect(error.message).toContain('4096 bytes');
	});

	it('counts the database and the files together against the one ceiling', () => {
		const archive = tarOf([{ name: './f.bin', body: random(2000, 9) }]);
		const alone = convert(archive, 0, 8192);
		expect(alone.sql.byteLength).toBeGreaterThan(4000);
		expect(() => convert(archive, 8192 - alone.sql.byteLength, 8192)).not.toThrow();
		const error = failureOf(() => convert(archive, 8192 - alone.sql.byteLength + 1, 8192));
		expect(error).toMatchObject({ code: 'restore_too_large' });
		expect(failureOf(() => convert(archive, 8192, 8192))).toMatchObject({
			code: 'restore_too_large'
		});
	});

	it('refuses an archive larger than the room could ever hold before it reads one header', () => {
		const archive = new Uint8Array(filesArchiveLimit(4096) + 1);
		expect(failureOf(() => convert(archive, 0, 4096))).toMatchObject({
			code: 'restore_too_large'
		});
	});

	it('refuses more files than an import carries', () => {
		const items = Array.from({ length: MAX_FILE_ENTRIES + 1 }, (_, n) => ({
			name: `./f${n}`
		}));
		expect(failureOf(() => convert(tarOf(items)))).toMatchObject({ code: 'files_too_many' });
	});

	it('refuses an archive cut inside a body, inside a header and at a block boundary', () => {
		const whole = tarOf([
			{ name: './a.bin', body: random(2000, 1) },
			{ name: './b.bin', body: random(2000, 2) }
		]);
		for (const cut of [600, 512 + 2048 + 100, 512 + 2048]) {
			expect(
				failureOf(() => convert(whole.slice(0, cut))),
				String(cut)
			).toMatchObject({ code: 'files_unreadable' });
		}
		expect(
			failureOf(() => convert(tarOf([{ name: './a.bin', body: 'x' }], { close: false })))
		).toMatchObject({ code: 'files_unreadable' });
	});

	it('refuses an empty archive and bytes that are not a tar', () => {
		expect(failureOf(() => convert(new Uint8Array(0)))).toMatchObject({
			code: 'files_unreadable'
		});
		const noise = random(4096, 7);
		noise[noise.length - 1] = 1;
		expect(failureOf(() => convert(noise))).toMatchObject({ code: 'files_unreadable' });
	});

	it('keeps text from the archive out of every message', () => {
		const error = failureOf(() => convert(tarOf([{ name: '../SECRETNAME', body: 'x' }])));
		expect(error.message).not.toContain('SECRETNAME');
	});
});

describe('private files', () => {
	const items: TarItem[] = [
		{ name: 'private/', type: 'directory' },
		{ name: 'private/report.pdf', body: 'pdf bytes' },
		{ name: 'private/nested/id card.txt', body: "it's; private" },
		{ name: 'private/.htaccess', body: 'Deny from all' }
	];

	it('drops the folder name and lands the files as private rows the worker keeps', () => {
		const converted = convertFiles(tarOf(items), {
			nowMs: NOW,
			ceilingBytes: CEILING,
			databaseBytes: 0,
			scheme: 'private'
		});
		expect(converted.files).toBe(3);
		const site = replay(converted.sql);
		expect(new TextDecoder().decode(site.read('private://nested/id card.txt'))).toBe(
			"it's; private"
		);
		expect(site.stat('private://report.pdf')).toMatchObject({
			size: 9,
			mime: 'application/pdf',
			evicted: 0,
			hash: null,
			r2site: null
		});
		expect(site.stat('public://report.pdf')).toBeUndefined();
		const queued = site.db.prepare('SELECT uri FROM cfw_file_mirror_queue ORDER BY uri').all();
		expect(queued.map((row) => (row as { uri: string }).uri)).toEqual([
			'private://.htaccess',
			'private://nested/id card.txt',
			'private://report.pdf'
		]);
	});

	it('counts the private files against what the database and the public files left', () => {
		const archive = tarOf([{ name: 'private/big.bin', body: random(4000, 9) }]);
		expect(() =>
			convertFiles(archive, {
				nowMs: NOW,
				ceilingBytes: 6000,
				databaseBytes: 1000,
				scheme: 'private'
			})
		).toThrow(expect.objectContaining({ code: 'restore_too_large' }));
	});

	it('keeps public paths as they were when no scheme is given', () => {
		const converted = convert(tarOf([{ name: './a.txt', body: 'x' }]));
		expect(replay(converted.sql).stat('public://a.txt')).toBeDefined();
	});
});
