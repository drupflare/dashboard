import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256Hex } from '../contracts/src/common';
import {
	assetHashOf,
	BUNDLE_VERSION,
	bundleKeys,
	validateBundle,
	type BundleLimits,
	type BundleManifest
} from '../engine/src/bundle';
import { messageOf } from '../engine/src/step';

const USAGE = `usage: bun --tsconfig-override engine/tsconfig.json scripts/build-bundle.ts
  --outdir <dir>        the directory 'wrangler deploy --dry-run --outdir' wrote
  --metadata <file>     the upload metadata the release carries
  --assets-root <dir>   the folder the asset paths are relative to
  --assets-list <file>  one asset path per line, already filtered for the edge
  --release <id> --commit <40 hex> --out <dir>
  --max-module-bytes <n> --max-asset-bytes <n> --max-assets <n> --max-total-bytes <n>
  [--main <module name>]   defaults to index.js

Writes the bundle under <out>/releases/<id>/ and checks it against the limits first.
It does not run wrangler and does not upload anything.`;

const OPTIONS = {
	outdir: { type: 'string' },
	metadata: { type: 'string' },
	'assets-root': { type: 'string' },
	'assets-list': { type: 'string' },
	release: { type: 'string' },
	commit: { type: 'string' },
	out: { type: 'string' },
	main: { type: 'string' },
	'max-module-bytes': { type: 'string' },
	'max-asset-bytes': { type: 'string' },
	'max-assets': { type: 'string' },
	'max-total-bytes': { type: 'string' },
	help: { type: 'boolean' }
} as const;

const SKIPPED = new Set(['README.md']);

const CONTENT_TYPES: Record<string, string> = {
	js: 'application/javascript+module',
	mjs: 'application/javascript+module',
	cjs: 'application/javascript',
	wasm: 'application/wasm',
	txt: 'text/plain',
	lock: 'text/plain'
};

export function contentTypeOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return (
		(dot === -1 ? undefined : CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) ??
		'application/octet-stream'
	);
}

export interface BundleInput {
	releaseId: string;
	workerCommit: string;
	mainModule: string;
	modules: Map<string, Uint8Array>;
	metadata: Uint8Array;
	assets: Map<string, Uint8Array>;
}

export interface BuiltBundle {
	manifest: BundleManifest;
	files: Map<string, Uint8Array>;
}

export async function buildBundle(input: BundleInput, limits: BundleLimits): Promise<BuiltBundle> {
	const files = new Map<string, Uint8Array>();
	const modules = [];
	for (const [name, bytes] of [...input.modules].sort(([a], [b]) => a.localeCompare(b))) {
		files.set(bundleKeys.module(input.releaseId, name), bytes);
		modules.push({
			name,
			contentType: contentTypeOf(name),
			sha256: await sha256Hex(bytes),
			size: bytes.byteLength
		});
	}
	files.set(bundleKeys.metadata(input.releaseId), input.metadata);
	const assets = [];
	for (const [path, bytes] of [...input.assets].sort(([a], [b]) => a.localeCompare(b))) {
		const hash = await assetHashOf(bytes);
		files.set(bundleKeys.asset(input.releaseId, hash), bytes);
		assets.push({ path, hash, size: bytes.byteLength });
	}
	const manifest = validateBundle(
		{
			v: BUNDLE_VERSION,
			releaseId: input.releaseId,
			workerCommit: input.workerCommit,
			mainModule: input.mainModule,
			modules,
			metadata: { sha256: await sha256Hex(input.metadata), size: input.metadata.byteLength },
			assets,
			counts: { modules: modules.length, assets: assets.length }
		},
		limits
	);
	files.set(
		bundleKeys.manifest(input.releaseId),
		new TextEncoder().encode(JSON.stringify(manifest))
	);
	return { manifest, files };
}

async function walk(root: string, dir = root): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walk(root, path)));
		else found.push(relative(root, path).split(sep).join('/'));
	}
	return found.sort();
}

export async function readModules(dir: string): Promise<Map<string, Uint8Array>> {
	const modules = new Map<string, Uint8Array>();
	for (const name of await walk(dir)) {
		if (SKIPPED.has(name) || name.endsWith('.map')) continue;
		modules.set(name, new Uint8Array(await readFile(join(dir, name))));
	}
	return modules;
}

export async function readAssets(root: string, listFile: string): Promise<Map<string, Uint8Array>> {
	const assets = new Map<string, Uint8Array>();
	const lines = (await readFile(listFile, 'utf8')).split('\n').map((line) => line.trim());
	for (const line of lines) {
		if (line === '') continue;
		const clean = posix.normalize(line.replace(/^\/+/, ''));
		const file = resolve(root, clean);
		if (clean.startsWith('..') || !file.startsWith(resolve(root) + sep)) {
			throw new Error(`${line} leaves the assets root`);
		}
		assets.set(`/${clean}`, new Uint8Array(await readFile(file)));
	}
	return assets;
}

function whole(name: string, value: string | undefined): number {
	const parsed = Number(value);
	if (value === undefined || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`--${name} is required and must be a positive whole number`);
	}
	return parsed;
}

function needed(name: string, value: string | undefined): string {
	if (value === undefined || value === '') throw new Error(`--${name} is required`);
	return value;
}

export interface RunResult {
	code: number;
	out: string;
}

export async function run(argv: string[]): Promise<RunResult> {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) return { code: 0, out: USAGE };
		const releaseId = needed('release', values.release);
		const outDir = resolve(needed('out', values.out));
		const limits: BundleLimits = {
			maxModuleBytes: whole('max-module-bytes', values['max-module-bytes']),
			maxAssetBytes: whole('max-asset-bytes', values['max-asset-bytes']),
			maxAssets: whole('max-assets', values['max-assets']),
			maxTotalBytes: whole('max-total-bytes', values['max-total-bytes'])
		};
		const built = await buildBundle(
			{
				releaseId,
				workerCommit: needed('commit', values.commit),
				mainModule: values.main ?? 'index.js',
				modules: await readModules(resolve(needed('outdir', values.outdir))),
				metadata: new Uint8Array(await readFile(needed('metadata', values.metadata))),
				assets: await readAssets(
					resolve(needed('assets-root', values['assets-root'])),
					needed('assets-list', values['assets-list'])
				)
			},
			limits
		);
		const target = join(outDir, 'releases', releaseId);
		const existing = await readdir(target).catch(() => []);
		if (existing.length > 0)
			throw new Error(`${target} already has files; choose an empty --out`);
		for (const [key, bytes] of built.files) {
			const path = join(outDir, key);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, bytes);
		}
		const { manifest } = built;
		return {
			code: 0,
			out: `${releaseId}: ${manifest.counts.modules} modules and ${manifest.counts.assets} assets written to ${target}`
		};
	} catch (error) {
		const message = messageOf(error);
		return { code: 1, out: `${message}\n\n${USAGE}` };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { code, out } = await run(process.argv.slice(2));
	(code === 0 ? console.log : console.error)(out);
	process.exit(code);
}
