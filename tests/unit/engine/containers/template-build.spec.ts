import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	advisoriesOf,
	countRows,
	encodeBundle,
	EXIT_BAD_SPEC,
	EXIT_STEP_FAILED,
	parseSpec,
	patchFailuresOf,
	resolveSteps,
	templateBuild,
	type RunCommand,
	type TemplateSpec
} from '../../../../engine/src/containers/image/template-build.mjs';
import { parseBundle, TemplateBundleError } from '../../../../engine/src/template-bundle';
import {
	TEMPLATE_ENTRY_IDS,
	templateSpec,
	type TemplateEntryId
} from '../../../../src/shared/template-entries';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'template-build-spec-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const specOf = (id: TemplateEntryId) => JSON.stringify(templateSpec(id));

describe('parseSpec', () => {
	it.each(TEMPLATE_ENTRY_IDS)('accepts the %s entry as the dashboard builds it', (id) => {
		expect(parseSpec(specOf(id))).toMatchObject({ id, sha: templateSpec(id).sha });
	});

	it.each([
		['not JSON', '{nope'],
		['an array', '[]'],
		['an unknown field', JSON.stringify({ ...templateSpec('thunder'), shell: 'rm' })],
		[
			'a repo off github',
			JSON.stringify({ ...templateSpec('thunder'), repo: 'https://evil.test/a/b' })
		],
		['a short sha', JSON.stringify({ ...templateSpec('thunder'), sha: 'abc123' })],
		[
			'an option as the package',
			JSON.stringify({ ...templateSpec('thunder'), package: '--repository=x' })
		],
		[
			'an option as the template',
			JSON.stringify({ ...templateSpec('thunder'), template: '--stability=x/y' })
		],
		[
			'an option as an extra package',
			JSON.stringify({ ...templateSpec('thunder'), extra: ['--dev'] })
		],
		['a bad profile', JSON.stringify({ ...templateSpec('thunder'), profile: 'a b' })],
		['a bad mode', JSON.stringify({ ...templateSpec('thunder'), mode: 'both' })],
		['a bad id', JSON.stringify({ ...templateSpec('thunder'), id: '../x' })],
		[
			'a flag that is not a boolean',
			JSON.stringify({ ...templateSpec('thunder'), auditOff: 'yes' })
		]
	])('refuses %s', (_name, text) => {
		expect(() => parseSpec(text)).toThrow();
	});

	it('defaults the optional fields', () => {
		const {
			extra: _extra,
			auditOff: _a,
			patchTolerant: _p,
			enablePatching: _e,
			...rest
		} = templateSpec('thunder');
		expect(parseSpec(JSON.stringify(rest))).toMatchObject({
			extra: [],
			auditOff: false,
			patchTolerant: false,
			enablePatching: false
		});
	});
});

describe('what composer says', () => {
	const report = JSON.stringify(
		{
			advisories: {
				'drupal/core': [
					{
						advisoryId: 'PKSA-1',
						title: 'Drupal core - SA-CORE-2026-014',
						link: 'https://drupal.org/sa-core-2026-014'
					},
					{ advisoryId: 'SA-CORE-2026-015', title: 'x', link: 'x' }
				],
				'drupal/webform': [
					{ advisoryId: 'PKSA-2', title: 'plain title', link: 'https://x' }
				]
			}
		},
		null,
		2
	);

	it('names every advisory once with its package and prefers the Drupal id', () => {
		const text = `Found 3 security vulnerability advisories\n${report}\n`;
		expect(advisoriesOf(text)).toEqual([
			{ id: 'SA-CORE-2026-014', package: 'drupal/core' },
			{ id: 'SA-CORE-2026-015', package: 'drupal/core' },
			{ id: 'PKSA-2', package: 'drupal/webform' }
		]);
	});

	it('reads an empty audit as none and an unreadable one as unknown', () => {
		expect(advisoriesOf('{\n"advisories": []\n}')).toEqual([]);
		expect(advisoriesOf('no json here')).toBeNull();
		expect(advisoriesOf('{\n"advisories": {\n')).toBeNull();
	});

	it('names the package and the patch that did not apply', () => {
		const lines = [
			'  - Applying patches for drupal/gin',
			'    https://drupal.org/a.diff (fine)',
			'  - Applying patches for drupal/pathauto',
			'Cannot apply patch Fix (https://www.drupal.org/files/issues/3579655.diff)!',
			'Cannot apply patch without a link'
		];
		expect(patchFailuresOf(lines)).toEqual([
			{
				package: 'drupal/pathauto',
				patch: 'https://www.drupal.org/files/issues/3579655.diff'
			},
			{ package: 'drupal/pathauto', patch: 'Cannot apply patch without a link' }
		]);
		expect(patchFailuresOf(['all applied'])).toEqual([]);
	});

	it('counts the rows a dump inserts', () => {
		expect(
			countRows('BEGIN;\nINSERT INTO "a" VALUES(1);\nINSERT INTO b VALUES(2);\nCOMMIT;')
		).toBe(2);
		expect(countRows('')).toBe(0);
	});
});

describe('resolveSteps', () => {
	const paths = { dir: '/w', clone: '/w/clone', site: '/w/site' };
	const configs = (spec: TemplateSpec) =>
		resolveSteps(spec, paths)
			.filter((step) => step.args[0] === 'config')
			.map((step) => step.args.slice(1).join(' '));

	it('fetches the pinned commit before anything else and from the work directory', () => {
		const steps = resolveSteps(parseSpec(specOf('thunder')), paths);
		expect(steps.slice(0, 3).map((step) => step.args.join(' '))).toEqual([
			'init -q /w/clone',
			`-C /w/clone fetch -q --depth 1 https://github.com/thunder/thunder-distribution ${templateSpec('thunder').sha}`,
			'-C /w/clone checkout -q FETCH_HEAD'
		]);
		expect(steps.slice(0, 3).every((step) => step.cwd === '/w')).toBe(true);
	});

	it('tolerates a failed patch for Thunder and does not switch the audit off', () => {
		const lines = configs(parseSpec(specOf('thunder')));
		expect(lines).toContain('extra.composer-exit-on-patch-failure false --json');
		expect(lines.some((line) => line.startsWith('audit.block-insecure'))).toBe(false);
	});

	it('switches the audit block off for farmOS and leaves patch failures fatal', () => {
		const lines = configs(parseSpec(specOf('farmos')));
		expect(lines).toContain('audit.block-insecure false');
		expect(lines.some((line) => line.includes('exit-on-patch-failure'))).toBe(false);
	});

	it('enables patching and adds the asset repository for GovCMS', () => {
		const lines = configs(parseSpec(specOf('govcms')));
		expect(lines).toContain('extra.enable-patching true --json');
		expect(lines).toContain('repositories.assets composer https://asset-packagist.org');
		expect(lines).toContain('minimum-stability dev');
	});

	it('keeps the pinned clone as the first repository when the profile mode edits the root', async () => {
		const site = join(dir, 'site');
		const clone = join(dir, 'clone');
		await mkdir(site);
		await mkdir(clone);
		await writeFile(
			join(site, 'composer.json'),
			JSON.stringify({
				repositories: { assets: { type: 'composer', url: 'https://a.test' } }
			})
		);
		await writeFile(
			join(clone, 'composer.json'),
			JSON.stringify({
				repositories: [
					{ type: 'path', url: '../x' },
					{ type: 'composer', url: 'https://own.test' }
				]
			})
		);
		const { useProfileRepositories } =
			await import('../../../../engine/src/containers/image/template-build.mjs');
		await useProfileRepositories(clone, site);
		const written = JSON.parse(await readFile(join(site, 'composer.json'), 'utf8'));
		expect(written.repositories.map((entry: { url: string }) => entry.url)).toEqual([
			clone,
			'https://own.test',
			'https://a.test'
		]);
	});
});

describe('templateBuild', () => {
	const SQL = 'BEGIN;\nINSERT INTO "users" VALUES(1);\nINSERT INTO "node" VALUES(1);\nCOMMIT;\n';
	const AUDIT = JSON.stringify({
		advisories: { 'drupal/core': [{ advisoryId: 'x', title: 'SA-CORE-2026-016', link: '' }] }
	});

	interface Fake {
		run: RunCommand;
		calls: string[];
	}

	// stands in for git, composer, drush, sqlite3 and tar by writing the files they would leave
	function fake(
		options: {
			failAt?: string;
			code?: number;
			sql?: string;
			database?: boolean;
			failedPatch?: boolean;
		} = {}
	): Fake {
		const calls: string[] = [];
		const run: RunCommand = async (file, args, { cwd, log }) => {
			const name = file.endsWith('/drush') ? 'drush' : file;
			const label =
				name === 'sqlite3'
					? 'sqlite3 .output'
					: [name, args[0] === '-C' ? args[2] : args[0]].join(' ');
			calls.push(label);
			if (options.failAt === label) return options.code ?? 2;
			const site = join(dir, 'site');
			if (label === 'git init') await mkdir(join(dir, 'clone'), { recursive: true });
			if (label === 'composer create-project') {
				await mkdir(join(site, 'web'), { recursive: true });
				await writeFile(join(site, 'composer.json'), '{}');
				await writeFile(join(dir, 'clone', 'composer.json'), '{}');
			}
			if (label === 'composer require')
				await writeFile(join(site, 'composer.lock'), '{"packages":[{},{},{}]}');
			if (label === 'composer install') {
				log('  - Applying patches for drupal/pathauto');
				if (options.failedPatch)
					log('Cannot apply patch Fix (https://drupal.test/x.diff)!');
			}
			if (label === 'drush site:install' && options.database !== false) {
				const files = join(site, 'web', 'sites', 'default', 'files');
				await mkdir(files, { recursive: true });
				await writeFile(join(files, '.ht.sqlite'), 'db');
			}
			if (name === 'sqlite3') {
				await writeFile((args[1] ?? '').replace('.output ', ''), options.sql ?? SQL);
			}
			if (file === 'tar') await writeFile(args[1] ?? '', 'tar-bytes');
			if (label === 'composer audit') for (const line of AUDIT.split('\n')) log(line);
			if (file === 'php') log('8.4.27');
			return 0;
		};
		return { run, calls };
	}

	async function build(spec: string, fakeRun: Fake) {
		const input = join(dir, 'input');
		const output = join(dir, 'output');
		await writeFile(input, spec);
		const logs: string[] = [];
		const code = await templateBuild(
			{
				dir,
				input,
				output,
				log: (line) => logs.push(line),
				signal: new AbortController().signal
			},
			{ run: fakeRun.run, env: () => ({ PATH: '/usr/bin' }) }
		);
		return { code, logs, output };
	}

	it('runs the steps in order and writes a bundle with its manifest', async () => {
		const run = fake({ failedPatch: true });
		const { code, output } = await build(specOf('thunder'), run);
		expect(code).toBe(0);
		expect(run.calls).toEqual([
			'git init',
			'git fetch',
			'git checkout',
			'composer create-project',
			'composer config',
			'composer config',
			'composer config',
			'composer require',
			'composer install',
			'drush site:install',
			'drush cache:rebuild',
			'sqlite3 .output',
			'tar -cf',
			'composer audit',
			'php -r'
		]);
		const bundle = await parseBundle(new Uint8Array(await readFile(output)));
		expect(bundle.manifest).toMatchObject({
			version: 1,
			entryId: 'thunder',
			commit: templateSpec('thunder').sha,
			phpVersion: '8.4.27',
			rows: 2,
			packages: 3,
			advisories: [{ id: 'SA-CORE-2026-016', package: 'drupal/core' }],
			patchesFailed: [{ package: 'drupal/pathauto', patch: 'https://drupal.test/x.diff' }]
		});
		expect(bundle.manifest.sections.map((section) => section.name)).toEqual([
			'database.sql',
			'composer.lock',
			'composer.json',
			'files.tar'
		]);
		expect(new TextDecoder().decode(bundle.section('database.sql'))).toBe(SQL);
	});

	it('records no failed patch when every patch applied', async () => {
		const { output } = await build(specOf('farmos'), fake());
		const bundle = await parseBundle(new Uint8Array(await readFile(output)));
		expect(bundle.manifest.patchesFailed).toEqual([]);
	});

	it('refuses a bad spec before it runs anything', async () => {
		const run = fake();
		const { code, logs } = await build('{"id":"x"}', run);
		expect(code).toBe(EXIT_BAD_SPEC);
		expect(run.calls).toEqual([]);
		expect(logs.join('\n')).toContain('is not valid');
	});

	it.each([
		['git fetch', 'the clone'],
		['composer require', 'the resolve'],
		['composer install', 'the install'],
		['drush site:install', 'the site install']
	])('returns the exit code of %s and writes no bundle', async (failAt) => {
		const { code, output } = await build(specOf('govcms'), fake({ failAt, code: 7 }));
		expect(code).toBe(7);
		await expect(readFile(output)).rejects.toThrow();
	});

	it('fails when the install leaves no database', async () => {
		const { code, logs } = await build(specOf('thunder'), fake({ database: false }));
		expect(code).toBe(EXIT_STEP_FAILED);
		expect(logs).toContain('the site install wrote no database');
	});

	it('fails when the dump holds no rows', async () => {
		const { code, logs } = await build(specOf('thunder'), fake({ sql: 'BEGIN;\nCOMMIT;\n' }));
		expect(code).toBe(EXIT_STEP_FAILED);
		expect(logs).toContain('the database dump holds no rows');
	});
});

describe('the bundle format', () => {
	const manifest = {
		version: 1,
		entryId: 'thunder',
		commit: 'a'.repeat(40),
		phpVersion: '8.4.27',
		buildSeconds: 1,
		rows: 1,
		advisories: null,
		patchesFailed: [],
		packages: 1
	};
	const sections = [
		{ name: 'database.sql', bytes: new TextEncoder().encode('INSERT INTO a VALUES(1);') },
		{ name: 'composer.lock', bytes: new TextEncoder().encode('{}') }
	];
	const encoded = () => new Uint8Array(encodeBundle(manifest, sections));

	it('round-trips through the engine reader', async () => {
		const bundle = await parseBundle(encoded());
		expect(bundle.manifest.advisories).toBeNull();
		expect(new TextDecoder().decode(bundle.section('composer.lock'))).toBe('{}');
	});

	it.each([
		['a missing section', (bundle: Uint8Array) => bundle, 'bundle_section_missing'],
		[
			'a cut bundle',
			(bundle: Uint8Array) => bundle.slice(0, bundle.length - 3),
			'bundle_malformed'
		],
		[
			'bytes after the end',
			(bundle: Uint8Array) => new Uint8Array([...bundle, 1]),
			'bundle_malformed'
		],
		[
			'a changed byte',
			(bundle: Uint8Array) =>
				bundle.map((byte, at) => (at === bundle.length - 1 ? byte ^ 1 : byte)),
			'bundle_mismatch'
		],
		[
			'a wrong header',
			(bundle: Uint8Array) => bundle.map((byte, at) => (at === 0 ? 0 : byte)),
			'bundle_malformed'
		],
		['a cut manifest', (bundle: Uint8Array) => bundle.slice(0, 14), 'bundle_malformed']
	])('refuses %s', async (_name, change, code) => {
		const changed = change(encoded());
		const read = async () => {
			const bundle = await parseBundle(changed);
			return bundle.section('files.tar');
		};
		await expect(read()).rejects.toMatchObject({ code });
		await expect(read()).rejects.toBeInstanceOf(TemplateBundleError);
	});
});
