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
import { buildBundle, buildPayload, contentTypeOf, run } from '../../../scripts/build-bundle';
import { payloadOf } from '../../../src/server/domain/node-site';

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
		expect(result.out).toContain('--payload-url');
	});

	describe('the payload manifest', () => {
		const HEX = 'cd'.repeat(32);
		const URL_ =
			'https://github.com/drupflare/worker/releases/download/v1.0.4/box-1.0.4.tar.gz';
		const flags = (patch: Record<string, string> = {}) =>
			Object.entries({
				'payload-url': URL_,
				'payload-sha256': HEX,
				'payload-schema-version': '3',
				'payload-accepts-schema': '2',
				...patch
			}).flatMap(([name, value]) => [`--${name}`, value]);

		it('writes none and changes nothing about the build when no payload flag is given', async () => {
			const plain = await workspace();
			const result = await run(plain.args);
			expect(result.code).toBe(0);
			expect(result.out).not.toContain('payload.json');
			await expect(
				readFile(join(plain.root, 'out', bundleKeys.payload('v1.0.4')))
			).rejects.toThrow();
			const withFlags = await workspace();
			await run([...withFlags.args, ...flags()]);
			const read = (root: string, name: string) =>
				readFile(join(root, 'out', 'releases', 'v1.0.4', name), 'utf8');
			expect(await read(withFlags.root, 'manifest.json')).toBe(
				await read(plain.root, 'manifest.json')
			);
		});

		it('writes the manifest beside the bundle, and the box path accepts it', async () => {
			const { root, args } = await workspace();
			const result = await run([...args, ...flags()]);
			expect(result.code).toBe(0);
			expect(result.out).toContain('with payload.json');
			const manifest = JSON.parse(
				await readFile(join(root, 'out', bundleKeys.payload('v1.0.4')), 'utf8')
			);
			expect(manifest).toEqual({
				kind: 'drupal-pack',
				version: 'v1.0.4',
				schemaVersion: 3,
				acceptsSchema: 2,
				assets: [{ name: 'box-1.0.4.tar.gz', url: URL_, digest: `sha256:${HEX}` }]
			});
			expect(payloadOf(manifest)).toEqual({ url: URL_, checksum: `sha256:${HEX}` });
		});

		it('refuses a negative or unsafe number in either schema field', () => {
			const input = { releaseId: 'v1.0.4', url: URL_, sha256: HEX };
			expect(() => buildPayload({ ...input, schemaVersion: 1, acceptsSchema: -1 })).toThrow(
				'--payload-accepts-schema must be a whole number'
			);
			expect(() => buildPayload({ ...input, schemaVersion: -1, acceptsSchema: 0 })).toThrow(
				'--payload-schema-version must be a whole number'
			);
			expect(() =>
				buildPayload({ ...input, schemaVersion: 2 ** 60, acceptsSchema: 0 })
			).toThrow('whole number');
		});

		it('takes the digest with or without its prefix', () => {
			const input = { releaseId: 'v1.0.4', url: URL_, schemaVersion: 0, acceptsSchema: 0 };
			expect(buildPayload({ ...input, sha256: HEX })).toEqual(
				buildPayload({ ...input, sha256: `sha256:${HEX}` })
			);
		});

		it.each([
			['a plaintext url', { 'payload-url': URL_.replace('https', 'http') }, 'https url'],
			[
				'a name that is not an archive',
				{ 'payload-url': URL_.replace('.tar.gz', '.zip') },
				'.tar.gz'
			],
			[
				'a url that names another release',
				{ 'payload-url': URL_.replace('v1.0.4', 'v1.0.5') },
				'does not name release v1.0.4'
			],
			['a digest that is not hex', { 'payload-sha256': 'xyz' }, '64 lowercase hex'],
			['an uppercase digest', { 'payload-sha256': HEX.toUpperCase() }, '64 lowercase hex'],
			[
				'a fractional schema version',
				{ 'payload-schema-version': '1.5' },
				'--payload-schema-version must be a whole number'
			],
			[
				'a fractional accepted schema',
				{ 'payload-accepts-schema': '1.5' },
				'--payload-accepts-schema must be a whole number'
			],
			[
				'a schema version that is not a number',
				{ 'payload-schema-version': 'x' },
				'--payload-schema-version must be a whole number'
			],
			[
				'a signed accepted schema',
				{ 'payload-accepts-schema': '+1' },
				'--payload-accepts-schema must be a whole number'
			],
			[
				'an empty schema version',
				{ 'payload-schema-version': '' },
				'--payload-schema-version is required'
			],
			[
				'an accepted schema above the schema version',
				{ 'payload-schema-version': '1', 'payload-accepts-schema': '2' },
				'cannot be above --payload-schema-version'
			]
		])('refuses %s and writes nothing', async (_, patch, message) => {
			const { root, args } = await workspace();
			const result = await run([...args, ...flags(patch)]);
			expect(result.code).toBe(1);
			expect(result.out).toContain(message);
			await expect(readdir(join(root, 'out'))).rejects.toThrow();
		});

		it('refuses a payload flag without the others', async () => {
			const { args } = await workspace();
			const result = await run([...args, '--payload-url', URL_]);
			expect(result.code).toBe(1);
			expect(result.out).toContain('--payload-sha256 is required');
		});

		it.each(['payload-schema-version', 'payload-accepts-schema'])(
			'refuses a payload with --%s missing and writes nothing',
			async (missing) => {
				const { root, args } = await workspace();
				const kept = flags().join(' ').split(' ');
				const at = kept.indexOf(`--${missing}`);
				kept.splice(at, 2);
				const result = await run([...args, ...kept]);
				expect(result.code).toBe(1);
				expect(result.out).toContain(`--${missing} is required`);
				await expect(readdir(join(root, 'out'))).rejects.toThrow();
			}
		);

		it('takes equal numbers and zero for both', async () => {
			const { root, args } = await workspace();
			const result = await run([
				...args,
				...flags({ 'payload-schema-version': '0', 'payload-accepts-schema': '0' })
			]);
			expect(result.code).toBe(0);
			const manifest = JSON.parse(
				await readFile(join(root, 'out', bundleKeys.payload('v1.0.4')), 'utf8')
			);
			expect([manifest.schemaVersion, manifest.acceptsSchema]).toEqual([0, 0]);
		});

		it('has no flag called --payload-schema any more', async () => {
			const { args } = await workspace();
			const result = await run([...args, ...flags(), '--payload-schema', '3']);
			expect(result.code).toBe(1);
		});
	});
});
