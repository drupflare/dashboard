import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncCorpus } from '../../../scripts/sync-corpus';
import {
	CorpusInvalidError,
	corpusEntries,
	installDecision,
	parseCorpusManifest,
	type CorpusEntry
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
