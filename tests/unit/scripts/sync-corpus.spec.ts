import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncCorpus, syncSources } from '../../../scripts/sync-corpus';
import {
	CorpusInvalidError,
	checksSentence,
	coreLabel,
	corpusEntries,
	corpusSourcesSchema,
	installDecision,
	parseCorpusManifest,
	reasonOf,
	searchCorpus,
	shapeLabel,
	type CorpusEntry,
	type CorpusSources
} from '../../../src/shared/corpus';

const ROWS = [
	'install',
	'container build',
	'anon render',
	'auth render',
	'entity crud',
	'form submit',
	'file rw',
	'queue cron',
	'outbound http',
	'update',
	'cache rebuild',
	'config import',
	'module workflow'
];
const SHA = 'a'.repeat(40);

type Cell = { state: string; note?: string };

const rows = (state: string, extra: Record<string, Cell> = {}) => ({
	...Object.fromEntries(ROWS.map((row) => [row, { state }])),
	...extra
});

const repo = (cells: Record<string, Cell>, deployed?: Record<string, Cell>) => ({
	sha: SHA,
	lane: 'fixture',
	run: 'local:2026-09-29T00:00:00.000Z',
	date: '2026-09-29',
	rows: cells,
	...(deployed
		? { deployed: { sha: SHA, run: 'deployed:fixture', date: '2026-09-30', rows: deployed } }
		: {})
});

const fixture = () =>
	JSON.stringify(
		{
			rows: ROWS,
			repos: {
				good: repo(rows('inline')),
				shipped: repo(rows('inline'), rows('inline')),
				half: repo(
					rows('inline', { 'file rw': { state: 'unsupported', note: 'refused' } })
				),
				upgrade: repo(
					rows('unsupported', {
						install: {
							state: 'unsupported',
							note: 'needs upgrade: core 10 does not accept Drupal 11'
						}
					})
				),
				refused: repo(
					rows('unsupported', {
						install: { state: 'unsupported', note: 'refused: no composer.json' }
					})
				)
			}
		},
		null,
		'\t'
	);

const statusOf = (entries: CorpusEntry[], name: string) => entries.find((e) => e.name === name);

describe('syncCorpus', () => {
	let dir: string;
	let workerDir: string;
	let target: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sync-corpus-'));
		workerDir = join(dir, 'worker');
		await mkdir(join(workerDir, 'docs'), { recursive: true });
		target = join(dir, 'corpus.json');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('copies a valid manifest to the target and returns its codebases', async () => {
		const raw = fixture();
		await writeFile(join(workerDir, 'docs', 'compatibility.json'), raw);

		const manifest = await syncCorpus(workerDir, target);

		expect(Object.keys(manifest.repos)).toHaveLength(5);
		expect(await readFile(target, 'utf8')).toBe(raw);
	});

	it('refuses an invalid manifest and leaves the target untouched', async () => {
		const bad = JSON.parse(fixture());
		bad.repos.good.sha = 'not-a-sha';
		await writeFile(join(workerDir, 'docs', 'compatibility.json'), JSON.stringify(bad));
		await writeFile(target, 'sentinel');

		await expect(syncCorpus(workerDir, target)).rejects.toThrow(CorpusInvalidError);
		expect(await readFile(target, 'utf8')).toBe('sentinel');
	});

	it('refuses a manifest that is not JSON', async () => {
		await writeFile(join(workerDir, 'docs', 'compatibility.json'), '{ nope');
		await writeFile(target, 'sentinel');

		await expect(syncCorpus(workerDir, target)).rejects.toThrow(CorpusInvalidError);
		expect(await readFile(target, 'utf8')).toBe('sentinel');
	});
});

describe('parseCorpusManifest', () => {
	it('refuses a codebase whose cells do not match the manifest rows', () => {
		const bad = JSON.parse(fixture());
		delete bad.repos.good.rows['module workflow'];
		expect(() => parseCorpusManifest(JSON.stringify(bad))).toThrow(CorpusInvalidError);
	});

	it('refuses an unknown capability state', () => {
		const bad = JSON.parse(fixture());
		bad.repos.good.rows.install.state = 'bogus';
		expect(() => parseCorpusManifest(JSON.stringify(bad))).toThrow(CorpusInvalidError);
	});
});

describe('installDecision', () => {
	const entries = corpusEntries(parseCorpusManifest(fixture()));

	it('allows verified and deployed codebases', () => {
		expect(installDecision(statusOf(entries, 'good')!)).toEqual({ allowed: true });
		expect(installDecision(statusOf(entries, 'shipped')!)).toEqual({ allowed: true });
	});

	it('refuses partial codebases', () => {
		const decision = installDecision(statusOf(entries, 'half')!);
		expect(decision.allowed).toBe(false);
	});

	it('refuses needs-upgrade codebases with the corpus reason', () => {
		expect(installDecision(statusOf(entries, 'upgrade')!)).toEqual({
			allowed: false,
			reason: 'needs upgrade: core 10 does not accept Drupal 11'
		});
	});

	it('refuses unsupported codebases with the corpus reason', () => {
		expect(installDecision(statusOf(entries, 'refused')!)).toEqual({
			allowed: false,
			reason: 'refused: no composer.json'
		});
	});
});

describe('searchCorpus', () => {
	const manifest = parseCorpusManifest(fixture());

	it('returns every codebase with its install decision when no filter is given', () => {
		const results = searchCorpus(manifest);
		expect(results.map((item) => item.id).sort()).toEqual(
			['good', 'half', 'refused', 'shipped', 'upgrade'].sort()
		);
		expect(results.find((item) => item.id === 'good')).toMatchObject({
			name: 'good',
			install: { allowed: true }
		});
	});

	it('gives the corpus reason for a refused codebase as one plain sentence', () => {
		const refused = searchCorpus(manifest, { q: 'refused' });
		expect(refused).toHaveLength(1);
		expect(refused[0]?.install).toEqual({ allowed: false, reason: 'No composer.json.' });
	});

	it('names a codebase by its title and finds it by title, summary or repository', () => {
		const sources: CorpusSources = {
			good: {
				repo: 'https://github.com/acme/tidy-site',
				shape: 'module',
				core: '^11.3',
				legacy: null
			}
		};
		const [hit] = searchCorpus(manifest, { q: 'tidy-site' }, sources);
		expect(hit).toMatchObject({
			id: 'good',
			title: 'Good',
			repo: 'https://github.com/acme/tidy-site',
			core: '^11.3',
			shape: 'module'
		});
		expect(searchCorpus(manifest, { q: 'tidy-site' })).toEqual([]);
	});

	it('counts the checks that pass and groups the failures by reason', () => {
		const half = searchCorpus(manifest, { q: 'half' })[0]!;
		expect(half.checks).toEqual({ passed: 12, total: 13, unchecked: 0 });
		expect(half.blockers).toEqual([
			{ checks: ['File Read and Write'], reason: 'It failed when we ran it.' }
		]);
		expect(searchCorpus(manifest, { q: 'good' })[0]!.blockers).toEqual([]);
	});

	it('judges a needs-upgrade codebase by its run with the legacy layer', () => {
		const legacyRows = rows('inline', { update: { state: 'unsupported' } }) as Record<
			string,
			Cell
		>;
		const sources: CorpusSources = {
			upgrade: {
				repo: 'https://github.com/acme/old',
				shape: 'project',
				core: '10.3.13',
				legacy: { sha: SHA, date: '2026-11-08', rows: legacyRows as never }
			}
		};
		const [item] = searchCorpus(manifest, { q: 'upgrade' }, sources);
		expect(item).toMatchObject({
			status: 'partial',
			legacy: { date: '2026-11-08', baseOnly: false },
			checks: { passed: 12, total: 13 }
		});
		expect(checksSentence(item!)).toBe('12 of 13 checks pass with the legacy layer');
		expect(searchCorpus(manifest, { status: 'needs upgrade' }, sources)).toEqual([]);
	});

	it('keeps needs upgrade when the legacy run passes nothing', () => {
		const sources: CorpusSources = {
			upgrade: {
				repo: 'https://github.com/acme/old',
				shape: 'project',
				core: '10.3.13',
				legacy: { sha: SHA, date: '2026-11-08', rows: rows('unsupported') as never }
			}
		};
		expect(searchCorpus(manifest, { q: 'upgrade' }, sources)[0]).toMatchObject({
			status: 'needs upgrade',
			legacy: null
		});
	});

	it('marks a legacy run that enabled no modules as the base site only', () => {
		const legacyRows = rows('inline', {
			install: { state: 'inline', note: '0/0 modules enabled; run with PLAN=paid' }
		});
		const sources: CorpusSources = {
			upgrade: {
				repo: 'https://github.com/acme/old',
				shape: 'project',
				core: '10.3.13',
				legacy: { sha: SHA, date: '2026-11-08', rows: legacyRows as never }
			}
		};
		expect(searchCorpus(manifest, { q: 'upgrade' }, sources)[0]?.legacy).toEqual({
			date: '2026-11-08',
			baseOnly: true
		});
	});

	it('matches part of the name without regard to case', () => {
		expect(searchCorpus(manifest, { q: '  GOOD ' }).map((item) => item.id)).toEqual(['good']);
	});

	it('filters by status', () => {
		expect(searchCorpus(manifest, { status: 'needs upgrade' }).map((item) => item.id)).toEqual([
			'upgrade'
		]);
	});

	it('returns nothing when no codebase matches', () => {
		expect(searchCorpus(manifest, { q: 'nothing-here' })).toEqual([]);
	});

	it('carries the capability cells of each codebase', () => {
		const good = searchCorpus(manifest, { q: 'good' })[0];
		expect(Object.keys(good?.cells ?? {})).toHaveLength(13);
	});
});

describe('reasonOf', () => {
	it('turns a lane note into one plain sentence', () => {
		expect(
			reasonOf('needs upgrade: core ^10.5.6 does not accept Drupal 11; drangler plans it')
		).toBe('Built for an older Drupal (^10.5.6). The platform runs Drupal 11.');
		expect(reasonOf('not a site: varbase_patches is a composer plugin')).toBe(
			'Not a site. Varbase_patches is a composer plugin.'
		);
		expect(reasonOf('blocked by install: enabling x was refused: Class "X"')).toBe(
			'Held back because it did not install.'
		);
		expect(reasonOf('enabling x was refused: Class "X" not found')).toBe(
			'Drupal refused to turn the module on.'
		);
		expect(reasonOf('14 failed: a/b 1.0: metadata 404')).toBe(
			'14 packages or modules did not install.'
		);
		expect(reasonOf('the run halted: unit-aborted: Symfony\\Exception')).toBe(
			'The update run stopped before it finished.'
		);
		expect(reasonOf('upload answered 500 and no media row names the file')).toBe(
			'A file upload did not save.'
		);
	});

	it('says only that it failed when the note says nothing it knows', () => {
		expect(reasonOf('')).toBe('It failed when we ran it.');
		expect(reasonOf('something new')).toBe('It failed when we ran it.');
	});

	it('never lets markup or json reach a reader', () => {
		const note = 'import answered 200; class="messages-list"> Error message | {"cfw":"php"}';
		expect(reasonOf(note)).not.toMatch(/[<>{}"]/);
	});
});

describe('corpus labels', () => {
	it('words the shape and the core version', () => {
		expect(shapeLabel('project')).toBe('Full Site');
		expect(shapeLabel('module')).toBe('Module');
		expect(shapeLabel('suite')).toBe('Module Suite');
		expect(shapeLabel('other')).toBeNull();
		expect(coreLabel('^11.3')).toBe('Drupal 11.3');
		expect(coreLabel('10.6.15')).toBe('Drupal 10.6.15');
		expect(coreLabel('^10 || ^11')).toBe('Drupal 10 or 11');
		expect(coreLabel('~11.4.0')).toBe('Drupal 11.4.0');
		expect(coreLabel('n/a')).toBeNull();
		expect(coreLabel(null)).toBeNull();
	});

	it('says how many checks were not run', () => {
		expect(
			checksSentence({
				checks: { passed: 8, total: 13, unchecked: 1 },
				legacy: null,
				status: 'partial'
			})
		).toBe('8 of 13 checks pass, 1 not checked');
	});

	it('does not report zero passes for a codebase that was never run', () => {
		const sentence = checksSentence({
			checks: { passed: 0, total: 13, unchecked: 0 },
			legacy: null,
			status: 'needs upgrade'
		});
		expect(sentence).toMatch(/^Not run with the legacy layer/);
		expect(sentence).not.toContain('0 of 13');
	});
});

describe('syncSources', () => {
	let dir: string;
	let workerDir: string;
	let target: string;
	const config = (repos: string) => `repos:\n${repos}`;
	const entry = (id: string) =>
		`  - id: ${id}\n    repo: https://github.com/acme/${id}\n    shape: module\n    core: ^11.3\n`;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'sync-sources-'));
		workerDir = join(dir, 'worker');
		await mkdir(join(workerDir, 'docs'), { recursive: true });
		await mkdir(join(workerDir, 'config'), { recursive: true });
		target = join(dir, 'corpus-sources.json');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('records where each codebase lives and keeps a legacy run only for the same commit', async () => {
		const manifest = parseCorpusManifest(fixture());
		const legacy = JSON.parse(fixture());
		legacy.repos.upgrade.sha = 'b'.repeat(40);
		await writeFile(
			join(workerDir, 'docs', 'compatibility-anachron.json'),
			JSON.stringify(legacy)
		);
		await writeFile(
			join(workerDir, 'config', 'corpus.yml'),
			config(['good', 'shipped', 'half', 'upgrade', 'refused'].map(entry).join(''))
		);

		const sources = await syncSources(workerDir, manifest, target);

		expect(sources.good).toMatchObject({
			repo: 'https://github.com/acme/good',
			shape: 'module',
			core: '^11.3',
			legacy: { sha: SHA }
		});
		expect(sources.upgrade?.legacy).toBeNull();
		expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(sources);
	});

	it('writes no legacy run when the worker has none', async () => {
		await writeFile(
			join(workerDir, 'config', 'corpus.yml'),
			config(['good', 'shipped', 'half', 'upgrade', 'refused'].map(entry).join(''))
		);

		const sources = await syncSources(workerDir, parseCorpusManifest(fixture()), target);

		expect(Object.values(sources).every((source) => source.legacy === null)).toBe(true);
	});

	it('refuses a codebase that corpus.yml does not list', async () => {
		await writeFile(join(workerDir, 'config', 'corpus.yml'), config(entry('good')));

		await expect(
			syncSources(workerDir, parseCorpusManifest(fixture()), target)
		).rejects.toThrow(CorpusInvalidError);
	});
});

describe('committed src/shared/corpus-sources.json', () => {
	it('covers every codebase in corpus.json', async () => {
		const read = (name: string) =>
			readFile(
				fileURLToPath(new URL(`../../../src/shared/${name}`, import.meta.url)),
				'utf8'
			);
		const manifest = parseCorpusManifest(await read('corpus.json'));
		const sources = corpusSourcesSchema.parse(JSON.parse(await read('corpus-sources.json')));

		expect(Object.keys(sources).sort()).toEqual(Object.keys(manifest.repos).sort());
	});

	it('gives every committed codebase a plain title and no machine name on screen', async () => {
		const read = (name: string) =>
			readFile(
				fileURLToPath(new URL(`../../../src/shared/${name}`, import.meta.url)),
				'utf8'
			);
		const manifest = parseCorpusManifest(await read('corpus.json'));
		const sources = corpusSourcesSchema.parse(JSON.parse(await read('corpus-sources.json')));

		for (const item of searchCorpus(manifest, {}, sources)) {
			expect(item.title).not.toMatch(/_/);
			expect(item.summary).not.toBe('');
		}
	});

	it('shows the codebases that only a legacy run can judge as something other than needs upgrade', async () => {
		const read = (name: string) =>
			readFile(
				fileURLToPath(new URL(`../../../src/shared/${name}`, import.meta.url)),
				'utf8'
			);
		const manifest = parseCorpusManifest(await read('corpus.json'));
		const sources = corpusSourcesSchema.parse(JSON.parse(await read('corpus-sources.json')));
		const withRun = searchCorpus(manifest, {}, sources).filter((item) => item.legacy !== null);

		expect(withRun.length).toBeGreaterThan(0);
		expect(withRun.every((item) => item.status !== 'needs upgrade')).toBe(true);
	});
});

describe('committed src/shared/corpus.json', () => {
	it('parses and derives the status counts the worker reports', async () => {
		const path = fileURLToPath(new URL('../../../src/shared/corpus.json', import.meta.url));
		const manifest = parseCorpusManifest(await readFile(path, 'utf8'));
		const counts: Record<string, number> = {};
		for (const entry of corpusEntries(manifest)) {
			counts[entry.status] = (counts[entry.status] ?? 0) + 1;
		}
		expect(counts).toEqual({
			deployed: 3,
			verified: 12,
			partial: 3,
			'needs upgrade': 6,
			unsupported: 3
		});
	});
});
