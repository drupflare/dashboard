import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SYNC_ENTRIES = ['src', 'json-schema', 'vectors', 'README.md'] as const;

export type SyncErrorCode = 'outside_parent' | 'same_directory' | 'would_overwrite' | 'bad_source';

export class SyncError extends Error {
	constructor(
		readonly code: SyncErrorCode,
		message: string,
		readonly files: string[] = []
	) {
		super(message);
		this.name = 'SyncError';
	}
}

export type SyncOptions = {
	source?: string;
	target: string;
	cwd?: string;
	force?: boolean;
	allowOutside?: boolean;
};

export type SyncResult = { copied: string[]; unchanged: string[] };

const defaultSource = fileURLToPath(new URL('../contracts', import.meta.url));

function listFiles(base: string, entry: string): string[] {
	const path = join(base, entry);
	if (!statSync(path, { throwIfNoEntry: false })) {
		throw new SyncError('bad_source', `missing ${entry} in ${base}`);
	}
	if (statSync(path).isFile()) return [entry];
	return readdirSync(path, { recursive: true, withFileTypes: true })
		.filter((item) => item.isFile())
		.map((item) => join(entry, relative(path, join(item.parentPath, item.name))))
		.sort();
}

export function syncContracts(opts: SyncOptions): SyncResult {
	const source = resolve(opts.source ?? defaultSource);
	const target = resolve(opts.target);
	const parent = dirname(resolve(opts.cwd ?? process.cwd()));
	const fromParent = relative(parent, target);
	if (!opts.allowOutside && (fromParent.startsWith('..') || isAbsolute(fromParent))) {
		throw new SyncError(
			'outside_parent',
			`${target} is outside ${parent}; pass --allow-outside`
		);
	}
	if (target === source)
		throw new SyncError('same_directory', 'the target is the source directory');

	const files = SYNC_ENTRIES.flatMap((entry) => listFiles(source, entry));
	const copied: string[] = [];
	const unchanged: string[] = [];
	const conflicts: string[] = [];
	const writes: { path: string; data: Buffer }[] = [];
	for (const file of files) {
		const data = readFileSync(join(source, file));
		const existing = statSync(join(target, file), { throwIfNoEntry: false })
			? readFileSync(join(target, file))
			: null;
		if (existing && existing.equals(data)) unchanged.push(file);
		else if (existing && !opts.force) conflicts.push(file);
		else {
			writes.push({ path: file, data });
			copied.push(file);
		}
	}
	if (conflicts.length > 0) {
		throw new SyncError(
			'would_overwrite',
			`${conflicts.length} file(s) differ in ${target}; pass --force to overwrite`,
			conflicts.sort()
		);
	}
	for (const { path, data } of writes) {
		mkdirSync(dirname(join(target, path)), { recursive: true });
		writeFileSync(join(target, path), data);
	}
	return { copied, unchanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const target = args.find((arg) => !arg.startsWith('--'));
	if (!target) {
		console.error('usage: bun scripts/sync-contracts.ts <target> [--force] [--allow-outside]');
		process.exit(2);
	}
	try {
		const result = syncContracts({
			target,
			force: args.includes('--force'),
			allowOutside: args.includes('--allow-outside')
		});
		console.log(`copied ${result.copied.length}, unchanged ${result.unchanged.length}`);
	} catch (error) {
		if (!(error instanceof SyncError)) throw error;
		console.error(error.message);
		for (const file of error.files) console.error(`  ${file}`);
		process.exit(1);
	}
}
