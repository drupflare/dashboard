import { sha256Hex } from '@contracts/common';
import { describe, expect, it } from 'vitest';
import { validateBundle } from '../../../engine/src/bundle';
import {
	buildCustomBundle,
	CUSTOM_ARCHIVE_MAX_BYTES,
	CUSTOM_BUNDLE_LIMITS,
	CUSTOM_EXPANDED_MAX_BYTES,
	CUSTOM_MAX_ENTRIES,
	CustomBundleError,
	customMigrationRefusal,
	customReleaseId,
	guardShapeOf,
	isCustomRelease,
	parseCustomSpec,
	parseJsonc,
	putCustomBundle,
	readStreamCapped,
	unpackArchive
} from '../../../engine/src/custom-bundle';
import { goodFiles, gzip, streamOf, tar, tarGz, TODAY, type Files } from './custom-fixtures';

const ORG = `org_${'o'.repeat(26)}`;

async function build(files: Files, options: Parameters<typeof tarGz>[1] = {}) {
	const archive = await tarGz(files, options);
	const sha256 = await sha256Hex(archive);
	return buildCustomBundle({
		files: await unpackArchive(archive),
		archiveSha256: sha256,
		releaseId: await customReleaseId(ORG, sha256),
		today: TODAY
	});
}

const codes = (result: Awaited<ReturnType<typeof build>>) =>
	result.findings.map((finding) => finding.code);

const blocking = (result: Awaited<ReturnType<typeof build>>) =>
	result.findings.filter((finding) => finding.severity === 'blocking').map((f) => f.code);

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CustomBundleError) return error.code;
		throw error;
	}
	return 'none';
}

describe('reading the archive', () => {
	it('unpacks files with their paths and keeps directories out', async () => {
		const files = await unpackArchive(await tarGz(goodFiles()));
		expect([...files.keys()].sort()).toEqual([
			'dist/index.js',
			'dist/public/index.html',
			'wrangler.jsonc'
		]);
	});

	it('drops one wrapping directory when the config sits inside it', async () => {
		const wrapped = Object.fromEntries(
			Object.entries(goodFiles()).map(([path, content]) => [`app/${path}`, content])
		);
		const files = await unpackArchive(await tarGz(wrapped));
		expect(files.has('wrangler.jsonc')).toBe(true);
	});

	it('refuses a path that climbs out of the archive', async () => {
		expect(
			await refusal(unpackArchive(await tarGz({ ...goodFiles(), '../evil.js': 'x' })))
		).toBe('archive_unsafe_path');
		expect(
			await refusal(unpackArchive(await tarGz({ ...goodFiles(), 'dist/../../evil.js': 'x' })))
		).toBe('archive_unsafe_path');
	});

	it('refuses an absolute path', async () => {
		expect(
			await refusal(unpackArchive(await tarGz({ ...goodFiles(), '/etc/evil': 'x' })))
		).toBe('archive_unsafe_path');
	});

	it('refuses a path with a backslash', async () => {
		expect(await refusal(unpackArchive(await tarGz({ ...goodFiles(), 'a\\b.js': 'x' })))).toBe(
			'archive_unsafe_path'
		);
	});

	it('refuses a link', async () => {
		expect(
			await refusal(unpackArchive(await tarGz(goodFiles(), { symlinks: ['dist/link.js'] })))
		).toBe('archive_link');
	});

	it('refuses an archive over the byte cap before it inflates anything', async () => {
		expect(await refusal(unpackArchive(new Uint8Array(CUSTOM_ARCHIVE_MAX_BYTES + 1)))).toBe(
			'archive_too_large'
		);
	});

	it('stops reading a stream at the first byte past the cap', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1;
				controller.enqueue(new Uint8Array(1_000));
			}
		});
		expect(await refusal(readStreamCapped(stream, 2_500))).toBe('archive_too_large');
		expect(pulled).toBeLessThan(10);
	});

	it('reads a stream that fits and gives its bytes back whole', async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		expect([...(await readStreamCapped(streamOf(bytes), 10))]).toEqual([1, 2, 3, 4]);
	});

	it('stops an archive bomb at the expanded cap', async () => {
		const huge = new Uint8Array(CUSTOM_EXPANDED_MAX_BYTES + 1);
		const archive = await tarGz({ 'wrangler.jsonc': '{}', 'blob.bin': huge });
		expect(archive.byteLength).toBeLessThan(CUSTOM_ARCHIVE_MAX_BYTES);
		expect(await refusal(unpackArchive(archive))).toBe('archive_expanded_too_large');
	});

	it('refuses more entries than the cap', async () => {
		const many: Files = {};
		for (let i = 0; i <= CUSTOM_MAX_ENTRIES; i++) many[`f${i}`] = '';
		expect(await refusal(unpackArchive(await tarGz(many)))).toBe('archive_too_many_entries');
	});

	it('refuses bytes that are not a gzip file and a tar that is cut short', async () => {
		expect(await refusal(unpackArchive(new Uint8Array([1, 2, 3, 4])))).toBe(
			'archive_unreadable'
		);
		const cut = tar(goodFiles()).subarray(0, 700);
		expect(await refusal(unpackArchive(await gzip(cut)))).toBe('archive_unreadable');
	});
});

describe('reading the config', () => {
	it('drops comments and trailing commas outside strings and keeps them inside', () => {
		const value = parseJsonc(`﻿// top
		{
			/* block */ "a": "x // not a comment, /* nor this */",
			"b": [1, 2,],
			"c": { "d": "e", },
		}`);
		expect(value).toEqual({
			a: 'x // not a comment, /* nor this */',
			b: [1, 2],
			c: { d: 'e' }
		});
	});

	it('keeps an escaped quote inside a string', () => {
		expect(parseJsonc('{"a": "say \\"hi\\" // still text"}')).toEqual({
			a: 'say "hi" // still text'
		});
	});

	it('refuses an archive with no config and one with a config that is not an object', async () => {
		const no = await unpackArchive(await tarGz({ 'dist/index.js': 'x' }));
		await expect(
			buildCustomBundle({
				files: no,
				archiveSha256: 'a'.repeat(64),
				releaseId: 'r',
				today: TODAY
			})
		).rejects.toMatchObject({ code: 'no_config' });
		for (const text of ['[]', 'nope', '"x"']) {
			const files = await unpackArchive(await tarGz({ 'wrangler.jsonc': text }));
			await expect(
				buildCustomBundle({
					files,
					archiveSha256: 'a'.repeat(64),
					releaseId: 'r',
					today: TODAY
				})
			).rejects.toMatchObject({ code: 'config_invalid' });
		}
	});
});

describe('a bundle that deploys', () => {
	it('is deployable and carries its modules, assets and spec', async () => {
		const result = await build(goodFiles());
		expect(result.deployable).toBe(true);
		expect(blocking(result)).toEqual([]);
		const bundle = result.bundle!;
		expect(bundle.manifest.mainModule).toBe('index.js');
		expect(bundle.manifest.modules.map((module) => module.name)).toEqual(['index.js']);
		expect(bundle.manifest.assets.map((asset) => asset.path)).toEqual(['/index.html']);
		expect(bundle.spec).toMatchObject({
			compatibilityDate: '2026-08-01',
			compatibilityFlags: ['nodejs_compat'],
			resources: [
				{ kind: 'kv', binding: 'CACHE' },
				{ kind: 'r2', binding: 'UPLOADS' }
			],
			vars: { GREETING: 'hello' }
		});
		expect(parseCustomSpec(bundle.metadata)).toEqual(bundle.spec);
		expect(() => validateBundle(bundle.manifest, CUSTOM_BUNDLE_LIMITS)).not.toThrow();
	});

	it('keeps the asset directory out of the modules and the config out of both', async () => {
		const result = await build(
			goodFiles({}, { 'dist/chunk.js': 'export const x = 1;', 'dist/public/app.js': 'y' })
		);
		expect(result.bundle!.manifest.modules.map((module) => module.name)).toEqual([
			'chunk.js',
			'index.js'
		]);
		expect(result.bundle!.manifest.assets.map((asset) => asset.path)).toEqual([
			'/app.js',
			'/index.html'
		]);
	});

	it('names a module by its path under the entry directory and types it by extension', async () => {
		const result = await build(
			goodFiles(
				{},
				{
					'dist/lib/a.mjs': 'export {}',
					'dist/lib/b.wasm': 'wasm',
					'dist/lib/c.txt': 'text',
					'dist/lib/d.map': 'ignored'
				}
			)
		);
		const byName = Object.fromEntries(
			result.bundle!.manifest.modules.map((module) => [module.name, module.contentType])
		);
		expect(byName).toEqual({
			'index.js': 'application/javascript+module',
			'lib/a.mjs': 'application/javascript+module',
			'lib/b.wasm': 'application/wasm',
			'lib/c.txt': 'text/plain'
		});
	});

	it('takes the config from wrangler.json too', async () => {
		const { 'wrangler.jsonc': config, ...rest } = goodFiles();
		const result = await build({ 'wrangler.json': config!, ...rest } as Files);
		expect(result.deployable).toBe(true);
		expect(result.fileName).toBe('wrangler.json');
	});

	it('writes the parts the engine reads and the manifest last', async () => {
		const result = await build(goodFiles());
		const keys: string[] = [];
		await putCustomBundle(
			{ put: async (key) => void keys.push(key) },
			'cust-x',
			result.bundle!
		);
		expect(keys.at(-1)).toBe('releases/cust-x/manifest.json');
		expect(keys).toContain('releases/cust-x/metadata.json');
		expect(keys).toContain('releases/cust-x/modules/index.js');
		expect(keys.filter((key) => key.includes('/assets/'))).toHaveLength(1);
	});

	it('gives one release id per organization and archive', async () => {
		const sha = 'a'.repeat(64);
		const first = await customReleaseId(ORG, sha);
		expect(first).toBe(await customReleaseId(ORG, sha));
		expect(first).not.toBe(await customReleaseId(`org_${'p'.repeat(26)}`, sha));
		expect(isCustomRelease(first)).toBe(true);
		expect(first.length).toBeLessThanOrEqual(64);
		expect(isCustomRelease('v1.0.4')).toBe(false);
	});
});

describe('what the platform refuses', () => {
	it.each(['ai', 'containers', 'browser', 'hyperdrive', 'vectorize', 'tail_consumers'])(
		'refuses %s',
		async (key) => {
			const result = await build(
				goodFiles({ [key]: key === 'ai' ? { binding: 'AI' } : [{}] })
			);
			expect(result.deployable).toBe(false);
			expect(result.bundle).toBeNull();
			expect(result.findings).toContainEqual(
				expect.objectContaining({
					severity: 'blocking',
					code: 'binding-unverified',
					subject: key
				})
			);
			expect(result.recipe.refused.map((item) => item.kind)).toContain(key);
		}
	);

	it('refuses a service binding, since its target is another account', async () => {
		const result = await build(
			goodFiles({ services: [{ binding: 'OTHER', service: 'someone-elses-worker' }] })
		);
		expect(blocking(result)).toContain('service-target-unknown');
	});

	it('refuses a Durable Object that belongs to another script', async () => {
		const result = await build(
			goodFiles({
				durable_objects: {
					bindings: [{ name: 'ROOM', class_name: 'Room', script_name: 'other-worker' }]
				},
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		);
		expect(blocking(result)).toContain('durable-object-foreign');
	});

	it('refuses an environment on a Durable Object binding', async () => {
		const result = await build(
			goodFiles({
				durable_objects: {
					bindings: [{ name: 'ROOM', class_name: 'Room', environment: 'prod' }]
				},
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		);
		expect(blocking(result)).toContain('durable-object-foreign');
	});

	it('accepts a Durable Object of its own script that a migration creates', async () => {
		const result = await build(
			goodFiles({
				durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		);
		expect(result.deployable).toBe(true);
		expect(result.bundle!.spec.durableObjects).toEqual([{ name: 'ROOM', class_name: 'Room' }]);
	});

	it('refuses a Durable Object that no migration creates', async () => {
		const result = await build(
			goodFiles({ durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] } })
		);
		expect(blocking(result)).toContain('durable-object-no-migration');
	});

	it('refuses a migration step the platform has not verified', async () => {
		const result = await build(
			goodFiles({ migrations: [{ tag: 'v2', renamed_classes: [{ from: 'A', to: 'B' }] }] })
		);
		expect(blocking(result)).toContain('binding-unverified');
	});

	it('refuses a config with no main, one whose main is not in the archive, and one that is source', async () => {
		expect(blocking(await build(goodFiles({ main: undefined })))).toContain('main-missing');
		expect(blocking(await build(goodFiles({ main: 'dist/gone.js' })))).toContain(
			'main-not-found'
		);
		const source = await build(goodFiles({ main: 'src/index.ts' }, { 'src/index.ts': 'x' }));
		expect(blocking(source)).toContain('main-not-built');
	});

	it('refuses a compatibility date that is missing, malformed or later than today', async () => {
		expect(blocking(await build(goodFiles({ compatibility_date: undefined })))).toContain(
			'compat-date-missing'
		);
		expect(blocking(await build(goodFiles({ compatibility_date: 'August' })))).toContain(
			'compat-date-invalid'
		);
		expect(blocking(await build(goodFiles({ compatibility_date: '2026-11-15' })))).toContain(
			'compat-date-future'
		);
		expect(blocking(await build(goodFiles({ compatibility_date: TODAY })))).toEqual([]);
	});

	it('ignores limits and placement and says so', async () => {
		const result = await build(
			goodFiles({ limits: { cpu_ms: 300000 }, placement: { mode: 'smart' } })
		);
		expect(result.deployable).toBe(true);
		expect(result.findings).toContainEqual(
			expect.objectContaining({ severity: 'info', code: 'limits-ignored' })
		);
		expect(result.findings).toContainEqual(
			expect.objectContaining({ severity: 'info', code: 'placement-ignored' })
		);
		expect(JSON.stringify(result.bundle!.spec)).not.toContain('300000');
	});

	it('refuses a key the platform has not verified', async () => {
		expect(blocking(await build(goodFiles({ analytics_engine_datasets: [{}] })))).toContain(
			'binding-unverified'
		);
	});

	it('refuses a binding name that cannot be used and two that collide', async () => {
		expect(
			blocking(await build(goodFiles({ kv_namespaces: [{ binding: 'my-kv', id: 'x' }] })))
		).toContain('binding-name-invalid');
		expect(
			blocking(await build(goodFiles({ kv_namespaces: [{ binding: 'KV_', id: 'x' }] })))
		).toContain('binding-name-invalid');
		expect(
			blocking(
				await build(goodFiles({ kv_namespaces: [{ binding: 'A'.repeat(21), id: 'x' }] }))
			)
		).toContain('binding-name-too-long');
		expect(
			blocking(
				await build(
					goodFiles({
						kv_namespaces: [
							{ binding: 'CACHE', id: 'x' },
							{ binding: 'cache', id: 'y' }
						]
					})
				)
			)
		).toContain('binding-name-duplicate');
		expect(blocking(await build(goodFiles({ vars: { CACHE: 'x' } })))).toContain(
			'binding-name-duplicate'
		);
	});

	it('refuses a var that is not text, a number or a boolean', async () => {
		expect(blocking(await build(goodFiles({ vars: { OBJ: { a: 1 } } })))).toContain(
			'var-unsupported'
		);
		const ok = await build(goodFiles({ vars: { N: 3, B: true, S: 'x' } }));
		expect(ok.bundle!.spec.vars).toEqual({ N: '3', B: 'true', S: 'x' });
	});

	it('refuses a bundle over the engine ceilings with the ceiling named', async () => {
		const result = await build(
			goodFiles(
				{},
				{ 'dist/big.js': new Uint8Array(CUSTOM_BUNDLE_LIMITS.maxModuleBytes + 1) }
			)
		);
		expect(blocking(result)).toContain('oversize_module');
		expect(result.bundle).toBeNull();
	});

	it('warns about schedules and D1 migrations the platform does not apply', async () => {
		const result = await build(
			goodFiles({
				triggers: { crons: ['*/5 * * * *'] },
				d1_databases: [{ binding: 'DB', database_id: 'x', migrations_dir: 'migrations' }]
			})
		);
		expect(result.deployable).toBe(true);
		expect(codes(result)).toEqual(
			expect.arrayContaining(['cron-not-applied', 'd1-migrations-not-applied'])
		);
	});

	it('records an empty assets directory', async () => {
		const result = await build(goodFiles({ assets: { directory: 'dist/none' } }));
		expect(codes(result)).toContain('assets-empty');
	});
});

describe('the migration guard', () => {
	const shape = (classes: string[], steps: [string, string[]][]) => ({
		durableObjects: classes.map((name) => ({ name: name.toUpperCase(), class_name: name })),
		migrations: steps.map(([tag, news]) => ({ tag, new_sqlite_classes: news }))
	});

	it('allows adding a tag and a class', () => {
		expect(
			customMigrationRefusal(
				shape(['A'], [['v1', ['A']]]),
				shape(
					['A', 'B'],
					[
						['v1', ['A']],
						['v2', ['B']]
					]
				)
			)
		).toBeNull();
	});

	it('refuses removing a class', () => {
		expect(
			customMigrationRefusal(
				shape(['A', 'B'], [['v1', ['A', 'B']]]),
				shape(['A'], [['v1', ['A', 'B']]])
			)
		).toContain('removes the B class');
	});

	it('refuses renaming a class', () => {
		expect(
			customMigrationRefusal(shape(['A'], [['v1', ['A']]]), shape(['Z'], [['v1', ['A']]]))
		).toContain('removes the A class');
	});

	it('refuses dropping, changing or reordering a tag', () => {
		const live = shape(
			['A'],
			[
				['v1', ['A']],
				['v2', []]
			]
		);
		expect(customMigrationRefusal(live, shape(['A'], [['v1', ['A']]]))).toContain('drops');
		expect(
			customMigrationRefusal(
				live,
				shape(
					['A'],
					[
						['v1', ['A']],
						['v3', []]
					]
				)
			)
		).toContain('changes');
		expect(
			customMigrationRefusal(
				live,
				shape(
					['A'],
					[
						['v1', []],
						['v2', []]
					]
				)
			)
		).toContain('changes');
	});

	it('reads the same shape from a recipe as from a spec', async () => {
		const result = await build(
			goodFiles({
				durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
				migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
			})
		);
		expect(guardShapeOf(result.recipe)).toEqual({
			durableObjects: result.bundle!.spec.durableObjects,
			migrations: result.bundle!.spec.migrations
		});
	});
});
