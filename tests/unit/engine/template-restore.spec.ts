import { describe, expect, it } from 'vitest';
import { encodeBundle } from '../../../engine/src/containers/image/template-build.mjs';
import { PermanentError, StepFailed } from '../../../engine/src/step';
import {
	installTemplateCode,
	lockSummaryNote,
	type TemplateCodeSummary,
	type TemplateCreate
} from '../../../engine/src/workflows/template-restore';
import { Killed, makeRunner, type Memo, type RunnerScript } from './fakes';

// the runner wraps a failed step; the refusal or the typed error is its reason
const reasonOf = (error: unknown) => (error instanceof StepFailed ? error.reason : error);

const OP = 'op_lock_wire';
const SITE = 'site_lock_wire';
const COMMIT = 'c'.repeat(40);
const KEY = 'templates/thunder/tpl_aaaaaaaa/bundle';
const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const TEMPLATE: TemplateCreate = { entryId: 'thunder', commit: COMMIT, bundleKey: KEY };
const enc = new TextEncoder();

const LOCK_SECTIONS = [
	{ name: 'database.sql', bytes: enc.encode('INSERT INTO a VALUES(1);') },
	{ name: 'composer.lock', bytes: enc.encode('{}') }
];

function bundleWith(sections: { name: string; bytes: Uint8Array }[]): Uint8Array {
	return new Uint8Array(
		encodeBundle(
			{
				version: 1,
				entryId: 'thunder',
				commit: COMMIT,
				phpVersion: '8.4.27',
				buildSeconds: 1,
				rows: 3,
				advisories: [],
				patchesFailed: [],
				packages: 1
			},
			sections
		)
	);
}

const SESSION = 'a1b2c3d4e5f6a7b8';

interface Answer {
	done: boolean;
	cursor: number;
	total: number;
	installed: number;
	skipped: number;
	failure: { name: string; error: string } | null;
	session: string;
	skippedPackages: { name: string; reason: string }[];
	patches: string;
}

function answer(over: Partial<Answer>): Answer {
	return {
		done: false,
		cursor: 0,
		total: 100,
		installed: 0,
		skipped: 0,
		failure: null,
		session: SESSION,
		skippedPackages: [],
		patches: 'not applied',
		...over
	};
}

// answers the window that starts at each cursor; an Error answer is thrown the way the adapter does
function harness(
	answers: Record<number, Answer | Error>,
	sections = LOCK_SECTIONS,
	options: { rollbackFails?: boolean } = {}
) {
	const calls: number[] = [];
	const rollbacks: string[] = [];
	let operation = {
		id: OP,
		status: 'running',
		updatedAt: new Date(NOW).toISOString(),
		steps: [
			{
				id: 'template-code',
				name: 'Install the template code',
				state: 'pending',
				attempt: 0,
				startedAt: null,
				finishedAt: null,
				error: null
			}
		]
	};
	const store = {
		mutate: async (_id: string, change: (value: typeof operation) => typeof operation) =>
			(operation = change(operation))
	};
	const worker = {
		installLock: async (_host: string, _lock: Uint8Array, cursor: number) => {
			calls.push(cursor);
			const next = answers[cursor];
			if (next === undefined) throw new Error(`no answer for cursor ${cursor}`);
			if (next instanceof Error) throw next;
			return next;
		},
		rollbackLock: async (_host: string, session: string) => {
			rollbacks.push(session);
			if (options.rollbackFails) throw new Error('site unreachable');
		}
	};
	const deps = {
		store,
		now: () => NOW,
		leases: { heartbeat: async () => ({ ok: true }) },
		config: { leaseTtlMs: 60_000 },
		custody: {
			withOwnerToken: async (_site: string, _id: string, use: (bearer: string) => unknown) =>
				use('bearer')
		},
		worker,
		blobs: { get: async () => bundleWith(sections) },
		sleep: async () => undefined
	};
	const run = (memo: Memo = new Map(), script: RunnerScript = {}) => {
		const { runner, executed } = makeRunner(memo, script);
		const ctx = {
			deps,
			step: runner,
			operationId: OP,
			siteId: SITE,
			accountId: 'acct_lock_wire',
			purpose: 'site.create',
			epoch: 1
		};
		return {
			executed,
			done: installTemplateCode(
				ctx as never,
				deps as never,
				{ siteId: SITE, hostname: 'thunder.example.test', ownerTokenId: 'tok_lock_wire' },
				TEMPLATE
			)
		};
	};
	const stepState = () => operation.steps.find((step) => step.id === 'template-code')?.state;
	return { calls, rollbacks, run, stepState };
}

describe('installTemplateCode', () => {
	it('installs a lock that finishes in one window', async () => {
		const h = harness({ 0: answer({ done: true, cursor: 100 }) });
		await h.run().done;
		expect(h.calls).toEqual([0]);
		expect(h.stepState()).toBe('succeeded');
	});

	it('resumes at the cursor after a crash between windows', async () => {
		const h = harness({
			0: answer({ cursor: 40 }),
			40: answer({ cursor: 80 }),
			80: answer({ done: true, cursor: 100 })
		});
		const memo: Memo = new Map();
		await expect(h.run(memo, { killAfter: 1 }).done).rejects.toBeInstanceOf(Killed);
		expect(h.calls).toEqual([0]);
		await h.run(memo).done;
		expect(h.calls).toEqual([0, 40, 80]);
		expect(h.stepState()).toBe('succeeded');
	});

	it('replays a finished lock without another call to the site', async () => {
		const h = harness({
			0: answer({ cursor: 40 }),
			40: answer({ done: true, cursor: 100 })
		});
		const memo: Memo = new Map();
		await h.run(memo).done;
		await h.run(memo).done;
		expect(h.calls).toEqual([0, 40]);
	});

	it('stops at a package that fails its checksum and names it in plain words', async () => {
		const h = harness({
			0: answer({
				cursor: 0,
				failure: {
					name: 'drupal/token',
					error: 'drupal/token archive does not match its published SHA-1 digest (expected aaaa, got bbbb), so it is not installed'
				}
			})
		});
		const failure = await h.run().done.catch(reasonOf);
		expect(failure).toBeInstanceOf(PermanentError);
		const message = (failure as PermanentError).message;
		expect((failure as PermanentError).code).toBe('template_code_failed');
		expect(message).toContain('drupal/token');
		expect(message).toContain('its download did not match its checksum');
		expect(message).not.toMatch(/SHA-1|expected|got bbbb/);
		expect(h.calls).toEqual([0]);
		expect(h.stepState()).toBe('failed');
	});

	it('refuses a lock for another Drupal core in plain words', async () => {
		const h = harness({
			0: new PermanentError('install_lock_refused', 'core 10.3 against 11.4')
		});
		const failure = await h.run().done.catch(reasonOf);
		expect(failure).toBeInstanceOf(PermanentError);
		expect((failure as PermanentError).message).toBe(
			'the site will not install the template code: core 10.3 against 11.4'
		);
		expect(h.calls).toEqual([0]);
	});

	it('skips the code step for a template with no lock and says nothing', async () => {
		const h = harness({}, [LOCK_SECTIONS[0]!]);
		await h.run().done;
		expect(h.calls).toEqual([]);
		expect(h.stepState()).toBe('succeeded');
	});

	it('stops when the site does not advance the cursor', async () => {
		const h = harness({ 0: answer({ cursor: 0 }) });
		const failure = await h.run().done.catch(reasonOf);
		expect((failure as PermanentError).code).toBe('template_code_stalled');
		expect(h.calls).toEqual([0]);
	});

	it('rolls back the session of a package that fails, then stops', async () => {
		const h = harness({
			0: answer({
				cursor: 0,
				failure: {
					name: 'drupal/token',
					error: 'drupal/token archive does not match its published SHA-1 digest (expected aaaa, got bbbb), so it is not installed'
				}
			})
		});
		await h.run().done.catch(reasonOf);
		expect(h.rollbacks).toEqual([SESSION]);
		expect(h.calls).toEqual([0]);
	});

	it('says the partly installed code stayed when the rollback fails too', async () => {
		const h = harness(
			{
				0: answer({
					cursor: 0,
					failure: { name: 'drupal/token', error: 'archive 502 from x' }
				})
			},
			LOCK_SECTIONS,
			{ rollbackFails: true }
		);
		const failure = await h.run().done.catch(reasonOf);
		expect((failure as PermanentError).code).toBe('template_code_failed');
		expect((failure as PermanentError).message).toBe(
			'the site could not install drupal/token: its archive could not be downloaded; the partly installed code could not be removed'
		);
	});

	it('returns the skipped packages and the patch word from the last window', async () => {
		const skipped = [
			{
				name: 'drupal/a',
				reason: 'composer-plugin: it runs inside composer, which the worker cannot run'
			},
			{
				name: 'drupal/b',
				reason: 'shipped: the pack carries 2.0.0 and keeps it; the lock names 2.1.0'
			}
		];
		const h = harness({
			0: answer({ cursor: 40 }),
			40: answer({ done: true, cursor: 100, skippedPackages: skipped })
		});
		expect(await h.run().done).toEqual({
			skippedPackages: [
				{ name: 'drupal/a', reason: 'a Composer plugin, which cannot run on the site' },
				{ name: 'drupal/b', reason: 'the site keeps the version it already has' }
			],
			patches: 'not applied'
		});
	});

	it('returns no summary for a template with no lock', async () => {
		const h = harness({}, [LOCK_SECTIONS[0]!]);
		expect(await h.run().done).toBeNull();
	});

	it('words the success note for skipped packages and for patches', () => {
		const none: TemplateCodeSummary = { skippedPackages: [], patches: 'applied' };
		expect(lockSummaryNote(none)).toBe('');
		const one: TemplateCodeSummary = {
			skippedPackages: [
				{ name: 'drupal/a', reason: 'a metapackage with no files of its own' }
			],
			patches: 'not applied'
		};
		expect(lockSummaryNote(one)).toBe(
			'; 1 package was skipped: drupal/a (a metapackage with no files of its own); Patches Not Applied, because a lock does not carry Composer patches'
		);
		const two: TemplateCodeSummary = {
			skippedPackages: [
				{ name: 'drupal/a', reason: 'x' },
				{ name: 'drupal/b', reason: 'y' }
			],
			patches: 'applied'
		};
		expect(lockSummaryNote(two)).toBe('; 2 packages were skipped: drupal/a (x), drupal/b (y)');
	});

	it('stops when the lock takes more windows than the cap allows', async () => {
		const answers: Record<number, Answer> = {};
		for (let window = 0; window < 30; window++) {
			answers[window * 40] = answer({ cursor: (window + 1) * 40 });
		}
		const h = harness(answers);
		const failure = await h.run().done.catch(reasonOf);
		expect((failure as PermanentError).code).toBe('template_code_stalled');
		expect(h.calls).toHaveLength(30);
	});
});
