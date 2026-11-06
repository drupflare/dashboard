import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../contracts/src/common';
import {
	assetHashOf,
	BundleError,
	bundleKeys,
	parseManifest,
	type BundleLimits
} from '../../../engine/src/bundle';
import { buildBundle, contentTypeOf, run } from '../../../scripts/build-bundle';

const LIMITS: BundleLimits = {
	maxModuleBytes: 1_000,
	maxTotalBytes: 10_000,
	maxAssetBytes: 500,
	maxAssets: 10
};

const bytes = (text: string) => new TextEncoder().encode(text);
const COMMIT = 'b'.repeat(40);

const input = () => ({
	releaseId: 'v1.0.4',
	workerCommit: COMMIT,
	mainModule: 'index.js',
	modules: new Map([
		['php.wasm', bytes('wasm')],
		['index.js', bytes('export default {}')]
	]),
	metadata: bytes('{}'),
	assets: new Map([
		['/b.txt', bytes('bee')],
		['/a.txt', bytes('ay')]
	])
});

describe('buildBundle', () => {
	it('writes every part under the key the release store reads, with a manifest that checks out', async () => {
		const { manifest, files } = await buildBundle(input(), LIMITS);
		expect(
			parseManifest(
				JSON.parse(new TextDecoder().decode(files.get(bundleKeys.manifest('v1.0.4'))))
			)
		).toEqual(manifest);
		expect(manifest.counts).toEqual({ modules: 2, assets: 2 });
		for (const module of manifest.modules) {
			const part = files.get(bundleKeys.module('v1.0.4', module.name))!;
			expect(await sha256Hex(part)).toBe(module.sha256);
			expect(part.byteLength).toBe(module.size);
		}
		for (const asset of manifest.assets) {
			const part = files.get(bundleKeys.asset('v1.0.4', asset.hash))!;
			expect(await assetHashOf(part)).toBe(asset.hash);
		}
		expect(files.get(bundleKeys.metadata('v1.0.4'))).toEqual(bytes('{}'));
		expect(manifest.workerCommit).toBe(COMMIT);
		expect(manifest.releaseId).toBe('v1.0.4');
	});

	it('gives the same manifest whatever order the inputs arrive in', async () => {
		const a = await buildBundle(input(), LIMITS);
		const reversed = input();
		reversed.modules = new Map([...reversed.modules].reverse());
		reversed.assets = new Map([...reversed.assets].reverse());
		const b = await buildBundle(reversed, LIMITS);
		expect(b.manifest).toEqual(a.manifest);
		expect(a.manifest.modules.map((module) => module.name)).toEqual(['index.js', 'php.wasm']);
		expect(a.manifest.assets.map((asset) => asset.path)).toEqual(['/a.txt', '/b.txt']);
	});

	it('refuses a bundle over a gate before returning anything', async () => {
		await expect(buildBundle(input(), { ...LIMITS, maxAssets: 1 })).rejects.toBeInstanceOf(
			BundleError
		);
		await expect(buildBundle(input(), { ...LIMITS, maxModuleBytes: 4 })).rejects.toMatchObject({
			code: 'oversize_module'
		});
		await expect(
			buildBundle({ ...input(), mainModule: 'missing.js' }, LIMITS)
		).rejects.toMatchObject({ code: 'missing_main' });
	});

	it('maps file names to the content types the upload uses', () => {
		expect(contentTypeOf('index.js')).toBe('application/javascript+module');
		expect(contentTypeOf('chunk.mjs')).toBe('application/javascript+module');
		expect(contentTypeOf('legacy.cjs')).toBe('application/javascript');
		expect(contentTypeOf('php.wasm')).toBe('application/wasm');
		expect(contentTypeOf('composer.lock')).toBe('text/plain');
		expect(contentTypeOf('payload.zst')).toBe('application/octet-stream');
		expect(contentTypeOf('noextension')).toBe('application/octet-stream');
	});
});

describe('the command', () => {
	const roots: string[] = [];
	afterAll(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});

	async function workspace(list = '/a.txt\nb.txt\n\n') {
		const root = await mkdtemp(join(tmpdir(), 'build-bundle-'));
		roots.push(root);
		await mkdir(join(root, 'dry', 'chunks'), { recursive: true });
		await writeFile(join(root, 'dry', 'index.js'), 'export default {}');
		await writeFile(join(root, 'dry', 'chunks', 'php.wasm'), 'wasm');
		await writeFile(join(root, 'dry', 'index.js.map'), '{}');
		await writeFile(join(root, 'dry', 'README.md'), 'notes');
		await writeFile(join(root, 'metadata.json'), '{}');
		await mkdir(join(root, 'assets'));
		await writeFile(join(root, 'assets', 'a.txt'), 'ay');
		await writeFile(join(root, 'assets', 'b.txt'), 'bee');
		await writeFile(join(root, 'assets', 'ignored.txt'), 'never listed');
		await writeFile(join(root, 'list.txt'), list);
		const args = [
			'--outdir',
			join(root, 'dry'),
			'--metadata',
			join(root, 'metadata.json'),
			'--assets-root',
			join(root, 'assets'),
			'--assets-list',
			join(root, 'list.txt'),
			'--release',
			'v1.0.4',
			'--commit',
			COMMIT,
			'--out',
			join(root, 'out'),
			'--max-module-bytes',
			'1000',
			'--max-asset-bytes',
			'500',
			'--max-assets',
			'10',
			'--max-total-bytes',
			'10000'
		];
		return { root, args };
	}

	it('builds a bundle from a dry-run directory and lists only the assets it was given', async () => {
		const { root, args } = await workspace();
		const result = await run(args);
		expect(result.code).toBe(0);
		expect(result.out).toContain('2 modules and 2 assets');
		const manifest = parseManifest(
			JSON.parse(await readFile(join(root, 'out', bundleKeys.manifest('v1.0.4')), 'utf8'))
		);
		expect(manifest.modules.map((module) => module.name)).toEqual([
			'chunks/php.wasm',
			'index.js'
		]);
		expect(manifest.assets.map((asset) => asset.path)).toEqual(['/a.txt', '/b.txt']);
		const stored = await readdir(join(root, 'out', 'releases', 'v1.0.4', 'assets'));
		expect(stored).toHaveLength(2);
	});

	it('refuses to write over an existing bundle', async () => {
		const { args } = await workspace();
		expect((await run(args)).code).toBe(0);
		const second = await run(args);
		expect(second.code).toBe(1);
		expect(second.out).toContain('already has files');
	});

	it('writes nothing when a gate refuses the bundle', async () => {
		const { root, args } = await workspace();
		const tight = args.map((arg, index) => (args[index - 1] === '--max-assets' ? '1' : arg));
		const result = await run(tight);
		expect(result.code).toBe(1);
		expect(result.out).toContain('too_many_assets');
		await expect(readdir(join(root, 'out'))).rejects.toThrow();
	});

	it('refuses an asset path that leaves the assets root', async () => {
		const { args } = await workspace('../metadata.json\n');
		const result = await run(args);
		expect(result.code).toBe(1);
		expect(result.out).toContain('leaves the assets root');
	});

	it('names a missing flag, an unknown flag and a limit that is not a number', async () => {
		const { args } = await workspace();
		const at = args.indexOf('--release');
		const without = [...args.slice(0, at), ...args.slice(at + 2)];
		expect((await run(without)).out).toContain('--release is required');
		expect((await run([...args, '--nope'])).code).toBe(1);
		const bad = args.map((arg, index) => (args[index - 1] === '--max-assets' ? 'lots' : arg));
		expect((await run(bad)).out).toContain(
			'--max-assets is required and must be a positive whole number'
		);
	});

	it('prints its usage', async () => {
		const result = await run(['--help']);
		expect(result.code).toBe(0);
		expect(result.out).toContain('does not run wrangler');
	});
});
