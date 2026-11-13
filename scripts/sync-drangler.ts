import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const siblingDefault = fileURLToPath(new URL('../../drangler', import.meta.url));
export const vendorDefault = fileURLToPath(
	new URL('../engine/src/vendor/drangler/', import.meta.url)
);

export type Rewrite = readonly [from: string, to: string];

export interface Source {
	from: string;
	to: string;
	rewrites: readonly Rewrite[];
}

// node-free files only; survey.ts's two type imports point at the hand-written types.ts
export const SOURCES: readonly Source[] = [
	{
		from: 'src/migrate/convert.ts',
		to: 'convert.ts',
		rewrites: [["from '../errors';", "from './errors';"]]
	},
	{
		from: 'src/migrate/survey.ts',
		to: 'survey.ts',
		rewrites: [
			[
				"import type { CommandResult } from '../host/exec';",
				"import type { CommandResult } from './types';"
			],
			[
				"import type { Transport } from './transport';",
				"import type { Transport } from './types';"
			]
		]
	},
	{ from: 'src/errors.ts', to: 'errors.ts', rewrites: [] }
];

export interface VendorRecord {
	version: string;
	files: Record<string, { source: string; sha256: string }>;
}

// every rewrite must match exactly once, so a moved import fails the sync instead of passing through
export function rewriteSource(text: string, rewrites: readonly Rewrite[]): string {
	let out = text;
	for (const [from, to] of rewrites) {
		if (out.split(from).length !== 2) throw new Error(`expected one match for: ${from}`);
		out = out.replace(from, () => to);
	}
	return out;
}

export const sha256 = (bytes: Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

async function dirtyPaths(sibling: string, paths: readonly string[]): Promise<string[]> {
	const { stdout } = await run('git', ['-C', sibling, 'status', '--porcelain', '--', ...paths]);
	return stdout.split('\n').filter((line) => line.trim() !== '');
}

// validates every source before writing, so a refused sync leaves the target untouched
export async function syncDrangler(
	sibling = siblingDefault,
	target = vendorDefault,
	dirty: (sibling: string, paths: readonly string[]) => Promise<string[]> = dirtyPaths
): Promise<VendorRecord> {
	const modified = await dirty(
		sibling,
		SOURCES.map((source) => source.from)
	);
	if (modified.length > 0) {
		throw new Error(`refusing to sync, modified in ${sibling}: ${modified.join(', ')}`);
	}
	const pkg = JSON.parse(await readFile(join(sibling, 'package.json'), 'utf8')) as {
		version: string;
	};
	const record: VendorRecord = { version: pkg.version, files: {} };
	const outputs: [string, string][] = [];
	for (const source of SOURCES) {
		const raw = await readFile(join(sibling, source.from));
		outputs.push([source.to, rewriteSource(raw.toString('utf8'), source.rewrites)]);
		record.files[source.to] = { source: source.from, sha256: sha256(raw) };
	}
	await mkdir(target, { recursive: true });
	for (const [name, text] of outputs) await writeFile(join(target, name), text);
	await writeFile(join(target, 'VERSION.json'), `${JSON.stringify(record, null, '\t')}\n`);
	return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const record = await syncDrangler();
	console.log(`vendored drangler ${record.version}: ${Object.keys(record.files).join(', ')}`);
}
