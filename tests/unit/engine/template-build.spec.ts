import { describe, expect, it } from 'vitest';
import { D1TemplateStore, jobRunnerOf } from '../../../engine/src/adapters/templates';
import { encodeBundle } from '../../../engine/src/containers/image/template-build.mjs';
import { JOB_MESSAGES, type RunRecord } from '../../../engine/src/containers/jobs';
import type { TemplateBuildDeps, TemplateJobAnswer } from '../../../engine/src/ports';
import { PermanentError, StepFailed, type StepRunner } from '../../../engine/src/step';
import { templateKeys } from '../../../engine/src/template-bundle';
import {
	runTemplateBuild,
	type TemplateBuildInput
} from '../../../engine/src/workflows/template-build';
import { templateSpec } from '../../../src/shared/template-entries';
import { memoryD1 } from './fakes';

const COMMIT = templateSpec('thunder').sha;
const INPUT: TemplateBuildInput = {
	buildId: 'tpl_aaaaaaaa',
	entryId: 'thunder',
	commit: COMMIT,
	spec: templateSpec('thunder')
};
const KEY = templateKeys.build(INPUT.entryId, INPUT.buildId);
const enc = new TextEncoder();

const manifest = (over: Record<string, unknown> = {}) => ({
	version: 1,
	entryId: 'thunder',
	commit: COMMIT,
	phpVersion: '8.4.27',
	buildSeconds: 12,
	rows: 2656,
	advisories: [{ id: 'SA-CORE-2026-014', package: 'drupal/core' }],
	patchesFailed: [{ package: 'drupal/pathauto', patch: 'https://drupal.test/3579655.diff' }],
	packages: 161,
	...over
});

const bundle = (over: Record<string, unknown> = {}, names = ['database.sql', 'composer.lock']) =>
	new Uint8Array(
		encodeBundle(
			manifest(over),
			names.map((name) => ({ name, bytes: enc.encode(`${name} body`) }))
		)
	);

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
	kind: 'template-build',
	key: KEY,
	state: 'succeeded',
	message: JOB_MESSAGES.succeeded,
	exitCode: 0,
	instance: 'standard-2',
	enableInternet: true,
	startedAt: 0,
	readyAt: 1,
	doneAt: 2,
	coldStartMs: 1,
	wallMs: 2,
	bytesIn: 0,
	bytesOut: 10,
	destroyed: true,
	logTail: null,
	...over
});

// a step that runs out of retries ends as StepFailed, as the workflow runner does
const steps: StepRunner = {
	async do(name, fn) {
		try {
			return await fn();
		} catch (error) {
			throw new StepFailed(name, error);
		}
	}
};

function world(
	answer: (blobs: Map<string, Uint8Array>) => TemplateJobAnswer | Promise<TemplateJobAnswer>
) {
	const blobs = new Map<string, Uint8Array>();
	const rows: {
		id: string;
		status: string;
		bundleKey?: string;
		manifest?: string;
		failure?: string;
	}[] = [];
	const deletes: string[] = [];
	const deps: TemplateBuildDeps = {
		jobs: { run: async () => answer(blobs) },
		blobs: {
			put: async (key, bytes) => void blobs.set(key, bytes),
			get: async (key) => blobs.get(key) ?? null,
			deletePrefix: async (prefix) => {
				deletes.push(prefix);
				for (const key of [...blobs.keys()]) if (key.startsWith(prefix)) blobs.delete(key);
				return 1;
			}
		},
		templates: {
			ready: async (id, patch) => void rows.push({ id, status: 'ready', ...patch }),
			fail: async (id, failure) => void rows.push({ id, status: 'failed', failure })
		}
	};
	return { deps, blobs, rows, deletes };
}

describe('a template build', () => {
	it('stores the bundle and marks the row ready with the manifest it read', async () => {
		const w = world((blobs) => {
			blobs.set(KEY, bundle());
			return record();
		});
		expect(await runTemplateBuild(steps, w.deps, INPUT)).toEqual({ status: 'succeeded' });
		expect(w.rows).toHaveLength(1);
		expect(w.rows[0]).toMatchObject({ id: INPUT.buildId, status: 'ready', bundleKey: KEY });
		expect(w.blobs.has(KEY)).toBe(true);
	});

	it('records the advisories and the failed patch in the stored manifest', async () => {
		const w = world((blobs) => {
			blobs.set(KEY, bundle());
			return record();
		});
		await runTemplateBuild(steps, w.deps, INPUT);
		const stored = JSON.parse(w.rows[0]?.manifest ?? '{}');
		expect(stored.advisories).toEqual([{ id: 'SA-CORE-2026-014', package: 'drupal/core' }]);
		expect(stored.patchesFailed).toEqual([
			{ package: 'drupal/pathauto', patch: 'https://drupal.test/3579655.diff' }
		]);
		expect(stored.rows).toBe(2656);
	});

	it('sends the job spec and the bundle key to the runner', async () => {
		let seen: { key: string; input: string } | undefined;
		const w = world(() => record({ state: 'job_failed', message: JOB_MESSAGES.job_failed }));
		w.deps.jobs.run = async ({ key, input }) => {
			seen = { key, input: new TextDecoder().decode(input) };
			return record({ state: 'job_failed', message: JOB_MESSAGES.job_failed });
		};
		await runTemplateBuild(steps, w.deps, INPUT);
		expect(seen?.key).toBe(KEY);
		expect(JSON.parse(seen?.input ?? '{}')).toEqual(INPUT.spec);
	});

	it.each(['job_failed', 'timed_out', 'killed', 'start_failed'] as const)(
		'leaves no ready row and no bundle when the job ends %s',
		async (state) => {
			const w = world((blobs) => {
				blobs.set(KEY, bundle());
				return record({ state, message: JOB_MESSAGES[state], logTail: 'composer stopped' });
			});
			const outcome = await runTemplateBuild(steps, w.deps, INPUT);
			expect(outcome).toMatchObject({ status: 'failed' });
			expect(w.rows.map((row) => row.status)).toEqual(['failed']);
			expect(w.rows[0]?.failure).toContain(JOB_MESSAGES[state]);
			expect(w.rows[0]?.failure).toContain('composer stopped');
			expect(w.blobs.has(KEY)).toBe(false);
			expect(w.deletes).toEqual([KEY]);
		}
	);

	it('fails on a refusal from the runner without keeping a row', async () => {
		const w = world(() => ({
			refused: 'input_too_large',
			message: 'The job input is larger than the limit for this job type.'
		}));
		const outcome = await runTemplateBuild(steps, w.deps, INPUT);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect(w.rows.map((row) => row.status)).toEqual(['failed']);
	});

	it('lets a busy runner retry as an ordinary error', async () => {
		const w = world(() => ({
			refused: 'busy',
			message: 'This runner is already running a job.'
		}));
		let thrown: unknown;
		const runner: StepRunner = {
			async do(_name, fn) {
				try {
					return await fn();
				} catch (error) {
					thrown = error;
					throw new StepFailed(_name, error);
				}
			}
		};
		await runTemplateBuild(runner, w.deps, INPUT);
		expect(thrown).not.toBeInstanceOf(PermanentError);
	});

	it('fails when the job succeeded but stored nothing', async () => {
		const w = world(() => record());
		const outcome = await runTemplateBuild(steps, w.deps, INPUT);
		expect(outcome).toMatchObject({
			status: 'failed',
			reason: expect.stringContaining('bundle_missing')
		});
		expect(w.rows.map((row) => row.status)).toEqual(['failed']);
	});

	it.each([
		[
			'a bundle for another commit',
			() => bundle({ commit: 'b'.repeat(40) }),
			'bundle_wrong_entry'
		],
		[
			'a bundle for another template',
			() => bundle({ entryId: 'govcms' }),
			'bundle_wrong_entry'
		],
		[
			'a bundle without a database',
			() => bundle({}, ['composer.lock']),
			'bundle_section_missing'
		],
		['a bundle without a lock', () => bundle({}, ['database.sql']), 'bundle_section_missing'],
		['a bundle that is not one', () => enc.encode('plain text'), 'bundle_malformed']
	])('refuses %s and removes it', async (_name, make, code) => {
		const w = world((blobs) => {
			blobs.set(KEY, make());
			return record();
		});
		const outcome = await runTemplateBuild(steps, w.deps, INPUT);
		expect(outcome).toMatchObject({ status: 'failed', reason: expect.stringContaining(code) });
		expect(w.rows.map((row) => row.status)).toEqual(['failed']);
		expect(w.blobs.has(KEY)).toBe(false);
	});
});

describe('the template store and the runner adapter', () => {
	function stored() {
		const { db, sqlite } = memoryD1();
		sqlite
			.prepare(
				`INSERT INTO template_bundles (id, entry_id, commit_sha, status, created_at) VALUES ('tpl_1', 'thunder', ?, 'building', 1)`
			)
			.run(COMMIT);
		const row = () =>
			sqlite
				.prepare(
					`SELECT status, bundle_key, manifest, failure FROM template_bundles WHERE id = 'tpl_1'`
				)
				.get();
		return { store: new D1TemplateStore(db), row };
	}

	it('marks a building row ready with its key and manifest', async () => {
		const { store, row } = stored();
		await store.ready('tpl_1', { bundleKey: KEY, manifest: '{}' });
		expect(row()).toMatchObject({
			status: 'ready',
			bundle_key: KEY,
			manifest: '{}',
			failure: null
		});
	});

	it('marks a building row failed and cuts a long reason', async () => {
		const { store, row } = stored();
		await store.fail('tpl_1', 'x'.repeat(5000));
		const failed = row() as { status: string; failure: string };
		expect(failed.status).toBe('failed');
		expect(failed.failure).toHaveLength(4096);
	});

	it('does not overwrite a ready row with a later failure', async () => {
		const { store, row } = stored();
		await store.ready('tpl_1', { bundleKey: KEY, manifest: '{}' });
		await store.fail('tpl_1', 'late');
		expect(row()).toMatchObject({ status: 'ready' });
	});

	it('posts the job to the one runner instance and returns its record', async () => {
		const calls: { url: string; headers: Headers; body: string }[] = [];
		const namespace = {
			idFromName: (name: string) => name,
			get: (name: string) => ({
				fetch: async (url: string, init: RequestInit) => {
					calls.push({
						url: `${name} ${url}`,
						headers: new Headers(init.headers),
						body: new TextDecoder().decode(init.body as Uint8Array)
					});
					return new Response(JSON.stringify(record()), { status: 200 });
				}
			})
		};
		const answer = await jobRunnerOf(namespace as never).run({
			key: KEY,
			input: enc.encode('{"a":1}')
		});
		expect(answer).toMatchObject({ state: 'succeeded' });
		expect(calls[0]?.url).toBe(
			`template-build https://runner/run?kind=template-build&key=${encodeURIComponent(KEY)}`
		);
		expect(calls[0]?.headers.get('x-input-bytes')).toBe('7');
		expect(calls[0]?.body).toBe('{"a":1}');
	});

	it.each([
		['text that is not JSON', 'oops'],
		['JSON that is not a record', 'null']
	])('throws when the runner answers with %s', async (_name, text) => {
		const namespace = {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response(text, { status: 500 }) })
		};
		await expect(
			jobRunnerOf(namespace as never).run({ key: KEY, input: enc.encode('{}') })
		).rejects.toThrow('without a record');
	});
});
