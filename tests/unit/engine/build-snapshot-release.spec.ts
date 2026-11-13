import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	archiveOfSums,
	boxArchiveUrl,
	boxSchemaOf,
	build,
	checkArgs,
	engineLimits,
	gitRead,
	run,
	snapshotOf,
	stagingLinkHost,
	treeHash,
	type Args,
	type GitRunner
} from '../../../scripts/build-snapshot-release';
import { payloadOf } from '../../../src/server/domain/node-site';

const HEAD = 'ab12cd34ef56'.padEnd(40, '0');
const made: string[] = [];

async function worker(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'snapshot-spec-'));
	made.push(dir);
	await writeFile(join(dir, 'wrangler.managed.jsonc'), '{}');
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(dir, path, '..'), { recursive: true });
		await writeFile(join(dir, path), text);
	}
	return dir;
}

const z = (...paths: string[]) => paths.map((path) => `${path}\0`).join('');

// answers what git would for a tree whose listings are given
function gitWith(listing: {
	tracked: string[];
	deleted?: string[];
	untracked?: string[];
	diff?: string[];
	head?: string;
}): GitRunner {
	return async (args) => {
		if (args[0] === 'rev-parse') return `${listing.head ?? HEAD}\n`;
		if (args[0] === 'diff') return z(...(listing.diff ?? []));
		if (args.includes('-d')) return z(...(listing.deleted ?? []));
		if (args.includes('-o')) return z(...(listing.untracked ?? []));
		return z(...listing.tracked);
	};
}

afterAll(async () => {
	for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe('treeHash', () => {
	it('does not depend on the order the entries arrive in', () => {
		const a = { path: 'a.txt', sha256: '1'.repeat(64) };
		const b = { path: 'b.txt', sha256: '2'.repeat(64) };
		expect(treeHash([a, b])).toBe(treeHash([b, a]));
	});

	it('changes when a path or a digest changes', () => {
		const base = [{ path: 'a.txt', sha256: '1'.repeat(64) }];
		expect(treeHash(base)).not.toBe(treeHash([{ path: 'a.txt', sha256: '2'.repeat(64) }]));
		expect(treeHash(base)).not.toBe(treeHash([{ path: 'c.txt', sha256: '1'.repeat(64) }]));
	});
});

describe('snapshotOf', () => {
	it('names the release from the head and the tree, the same twice in a row', async () => {
		const dir = await worker({ 'a.txt': 'one', 'src/b.txt': 'two' });
		const git = gitWith({ tracked: ['a.txt', 'src/b.txt'] });
		const first = await snapshotOf(dir, git);
		const second = await snapshotOf(dir, git);
		expect(first).toEqual(second);
		expect(first.id).toBe(`snap-${HEAD.slice(0, 7)}-${first.tree.slice(0, 8)}`);
		expect(first.id).toMatch(/^snap-[0-9a-f]{7}-[0-9a-f]{8}$/);
		expect(first.head).toBe(HEAD);
		expect(first.files).toBe(2);
	});

	it('changes when one byte of one file changes', async () => {
		const dir = await worker({ 'a.txt': 'one', 'b.txt': 'two' });
		const git = gitWith({ tracked: ['a.txt', 'b.txt'] });
		const before = await snapshotOf(dir, git);
		await writeFile(join(dir, 'b.txt'), 'twp');
		expect((await snapshotOf(dir, git)).id).not.toBe(before.id);
	});

	it('ignores a file time stamp', async () => {
		const dir = await worker({ 'a.txt': 'one' });
		const git = gitWith({ tracked: ['a.txt'] });
		const before = await snapshotOf(dir, git);
		await utimes(join(dir, 'a.txt'), new Date('2001-01-01'), new Date('2001-01-01'));
		expect((await snapshotOf(dir, git)).id).toBe(before.id);
	});

	it('ignores a file git does not list, as one in .gitignore is not', async () => {
		const dir = await worker({ 'a.txt': 'one' });
		const git = gitWith({ tracked: ['a.txt'] });
		const before = await snapshotOf(dir, git);
		await writeFile(join(dir, 'ignored.bin'), 'build output');
		expect((await snapshotOf(dir, git)).id).toBe(before.id);
	});

	it('counts an untracked file in the hash and leaves a deleted one out', async () => {
		const dir = await worker({ 'a.txt': 'one', 'new.txt': 'fresh' });
		const clean = await snapshotOf(dir, gitWith({ tracked: ['a.txt'] }));
		const withNew = await snapshotOf(
			dir,
			gitWith({ tracked: ['a.txt'], untracked: ['new.txt'] })
		);
		expect(withNew.id).not.toBe(clean.id);
		const withGone = await snapshotOf(
			dir,
			gitWith({ tracked: ['a.txt', 'gone.txt'], deleted: ['gone.txt'] })
		);
		expect(withGone.id).toBe(clean.id);
	});

	it('counts changed files from the diff and the untracked files, once each', async () => {
		const dir = await worker({ 'a.txt': 'one', 'new.txt': 'fresh' });
		const snapshot = await snapshotOf(
			dir,
			gitWith({
				tracked: ['a.txt'],
				untracked: ['new.txt'],
				diff: ['a.txt', 'gone.txt']
			})
		);
		expect(snapshot.changed).toBe(3);
		expect((await snapshotOf(dir, gitWith({ tracked: ['a.txt'] }))).changed).toBe(0);
	});

	it('refuses a head that is not a 40 character sha', async () => {
		const dir = await worker({ 'a.txt': 'one' });
		await expect(
			snapshotOf(dir, gitWith({ tracked: ['a.txt'], head: 'main' }))
		).rejects.toThrow('not a 40 character sha');
	});
});

describe('gitRead', () => {
	it('refuses every command that writes', async () => {
		for (const command of ['commit', 'add', 'tag', 'checkout', 'push', 'stash']) {
			await expect(gitRead([command], tmpdir())).rejects.toThrow('not a read-only command');
		}
	});
});

describe('checkArgs', () => {
	it('answers help without a checkout', () => {
		expect(checkArgs(['--help'])).toBe('help');
	});

	it('wants an output folder', async () => {
		const dir = await worker({});
		expect(() => checkArgs([`--worker=${dir}`])).toThrow('--out is required');
	});

	it('wants a worker checkout that carries the managed config', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'snapshot-empty-'));
		made.push(dir);
		expect(() => checkArgs([`--worker=${dir}`, '--out=/tmp/x'])).toThrow(
			'has no wrangler.managed.jsonc'
		);
	});

	it('refuses an output folder inside the worker checkout, which would change the tree it names', async () => {
		const dir = await worker({});
		expect(() => checkArgs([`--worker=${dir}`, `--out=${join(dir, 'out')}`])).toThrow(
			'inside the worker checkout'
		);
		expect(() => checkArgs([`--worker=${dir}`, `--out=${dir}`])).toThrow(
			'inside the worker checkout'
		);
	});

	it('accepts a folder beside the checkout, and the id-only form with no folder at all', async () => {
		const dir = await worker({});
		expect(checkArgs([`--worker=${dir}`, `--out=${dir}-out`, '--withhold=bootimage'])).toEqual({
			worker: dir,
			out: `${dir}-out`,
			idOnly: false,
			withhold: ['bootimage'],
			linkHost: stagingLinkHost()
		});
		expect(checkArgs([`--worker=${dir}`, '--id-only'])).toMatchObject({ idOnly: true });
	});

	it('refuses a withheld name that is a path, and an unknown option', async () => {
		const dir = await worker({});
		expect(() => checkArgs([`--worker=${dir}`, '--out=/tmp/x', '--withhold=../etc'])).toThrow(
			'not a folder name'
		);
		expect(() => checkArgs(['--nope'])).toThrow();
	});

	it('turns a refusal into a failing exit code with the usage after it', async () => {
		const result = await run(['--worker=/no/such/place', '--out=/tmp/x']);
		expect(result.code).toBe(1);
		expect(result.out).toContain('has no wrangler.managed.jsonc');
		expect(result.out).toContain('usage:');
	});
});

describe('engineLimits', () => {
	it('reads the four limits the engine enforces from its config', () => {
		const limits = engineLimits();
		for (const value of Object.values(limits)) expect(Number.isSafeInteger(value)).toBe(true);
		expect(limits.maxTotalBytes).toBeGreaterThan(0);
	});
});

describe('the box archive naming', () => {
	const sums = (digest: string, name: string) => `${digest}  ${name}\n`;
	const DIGEST = 'a'.repeat(64);

	it('reads the one sums line the box script writes', () => {
		expect(archiveOfSums(sums(DIGEST, 'drupflare-box-bundle-snap-1.tar.gz'))).toEqual({
			sha256: DIGEST,
			name: 'drupflare-box-bundle-snap-1.tar.gz'
		});
	});

	it.each([
		['an empty file', ''],
		['two lines', sums(DIGEST, 'a.tar.gz') + sums(DIGEST, 'b.tar.gz')],
		['an uppercase digest', sums('A'.repeat(64), 'a.tar.gz')],
		['a short digest', sums('a'.repeat(63), 'a.tar.gz')],
		['one space between digest and name', `${DIGEST} a.tar.gz\n`],
		['a name with a space', `${DIGEST}  a b.tar.gz\n`]
	])('refuses %s', (_label, text) => {
		expect(() => archiveOfSums(text)).toThrow('not one sums line');
	});

	it('puts the release id and the file name under the link route of the given host', () => {
		expect(boxArchiveUrl('link-staging.example.com', 'snap-b551063-59cff488', 'x.tar.gz')).toBe(
			'https://link-staging.example.com/link/payload/snap-b551063-59cff488/x.tar.gz'
		);
	});

	it('takes the link host from the route pattern of the stage engine config', async () => {
		const root = await mkdtemp(join(tmpdir(), 'snapshot-root-'));
		made.push(root);
		await mkdir(join(root, 'deploy'));
		const write = (routes: unknown) =>
			writeFile(join(root, 'deploy/engine.staging.json'), JSON.stringify({ routes }));
		await write([{ pattern: 'link-x.example.com/link/*', zone_name: 'example.com' }]);
		expect(stagingLinkHost(root)).toBe('link-x.example.com');
		await write([]);
		expect(() => stagingLinkHost(root)).toThrow('no route with a usable host');
		await write([{ pattern: '*/link/*' }]);
		expect(() => stagingLinkHost(root)).toThrow('no route with a usable host');
	});

	it('defaults the link host from the stage config and accepts another one', async () => {
		const dir = await worker({});
		const args = (flags: string[]) =>
			checkArgs([`--worker=${dir}`, `--out=${dir}-out`, ...flags]);
		expect(args([])).toMatchObject({ linkHost: stagingLinkHost() });
		expect(args(['--link-host=link.example.com'])).toMatchObject({
			linkHost: 'link.example.com'
		});
		for (const bad of [
			'link.example.com/x',
			'https://link.example.com',
			'LINK.example.com',
			'nodot'
		]) {
			expect(() => args([`--link-host=${bad}`])).toThrow('is not a host name');
		}
	});

	it('reads the schema flags as whole numbers and leaves them unset otherwise', async () => {
		const dir = await worker({});
		const args = (flags: string[]) =>
			checkArgs([`--worker=${dir}`, `--out=${dir}-out`, ...flags]);
		expect(args([])).toMatchObject({ schemaVersion: undefined, acceptsSchema: undefined });
		expect(args(['--schema-version=9', '--accepts-schema=3'])).toMatchObject({
			schemaVersion: 9,
			acceptsSchema: 3
		});
		for (const bad of ['', '-1', '1.5', ' 2', 'x']) {
			expect(() => args([`--schema-version=${bad}`])).toThrow('whole number');
			expect(() => args([`--accepts-schema=${bad}`])).toThrow('whole number');
		}
	});
});

describe('boxSchemaOf', () => {
	const argsFor = (dir: string, extra: Partial<Args> = {}): Args => ({
		worker: dir,
		out: '',
		idOnly: false,
		withhold: [],
		linkHost: 'link.example.com',
		...extra
	});

	async function reconcile(source: string): Promise<string> {
		const dir = await worker({ 'src/ops/reconcile.ts': source });
		return dir;
	}

	it('reads the pack version the worker reconciles to, and accepts only that version', async () => {
		const dir = await reconcile('export const PACK_VERSION = 7;');
		expect(await boxSchemaOf(argsFor(dir))).toEqual({
			schemaVersion: 7,
			acceptsSchema: 7,
			source: 'worker src/ops/reconcile.ts PACK_VERSION'
		});
	});

	it('lets the flags override either number', async () => {
		const dir = await reconcile('export const PACK_VERSION = 7;');
		expect(await boxSchemaOf(argsFor(dir, { acceptsSchema: 2 }))).toMatchObject({
			schemaVersion: 7,
			acceptsSchema: 2
		});
		expect(await boxSchemaOf(argsFor(dir, { schemaVersion: 9 }))).toMatchObject({
			schemaVersion: 9,
			acceptsSchema: 9,
			source: '--schema-version'
		});
	});

	it('refuses a worker whose pack version is missing or not a whole number', async () => {
		for (const source of [
			'export const OTHER = 1;',
			'export const PACK_VERSION = -1;',
			'export const PACK_VERSION = 1.5;',
			'export const PACK_VERSION = "7";'
		]) {
			await expect(boxSchemaOf(argsFor(await reconcile(source)))).rejects.toThrow(
				'no usable PACK_VERSION'
			);
		}
	});
});

describe('build', () => {
	const SHEBANG = '#!/bin/sh\n';
	const WRANGLER =
		SHEBANG +
		'for a in "$@"; do case "$a" in --outdir=*) out="${a#--outdir=}";; esac; done\n' +
		'mkdir -p "$out"\n' +
		'echo \'export default {}\' > "$out/site.js"\n' +
		'echo "$@" >> "$(dirname "$0")/calls.log"\n';
	// stands in for the worker's script: one archive and its sums line, honest unless told otherwise
	const BOX_SCRIPT = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const arg = (name) => process.argv.find((a) => a.startsWith('--' + name + '=')).slice(name.length + 3);
mkdirSync(arg('out'), { recursive: true });
const name = 'drupflare-box-bundle-' + arg('version') + '.tar.gz';
const bytes = Buffer.from('box bytes for ' + arg('version'));
writeFileSync(join(arg('out'), name), bytes);
const digest = createHash('sha256').update(process.env.FAKE_BOX_SUMS === 'wrong' ? 'other' : bytes).digest('hex');
appendFileSync(arg('sums'), digest + '  ' + name + '\\n');
`;
	const TREE = [
		'wrangler.managed.jsonc',
		'wrangler.jsonc',
		'scripts/build-managed-bundle.ts',
		'scripts/build-box-bundle.ts',
		'src/ops/reconcile.ts',
		'assets/a.txt'
	];

	async function fakeWorker(): Promise<string> {
		const dir = await worker({
			'wrangler.jsonc': '{"main":"src/site.ts"}',
			'scripts/build-managed-bundle.ts':
				'export const readShippedAssets = () => new Map([["/a.txt", new Uint8Array([1])]]);\n' +
				'export const uploadMetadata = () => new TextEncoder().encode(\'{"main_module":"site.js"}\');\n',
			'scripts/build-box-bundle.ts': BOX_SCRIPT,
			'src/ops/reconcile.ts': 'export const PACK_VERSION = 7;\n',
			'assets/a.txt': 'a'
		});
		await writeFile(join(dir, 'wrangler.managed.jsonc'), '{"main":"src/site.ts"}');
		await mkdir(join(dir, 'node_modules/.bin'), { recursive: true });
		await writeFile(join(dir, 'node_modules/.bin/wrangler'), WRANGLER, { mode: 0o755 });
		return dir;
	}

	const argsOf = (dir: string): Args => ({
		worker: dir,
		out: `${dir}-out`,
		idOnly: false,
		withhold: [],
		linkHost: 'link-staging.example.com'
	});

	it('writes the box archive and a payload.json a box takes, with the archive digest', async () => {
		const dir = await fakeWorker();
		const built = await build(argsOf(dir), undefined, gitWith({ tracked: TREE }));
		made.push(`${dir}-out`);
		const target = join(`${dir}-out`, 'releases', built.snapshot.id);
		const archive = join(target, 'box', built.box.name);
		const bytes = await readFile(archive);
		const digest = createHash('sha256').update(bytes).digest('hex');
		expect(built.box.name).toBe(`drupflare-box-bundle-${built.snapshot.id}.tar.gz`);
		expect(built.box.sha256).toBe(digest);
		expect(built.box.bytes).toBe(bytes.byteLength);
		const payload = payloadOf(JSON.parse(await readFile(join(target, 'payload.json'), 'utf8')));
		expect(payload).toEqual({
			url: `https://link-staging.example.com/link/payload/${built.snapshot.id}/${built.box.name}`,
			checksum: `sha256:${digest}`
		});
		const manifest = JSON.parse(await readFile(join(target, 'payload.json'), 'utf8'));
		expect(manifest).toMatchObject({
			kind: 'drupal-pack',
			version: built.snapshot.id,
			schemaVersion: 7,
			acceptsSchema: 7
		});
		expect((await readdir(target)).sort()).toEqual([
			'assets',
			'box',
			'manifest.json',
			'metadata.json',
			'modules',
			'payload.json',
			'snapshot.json'
		]);
		const facts = JSON.parse(await readFile(join(target, 'snapshot.json'), 'utf8'));
		expect(facts.box).toMatchObject({
			name: built.box.name,
			sha256: digest,
			schemaSource: 'worker src/ops/reconcile.ts PACK_VERSION'
		});
		const calls = (await readFile(join(dir, 'node_modules/.bin/calls.log'), 'utf8')).split(
			'\n'
		);
		expect(calls.filter((line) => line.includes('-c wrangler.managed.jsonc'))).toHaveLength(1);
		expect(calls.filter((line) => line.includes('-c wrangler.jsonc'))).toHaveLength(1);
	});

	it('refuses a box script whose sums line disagrees with the archive and writes no release', async () => {
		const dir = await fakeWorker();
		process.env.FAKE_BOX_SUMS = 'wrong';
		try {
			await expect(build(argsOf(dir), undefined, gitWith({ tracked: TREE }))).rejects.toThrow(
				'its sums line says'
			);
		} finally {
			delete process.env.FAKE_BOX_SUMS;
		}
		made.push(`${dir}-out`);
		expect(await readdir(`${dir}-out`).catch(() => [])).toEqual([]);
	});

	it('refuses a schema pair where the accepted schema is above the version', async () => {
		const dir = await fakeWorker();
		await expect(
			build(
				{ ...argsOf(dir), schemaVersion: 2, acceptsSchema: 3 },
				undefined,
				gitWith({ tracked: TREE })
			)
		).rejects.toThrow('cannot be above');
		made.push(`${dir}-out`);
	});
});
