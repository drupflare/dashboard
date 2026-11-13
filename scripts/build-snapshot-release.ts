import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BOX_ARCHIVE_ROUTE, boxArchiveKey } from '../engine/src/box-archive';
import type { BundleLimits, BundleManifest } from '../engine/src/bundle';
import { messageOf } from '../engine/src/step';
import { payloadOf } from '../src/server/domain/node-site';
import { run as buildBundle } from './build-bundle';
import { readConfig } from './render-deploy';

const USAGE = `usage: bun --tsconfig-override engine/tsconfig.json scripts/build-snapshot-release.ts
  --out <dir>        where releases/<id>/ is written; outside the worker checkout
  [--worker <dir>]   the worker checkout, default the sibling ../worker
  [--withhold <dir>] leave assets/<dir> out of the bundle; repeat for more, recorded in snapshot.json
  [--link-host <host>]       the host a box downloads its archive from, default the host of the
                             route in deploy/engine.staging.json; production passes its own
  [--schema-version <n>]     default the worker's PACK_VERSION
  [--accepts-schema <n>]     default the schema version
  [--id-only]        print the release id and stop

Builds the managed bundle from the worker's pinned commit plus its working tree, the way
release.yml builds one for a tag, and names it snap-<7 hex of HEAD>-<8 hex of a tree hash>.
The tree hash covers every tracked and every untracked, non-ignored file. The same run builds the
box bundle from the same tree, puts it at releases/<id>/box/<name>.tar.gz and writes payload.json
beside the manifest, pointing at https://<link host>/link/payload/<id>/<name>.tar.gz with the
archive's line from SHA256SUMS. It reads git and never writes to it, and it does not upload, tag or
push anything.`;

const OPTIONS = {
	worker: { type: 'string' },
	out: { type: 'string' },
	withhold: { type: 'string', multiple: true },
	'link-host': { type: 'string' },
	'schema-version': { type: 'string' },
	'accepts-schema': { type: 'string' },
	'id-only': { type: 'boolean' },
	help: { type: 'boolean' }
} as const;

const CONFIG = 'wrangler.managed.jsonc';
const BOX_CONFIG = 'wrangler.jsonc';
const STAGING_ENGINE = 'deploy/engine.staging.json';
const LINK_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SUMS_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;
const READ_ONLY_GIT = new Set(['rev-parse', 'ls-files', 'diff']);
const HEAD = /^[0-9a-f]{40}$/;

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const gitRead: GitRunner = (args, cwd) => {
	if (!READ_ONLY_GIT.has(args[0] ?? '')) {
		return Promise.reject(new Error(`git ${args[0]} is not a read-only command`));
	}
	return new Promise((resolvePromise, reject) => {
		execFile(
			'git',
			args,
			{ cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) =>
				error
					? reject(new Error(`git ${args[0]} failed: ${stderr.trim() || error.message}`))
					: resolvePromise(stdout)
		);
	});
};

export interface TreeEntry {
	path: string;
	sha256: string;
}

// path NUL digest per line, in byte order of the path, so the order git lists them in cannot matter
export function treeHash(entries: readonly TreeEntry[]): string {
	const sorted = [...entries].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))
	);
	const hash = createHash('sha256');
	for (const entry of sorted) hash.update(`${entry.path}\0${entry.sha256}\n`);
	return hash.digest('hex');
}

export interface Snapshot {
	id: string;
	head: string;
	tree: string;
	files: number;
	changed: number;
}

const split = (listing: string): string[] => listing.split('\0').filter((path) => path !== '');

async function fileDigest(file: string): Promise<string> {
	const stat = await lstat(file);
	if (stat.isSymbolicLink()) {
		return createHash('sha256')
			.update(`symlink:${await readlink(file)}`)
			.digest('hex');
	}
	if (stat.isDirectory()) return createHash('sha256').update('directory').digest('hex');
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

export async function snapshotOf(worker: string, git: GitRunner = gitRead): Promise<Snapshot> {
	const head = (await git(['rev-parse', 'HEAD'], worker)).trim();
	if (!HEAD.test(head)) throw new Error(`git answered ${head} for HEAD, not a 40 character sha`);
	const tracked = split(await git(['ls-files', '-z'], worker));
	const deleted = new Set(split(await git(['ls-files', '-z', '-d'], worker)));
	const untracked = split(await git(['ls-files', '-z', '-o', '--exclude-standard'], worker));
	const changedTracked = split(await git(['diff', '--name-only', '-z', 'HEAD'], worker));
	const paths = [...new Set([...tracked.filter((path) => !deleted.has(path)), ...untracked])];
	const entries: TreeEntry[] = [];
	for (let at = 0; at < paths.length; at += 32) {
		const batch = paths.slice(at, at + 32);
		const digests = await Promise.all(batch.map((path) => fileDigest(join(worker, path))));
		batch.forEach((path, index) => entries.push({ path, sha256: digests[index]! }));
	}
	const tree = treeHash(entries);
	return {
		id: `snap-${head.slice(0, 7)}-${tree.slice(0, 8)}`,
		head,
		tree,
		files: entries.length,
		changed: new Set([...changedTracked, ...untracked]).size
	};
}

export interface Args {
	worker: string;
	out: string;
	idOnly: boolean;
	withhold: string[];
	linkHost: string;
	schemaVersion?: number;
	acceptsSchema?: number;
}

export const DASHBOARD_ROOT = fileURLToPath(new URL('..', import.meta.url));

// the host of the stage engine's link route, which serves the box archives the stage store holds
export function stagingLinkHost(dashboardRoot = DASHBOARD_ROOT): string {
	const routes = readConfig(join(dashboardRoot, STAGING_ENGINE)).routes as
		{ pattern?: string }[] | undefined;
	const host = routes?.[0]?.pattern?.split('/')[0] ?? '';
	if (!LINK_HOST.test(host)) throw new Error(`${STAGING_ENGINE} has no route with a usable host`);
	return host;
}

function schemaFlag(name: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number, zero or more`);
	return Number(value);
}

// the output must sit outside the worker checkout, or writing it would change the tree it names
export function checkArgs(argv: string[], dashboardRoot = DASHBOARD_ROOT): Args | 'help' {
	const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
	if (values.help) return 'help';
	const worker = resolve(values.worker ?? join(dashboardRoot, '..', 'worker'));
	if (!existsSync(join(worker, CONFIG))) throw new Error(`${worker} has no ${CONFIG}`);
	if (values['id-only']) return { worker, out: '', idOnly: true, withhold: [], linkHost: '' };
	if (values.out === undefined || values.out === '') throw new Error('--out is required');
	const out = resolve(values.out);
	const inside = relative(worker, out);
	if (inside === '' || (!inside.startsWith('..') && !inside.startsWith(sep))) {
		throw new Error(`--out ${out} is inside the worker checkout; choose a folder outside it`);
	}
	const withhold = values.withhold ?? [];
	for (const name of withhold) {
		if (!/^[A-Za-z0-9._-]+$/.test(name))
			throw new Error(`--withhold ${name} is not a folder name`);
	}
	const linkHost = values['link-host'] ?? stagingLinkHost(dashboardRoot);
	if (!LINK_HOST.test(linkHost)) throw new Error(`--link-host ${linkHost} is not a host name`);
	return {
		worker,
		out,
		idOnly: false,
		withhold,
		linkHost,
		schemaVersion: schemaFlag('schema-version', values['schema-version']),
		acceptsSchema: schemaFlag('accepts-schema', values['accepts-schema'])
	};
}

// the byte limits the engine enforces on a bundle, read from its config so the two cannot drift
export function engineLimits(dashboardRoot = DASHBOARD_ROOT): BundleLimits {
	const vars = (readConfig(join(dashboardRoot, 'engine/wrangler.jsonc')).vars ?? {}) as Record<
		string,
		string | number
	>;
	const limit = (name: string): number => {
		const value = Number(vars[name]);
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error(`engine/wrangler.jsonc has no usable ${name}`);
		}
		return value;
	};
	return {
		maxModuleBytes: limit('LIMIT_MODULE_BYTES'),
		maxTotalBytes: limit('LIMIT_TOTAL_BYTES'),
		maxAssetBytes: limit('LIMIT_ASSET_BYTES'),
		maxAssets: limit('LIMIT_ASSETS')
	};
}

function runFile(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, _out, stderr) =>
			error
				? reject(new Error(`${file} failed: ${stderr.trim() || error.message}`))
				: resolvePromise()
		);
	});
}

interface WorkerBundleTools {
	readShippedAssets(root: string): Map<string, Uint8Array>;
	uploadMetadata(root: string, config: string, mainModule: string): Uint8Array;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fileSha256(file: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

// the one sha256sum line the worker's box script appended: its digest and the archive name
export function archiveOfSums(text: string): { sha256: string; name: string } {
	const lines = text.split('\n').filter((line) => line !== '');
	const match = lines.length === 1 ? SUMS_LINE.exec(lines[0]!) : null;
	if (match === null) {
		throw new Error(
			`the box script's sums file holds ${lines.length} lines, not one sums line`
		);
	}
	return { sha256: match[1]!, name: match[2]! };
}

export function boxArchiveUrl(linkHost: string, releaseId: string, name: string): string {
	return `https://${linkHost}${BOX_ARCHIVE_ROUTE}${releaseId}/${name}`;
}

export interface BoxSchema {
	schemaVersion: number;
	acceptsSchema: number;
	source: string;
}

// the data schema a worker release leaves a site at is the pack version its reconcile steps end
// on; a flag overrides it, and a release accepts only sites already at its own version by default
export async function boxSchemaOf(args: Args): Promise<BoxSchema> {
	let schemaVersion = args.schemaVersion;
	let source = '--schema-version';
	if (schemaVersion === undefined) {
		const reconcile = (await import(
			pathToFileURL(join(args.worker, 'src/ops/reconcile.ts')).href
		)) as { PACK_VERSION?: unknown };
		if (
			!Number.isSafeInteger(reconcile.PACK_VERSION) ||
			(reconcile.PACK_VERSION as number) < 0
		) {
			throw new Error('the worker has no usable PACK_VERSION in src/ops/reconcile.ts');
		}
		schemaVersion = reconcile.PACK_VERSION as number;
		source = 'worker src/ops/reconcile.ts PACK_VERSION';
	}
	return {
		schemaVersion,
		acceptsSchema: args.acceptsSchema ?? schemaVersion,
		source: args.acceptsSchema === undefined ? source : `${source}, --accepts-schema`
	};
}

export interface BuiltBox {
	name: string;
	bytes: number;
	sha256: string;
	url: string;
	schema: BoxSchema;
}

// packs the box bundle from the canonical config of the same tree with the worker's own script,
// and returns the archive with the digest the script wrote to its sums file
async function packBox(
	args: Args,
	snapshot: Snapshot,
	work: string
): Promise<{ file: string; name: string; sha256: string }> {
	const out = join(work, 'box');
	const sums = join(out, 'SHA256SUMS');
	await mkdir(out, { recursive: true });
	await runFile(
		process.versions.bun ? process.execPath : 'bun',
		[
			'scripts/build-box-bundle.ts',
			`--outdir=${join(work, 'wrangler-box')}`,
			`--out=${out}`,
			`--version=${snapshot.id}`,
			`--sums=${sums}`
		],
		args.worker,
		process.env
	);
	const line = archiveOfSums(await readFile(sums, 'utf8'));
	const file = join(out, line.name);
	// the digest the box checks and the one the release lists are read two ways and must agree
	const computed = await fileSha256(file);
	if (computed !== line.sha256) {
		throw new Error(`${line.name} hashes to ${computed}, its sums line says ${line.sha256}`);
	}
	return { file, name: line.name, sha256: line.sha256 };
}

export interface Built {
	snapshot: Snapshot;
	manifest: BundleManifest;
	manifestSha256: string;
	moduleBytes: number;
	assetBytes: number;
	limits: BundleLimits;
	withheld: string[];
	target: string;
	box: BuiltBox;
}

export async function build(
	args: Args,
	dashboardRoot = DASHBOARD_ROOT,
	git: GitRunner = gitRead
): Promise<Built> {
	const limits = engineLimits(dashboardRoot);
	const snapshot = await snapshotOf(args.worker, git);
	const work = await mkdtemp(join(tmpdir(), 'snapshot-release-'));
	let box: BuiltBox;
	try {
		// the build command in the config would hydrate over the tree this release is named for
		for (const [config, outdir] of [
			[CONFIG, 'wrangler'],
			[BOX_CONFIG, 'wrangler-box']
		]) {
			await runFile(
				join(args.worker, 'node_modules/.bin/wrangler'),
				['deploy', '--dry-run', `--outdir=${join(work, outdir!)}`, '-c', config!],
				args.worker,
				{ ...process.env, DRUPFLARE_HYDRATING: '1' }
			);
		}
		const packed = await packBox(args, snapshot, work);
		const after = await snapshotOf(args.worker, git);
		if (after.id !== snapshot.id) {
			throw new Error(
				`the worker tree changed during the build: ${snapshot.id} became ${after.id}`
			);
		}
		const schema = await boxSchemaOf(args);
		box = {
			name: packed.name,
			bytes: (await stat(packed.file)).size,
			sha256: packed.sha256,
			url: boxArchiveUrl(args.linkHost, snapshot.id, packed.name),
			schema
		};
		const tools = (await import(
			pathToFileURL(join(args.worker, 'scripts/build-managed-bundle.ts')).href
		)) as WorkerBundleTools;
		const entry = String(readConfig(join(args.worker, CONFIG)).main);
		const mainModule = `${posix.basename(entry).replace(/\.[cm]?[tj]s$/, '')}.js`;
		const assets = tools.readShippedAssets(args.worker);
		await writeFile(
			join(work, 'metadata.json'),
			tools.uploadMetadata(args.worker, CONFIG, mainModule)
		);
		await writeFile(
			join(work, 'assets.txt'),
			[...assets.keys()]
				.map((path) => path.slice(1))
				.filter((path) => !args.withhold.some((name) => path.startsWith(`${name}/`)))
				.join('\n')
		);
		const result = await buildBundle([
			`--outdir=${join(work, 'wrangler')}`,
			`--metadata=${join(work, 'metadata.json')}`,
			`--assets-root=${join(args.worker, 'assets')}`,
			`--assets-list=${join(work, 'assets.txt')}`,
			`--release=${snapshot.id}`,
			`--commit=${snapshot.head}`,
			`--out=${args.out}`,
			`--main=${mainModule}`,
			`--max-module-bytes=${limits.maxModuleBytes}`,
			`--max-asset-bytes=${limits.maxAssetBytes}`,
			`--max-assets=${limits.maxAssets}`,
			`--max-total-bytes=${limits.maxTotalBytes}`,
			`--payload-url=${box.url}`,
			`--payload-sha256=${box.sha256}`,
			`--payload-schema-version=${schema.schemaVersion}`,
			`--payload-accepts-schema=${schema.acceptsSchema}`
		]);
		if (result.code !== 0) throw new Error(result.out.split('\n\n')[0]);
		// the bundle writer refuses a target that already holds files, so the archive goes in last
		const archive = join(args.out, boxArchiveKey(snapshot.id, packed.name));
		await mkdir(dirname(archive), { recursive: true });
		await copyFile(packed.file, archive);
		if ((await fileSha256(archive)) !== box.sha256) {
			throw new Error(`${archive} does not hash to ${box.sha256} after the copy`);
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	const target = join(args.out, 'releases', snapshot.id);
	const written = payloadOf(JSON.parse(await readFile(join(target, 'payload.json'), 'utf8')));
	if (written?.url !== box.url || written.checksum !== `sha256:${box.sha256}`) {
		throw new Error('payload.json is not the payload the box takes for this archive');
	}
	const manifestBytes = new Uint8Array(await readFile(join(target, 'manifest.json')));
	const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BundleManifest;
	// the engine's manifest schema is strict, so the snapshot facts sit beside it
	await writeFile(
		join(target, 'snapshot.json'),
		JSON.stringify({
			releaseId: snapshot.id,
			workerCommit: snapshot.head,
			dirty: snapshot.changed > 0,
			changedFiles: snapshot.changed,
			trackedAndUntrackedFiles: snapshot.files,
			treeSha256: snapshot.tree,
			assetsSha256: sha256(new TextEncoder().encode(JSON.stringify(manifest.assets))),
			withheldAssetFolders: args.withhold,
			tag: null,
			box: {
				name: box.name,
				bytes: box.bytes,
				sha256: box.sha256,
				url: box.url,
				schemaVersion: box.schema.schemaVersion,
				acceptsSchema: box.schema.acceptsSchema,
				schemaSource: box.schema.source
			}
		})
	);
	return {
		snapshot,
		manifest,
		manifestSha256: sha256(manifestBytes),
		moduleBytes: manifest.modules.reduce((sum, module) => sum + module.size, 0),
		assetBytes: manifest.assets.reduce((sum, asset) => sum + asset.size, 0),
		limits,
		withheld: args.withhold,
		target,
		box
	};
}

export function summary(built: Built): string {
	const { snapshot, manifest, limits } = built;
	const total = built.moduleBytes + built.assetBytes + manifest.metadata.size;
	return [
		`release ${snapshot.id}`,
		`head ${snapshot.head}, ${snapshot.changed} changed files, ${snapshot.files} files hashed`,
		`manifest sha256 ${built.manifestSha256}`,
		`modules ${manifest.counts.modules}, ${built.moduleBytes} bytes (largest allowed ${limits.maxModuleBytes})`,
		`assets ${manifest.counts.assets} of ${limits.maxAssets}, ${built.assetBytes} bytes (largest allowed ${limits.maxAssetBytes})`,
		`total ${total} of ${limits.maxTotalBytes} bytes`,
		`withheld asset folders: ${built.withheld.length === 0 ? 'none' : built.withheld.join(', ')}`,
		`box archive ${built.box.name}, ${built.box.bytes} bytes, sha256 ${built.box.sha256}`,
		`payload ${built.box.url}`,
		`schema ${built.box.schema.schemaVersion}, accepts ${built.box.schema.acceptsSchema} (${built.box.schema.source})`,
		`written to ${built.target}`
	].join('\n');
}

export async function run(argv: string[]): Promise<{ code: number; out: string }> {
	try {
		const args = checkArgs(argv);
		if (args === 'help') return { code: 0, out: USAGE };
		if (args.idOnly) return { code: 0, out: (await snapshotOf(args.worker)).id };
		return { code: 0, out: summary(await build(args)) };
	} catch (error) {
		return { code: 1, out: `${messageOf(error)}\n\n${USAGE}` };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { code, out } = await run(process.argv.slice(2));
	(code === 0 ? console.log : console.error)(out);
	process.exit(code);
}
