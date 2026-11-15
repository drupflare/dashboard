import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { D1BackupLedger } from '../../../engine/src/adapters/backups';
import { moduleWorkerOf } from '../../../engine/src/adapters/modules';
import { backupWorkerOf } from '../../../engine/src/adapters/site';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { ModuleDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import {
	planModuleEnable,
	runModuleEnable,
	type ModuleEnableInput
} from '../../../engine/src/workflows/module-enable';
import {
	planModuleInstall,
	runModuleInstall,
	type ModuleInstallInput
} from '../../../engine/src/workflows/module-install';
import {
	NEEDS_WORKER_UPDATE,
	planModuleRemove,
	runModuleRemove,
	type ModuleRemoveInput
} from '../../../engine/src/workflows/module-remove';
import {
	NEEDS_THEME_UPDATE,
	planThemeDefault,
	runThemeDefault,
	type ThemeDefaultInput
} from '../../../engine/src/workflows/theme-default';
import type { ModuleRow } from '../../../src/shared/modules';
import { dumpOf, fakeBlobs, fakeWorkers } from './backup-fakes';
import {
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	type Memo,
	type RunnerScript
} from './fakes';
import { fakeModules } from './module-fakes';

const BACKUP_ID = `bkp_${'m'.repeat(26)}`;
const TOKEN = 'drupal/token';
const PATHAUTO = 'drupal/pathauto';
const GIN = 'drupal/gin';

const row = (patch: Partial<ModuleRow> = {}): ModuleRow => ({
	name: TOKEN,
	label: 'Token',
	kind: 'unknown',
	state: 'verified',
	shipping: false,
	needs: [],
	...patch
});

type Held = Parameters<typeof fakeModules>[0];

async function moduleWorld(held: Held = {}) {
	const world = await makeWorld();
	const log: string[] = [];
	const db = (world.ledger as unknown as { db: D1Database }).db;
	const worker = fakeWorkers(log);
	const blobs = fakeBlobs();
	const now = world.clock.now();
	world.sqlite
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, account_id,
			created_at, updated_at) VALUES (?, ?, 'Site', 'managed', 'active', ?, ?, ?, ?)`
		)
		.run(world.siteId, world.orgId, world.input.hostname, world.accountId, now, now);
	await world.deps.custody.sealOwnerToken(world.siteId, FAKE_OWNER_TOKEN);
	worker.add(world.input.hostname, world.siteId, { sql: dumpOf(30), aligned: true });
	const fake = fakeModules(held);
	const deps: ModuleDeps = {
		...world.deps,
		worker: backupWorkerOf(worker.fetcher, 1_000),
		blobs: blobs.blobs,
		backups: new D1BackupLedger(db),
		sleep: async () => undefined,
		modules: fake.worker
	};
	return { world, deps, worker, blobs, fake };
}

type Mw = Awaited<ReturnType<typeof moduleWorld>>;

const base = (mw: Mw, name: string) => ({
	operationId: mw.world.operationId,
	orgId: mw.world.orgId,
	siteId: mw.world.siteId,
	accountId: mw.world.accountId,
	backupId: BACKUP_ID,
	name
});

const installInput = (mw: Mw, patch: Partial<ModuleInstallInput> = {}): ModuleInstallInput => ({
	...base(mw, TOKEN),
	census: { state: 'verified', shipping: false },
	confirm: false,
	...patch
});

const enableInput = (mw: Mw, patch: Partial<ModuleEnableInput> = {}): ModuleEnableInput => ({
	...base(mw, TOKEN),
	census: { state: 'verified', shipping: false },
	...patch
});

const removeInput = (mw: Mw, patch: Partial<ModuleRemoveInput> = {}): ModuleRemoveInput => ({
	...base(mw, TOKEN),
	census: row(),
	...patch
});

const themeInput = (mw: Mw, patch: Partial<ThemeDefaultInput> = {}): ThemeDefaultInput => ({
	...base(mw, GIN),
	census: { state: 'verified' },
	target: 'default',
	...patch
});

async function start(mw: Mw, plan: ReturnType<typeof planModuleInstall>) {
	const operation = newOperation({
		id: mw.world.operationId,
		orgId: mw.world.orgId,
		idempotencyKey: 'module-1',
		frozen: await freezePlan(plan),
		now: mw.world.clock.now()
	});
	await mw.world.store.begin({
		operation,
		accountId: mw.world.accountId,
		siteId: mw.world.siteId
	});
}

interface Options {
	memo?: Memo;
	script?: RunnerScript;
}

async function runInstall(mw: Mw, input = installInput(mw), options: Options = {}) {
	if (options.memo === undefined || options.memo.size === 0) {
		await start(mw, planModuleInstall(input));
	}
	const { runner, executed } = makeRunner(options.memo ?? new Map(), options.script);
	return { outcome: await runModuleInstall(runner, mw.deps, input), executed };
}

async function runEnable(mw: Mw, input = enableInput(mw)) {
	await start(mw, planModuleEnable(input));
	const { runner, executed } = makeRunner(new Map());
	return { outcome: await runModuleEnable(runner, mw.deps, input), executed };
}

async function runRemove(mw: Mw, input = removeInput(mw)) {
	await start(mw, planModuleRemove(input));
	const { runner, executed } = makeRunner(new Map());
	return { outcome: await runModuleRemove(runner, mw.deps, input), executed };
}

async function runTheme(mw: Mw, input = themeInput(mw)) {
	await start(mw, planThemeDefault(input));
	const { runner, executed } = makeRunner(new Map());
	return { outcome: await runThemeDefault(runner, mw.deps, input), executed };
}

const operationOf = async (mw: Mw) => (await mw.world.store.get(mw.world.operationId))!;
const restorePoint = (mw: Mw) => mw.deps.backups.get(mw.world.orgId, BACKUP_ID);
const reasonOf = (outcome: { status: string; reason?: string }) => outcome.reason ?? '';

describe('the plans', () => {
	it('names the restore point as the rollback point and keeps step ids unique', async () => {
		const mw = await moduleWorld();
		const plans = [
			planModuleInstall(installInput(mw)),
			planModuleEnable(enableInput(mw)),
			planModuleRemove(removeInput(mw)),
			planThemeDefault(themeInput(mw))
		];
		expect(plans.map((plan) => plan.type)).toEqual([
			'module.install',
			'module.enable',
			'module.remove',
			'theme.default'
		]);
		for (const plan of plans) {
			const ids = plan.steps.map((step) => step.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids.slice(0, 2)).toEqual(['lease', 'preflight']);
			expect(ids).toContain('export-record'.replace('export', 'restore-point'));
			expect(plan.rollbackPoint).toBe(BACKUP_ID);
		}
	});
});

describe('an install', () => {
	it('takes a restore point first, installs once and checks the site', async () => {
		const mw = await moduleWorld();
		let pointBefore = false;
		mw.fake.script.beforeInstall = async () => {
			pointBefore = (await restorePoint(mw)) !== null;
		};
		const { outcome } = await runInstall(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(pointBefore).toBe(true);
		expect(mw.fake.calls.installs).toEqual([TOKEN]);
		expect(mw.fake.modules.get('token')).toEqual({ present: true, enabled: false });
		const operation = await operationOf(mw);
		expect(operation.status).toBe('succeeded');
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(operation.rollbackPoint).toBe(BACKUP_ID);
		expect(await restorePoint(mw)).toMatchObject({
			siteId: mw.world.siteId,
			label: `Restore point before installing ${TOKEN}`
		});
		expect(mw.world.leases.stateOf(mw.world.siteId).holder ?? null).toBeNull();
	});

	it('uses the owner token the site holds for every call', async () => {
		const mw = await moduleWorld();
		await runInstall(mw);
		expect([...mw.fake.calls.bearers]).toEqual([FAKE_OWNER_TOKEN]);
	});

	it('refuses on a conflict from the check and calls the site no further', async () => {
		const mw = await moduleWorld();
		mw.fake.script.verdict = {
			verdict: 'blocked',
			conflicts: [
				{ requires: 'drupal/core', constraint: '^12', installed: '11.1', reason: 'version' }
			]
		};
		const { outcome } = await runInstall(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('would conflict');
		expect(reasonOf(outcome)).toContain('drupal/core ^12');
		expect(mw.fake.calls.installs).toEqual([]);
		expect(mw.fake.calls.reads).toEqual([]);
		expect(await restorePoint(mw)).toBeNull();
		expect(mw.blobs.objects.size).toBe(0);
		expect((await operationOf(mw)).status).toBe('failed');
	});

	it('refuses a module the site has no release of', async () => {
		const mw = await moduleWorld();
		mw.fake.script.verdict = { verdict: 'not-found', conflicts: [] };
		const { outcome } = await runInstall(mw);
		expect(reasonOf(outcome)).toContain('No release of this module was found.');
		expect(mw.fake.calls.installs).toEqual([]);
	});

	it('refuses a module whose requirements cannot be checked', async () => {
		const mw = await moduleWorld();
		mw.fake.script.verdict = { verdict: 'unverifiable', conflicts: [] };
		const { outcome } = await runInstall(mw);
		expect(reasonOf(outcome)).toContain('cannot be checked');
		expect(mw.fake.calls.installs).toEqual([]);
	});

	it.each([
		[
			'a blocked module',
			{ state: 'blocked', shipping: false, reason: 'needs a park' },
			'needs a park'
		],
		['a module in the pack', { state: 'verified', shipping: true }, 'already included'],
		['a name that is not on the list', null, 'not on the list'],
		[
			'an untested module without confirm',
			{ state: 'untested', shipping: false },
			'never been run'
		]
	] as const)('refuses %s before it calls the site', async (_label, census, text) => {
		const mw = await moduleWorld();
		const { outcome } = await runInstall(mw, installInput(mw, { census: census as never }));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain(text);
		expect(mw.fake.calls.installable).toEqual([]);
		expect(mw.fake.calls.installs).toEqual([]);
		expect(await restorePoint(mw)).toBeNull();
	});

	it('installs an untested module once the owner confirmed it', async () => {
		const mw = await moduleWorld();
		const input = installInput(mw, {
			census: { state: 'untested', shipping: false },
			confirm: true
		});
		const { outcome } = await runInstall(mw, input);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.installs).toEqual([TOKEN]);
	});

	it('checks again on the server, whatever an earlier check said', async () => {
		const mw = await moduleWorld();
		await runInstall(mw);
		expect(mw.fake.calls.installable).toEqual([TOKEN]);
	});

	it('leaves the site as it was when the site fails the install, and says why', async () => {
		const mw = await moduleWorld();
		mw.fake.script.installOk = false;
		const { outcome } = await runInstall(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('The site could not install drupal/token.');
		expect(reasonOf(outcome)).toContain('left as it was');
		expect(mw.fake.modules.get('token')).toBeUndefined();
		const operation = await operationOf(mw);
		expect(operation.status).toBe('failed');
		expect(operation.verification).toBe('failed');
		expect(operation.finalObservation?.summary).toContain('left as it was');
		expect(await restorePoint(mw)).not.toBeNull();
		expect(mw.world.leases.stateOf(mw.world.siteId).holder ?? null).toBeNull();
	});

	it('points to the restore point when it cannot tell what the install left', async () => {
		const mw = await moduleWorld();
		mw.fake.worker.read = async () => {
			throw new Error('the site is gone');
		};
		const { outcome } = await runInstall(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain(`Restore point ${BACKUP_ID}`);
	});

	it('names a restore point that is too large and takes no install', async () => {
		const mw = await moduleWorld();
		const { outcome } = await runInstall(mw, installInput(mw, { restoreCeilingBytes: 200 }));
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('200 bytes');
		expect(mw.fake.calls.installs).toEqual([]);
		expect(await restorePoint(mw)).toBeNull();
		expect(mw.blobs.objects.size).toBe(0);
	});

	it('skips the install when the code is already on the site', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: false } });
		const { outcome } = await runInstall(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.installs).toEqual([]);
	});

	it('refuses a site of another organisation', async () => {
		const mw = await moduleWorld();
		const { outcome } = await runInstall(
			mw,
			installInput(mw, { orgId: `org_${'q'.repeat(26)}` })
		);
		expect(outcome.status).toBe('failed');
		expect(mw.fake.calls.installable).toEqual([]);
	});

	it('picks up after a kill at every step and never installs twice', async () => {
		const probe = await moduleWorld();
		const clean = await runInstall(probe);
		const total = clean.executed.length;
		expect(total).toBeGreaterThan(10);
		for (let at = 1; at < total; at++) {
			const mw = await moduleWorld();
			const memo: Memo = new Map();
			await runInstall(mw, installInput(mw), { memo, script: { killAfter: at } }).catch(
				(error) => {
					expect(error).toBeInstanceOf(Killed);
				}
			);
			const { runner } = makeRunner(memo);
			expect(await runModuleInstall(runner, mw.deps, installInput(mw))).toEqual({
				status: 'succeeded'
			});
			expect(mw.fake.calls.installs, `killed after ${at} steps`).toEqual([TOKEN]);
		}
	});

	it('does not install twice when the answer of the install step was lost', async () => {
		const probe = await moduleWorld();
		const clean = await runInstall(probe);
		const mw = await moduleWorld();
		const memo: Memo = new Map();
		const killDuring = clean.executed.indexOf('install') + 1;
		await expect(
			runInstall(mw, installInput(mw), { memo, script: { killDuring } })
		).rejects.toBeInstanceOf(Killed);
		expect(mw.fake.calls.installs).toEqual([TOKEN]);
		const { runner } = makeRunner(memo);
		expect(await runModuleInstall(runner, mw.deps, installInput(mw))).toEqual({
			status: 'succeeded'
		});
		expect(mw.fake.calls.installs).toEqual([TOKEN]);
	});

	it('fails the check when the site does not show the module afterward', async () => {
		const mw = await moduleWorld();
		const real = mw.fake.worker.install;
		mw.fake.worker.install = async (...args) => {
			await real(...args);
			mw.fake.modules.delete('token');
			return { ok: true };
		};
		const { outcome } = await runInstall(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('does not show the module');
		expect((await operationOf(mw)).verification).toBe('failed');
	});
});

describe('an enable', () => {
	it('takes a restore point, enables once and checks the module is on', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: false } });
		const { outcome } = await runEnable(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.enables).toEqual(['token']);
		expect(mw.fake.modules.get('token')).toEqual({ present: true, enabled: true });
		expect(await restorePoint(mw)).toMatchObject({
			label: `Restore point before enabling ${TOKEN}`
		});
		const operation = await operationOf(mw);
		expect(operation.verification).toBe('passed');
		expect(operation.steps.every((step) => step.state === 'succeeded')).toBe(true);
	});

	it('enables a theme the same way', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: false } });
		const { outcome } = await runEnable(mw, enableInput(mw, { ...base(mw, GIN) }));
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.enables).toEqual(['gin']);
	});

	it('refuses a module that is not on the site and makes no change', async () => {
		const mw = await moduleWorld();
		const { outcome } = await runEnable(mw);
		expect(reasonOf(outcome)).toContain('Install it first');
		expect(mw.fake.calls.enables).toEqual([]);
		expect(await restorePoint(mw)).toBeNull();
	});

	it('refuses a blocked module and one on no list', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: false } });
		const blocked = await runEnable(
			mw,
			enableInput(mw, {
				census: { state: 'blocked', shipping: false, reason: 'needs a park' }
			})
		);
		expect(reasonOf(blocked.outcome)).toContain('needs a park');
		const other = await moduleWorld({ token: { present: true, enabled: false } });
		const unknown = await runEnable(other, enableInput(other, { census: null }));
		expect(reasonOf(unknown.outcome)).toContain('not on the list');
		expect(mw.fake.calls.enables.concat(other.fake.calls.enables)).toEqual([]);
	});

	it('leaves the site as it was when the site fails the enable', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: false } });
		mw.fake.script.enableOk = false;
		const { outcome } = await runEnable(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('The site could not enable drupal/token.');
		expect(reasonOf(outcome)).toContain('left as it was');
		expect(mw.fake.modules.get('token')!.enabled).toBe(false);
		expect(await restorePoint(mw)).not.toBeNull();
	});

	it('does not call the site again for a module that is already on', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		const { outcome } = await runEnable(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.enables).toEqual([]);
	});

	it('fails when the module is still off after the call', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: false } });
		mw.fake.worker.enable = async () => ({ ok: true });
		const { outcome } = await runEnable(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('does not show the module as on');
	});
});

describe('a removal', () => {
	const plan = (
		patch: Partial<{
			enabledModules: string[];
			dependents: string[];
			wouldDelete: string[];
		}> = {}
	) => ({
		kind: 'plan' as const,
		enabledModules: ['token', 'pathauto'],
		dependents: [] as string[],
		wouldDelete: [] as string[],
		...patch
	});

	it('refuses while a dependent is enabled, names it, and changes nothing', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		mw.fake.script.uninstall = plan({ dependents: ['pathauto'] });
		const { outcome } = await runRemove(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('Token is needed by pathauto, which is enabled.');
		expect(mw.fake.calls.uninstalls).toEqual([{ project: 'token', dryRun: true }]);
		expect(await restorePoint(mw)).toBeNull();
	});

	it('removes a module no enabled module needs, after a restore point', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		mw.fake.script.uninstall = plan({ dependents: ['views'], wouldDelete: ['token.settings'] });
		const { outcome } = await runRemove(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.uninstalls).toEqual([
			{ project: 'token', dryRun: true },
			{ project: 'token', dryRun: false }
		]);
		expect(mw.fake.modules.get('token')!.enabled).toBe(false);
		expect(await restorePoint(mw)).toMatchObject({
			label: `Restore point before removing ${TOKEN}`
		});
		expect((await operationOf(mw)).verification).toBe('passed');
	});

	it('refuses a module in the pack', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		mw.fake.script.uninstall = plan();
		const { outcome } = await runRemove(
			mw,
			removeInput(mw, { census: row({ shipping: true }) })
		);
		expect(reasonOf(outcome)).toContain('included with every site');
		expect(mw.fake.calls.uninstalls).toHaveLength(1);
	});

	it('refuses a name that is not on the list', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		mw.fake.script.uninstall = plan();
		const { outcome } = await runRemove(mw, removeInput(mw, { census: null }));
		expect(reasonOf(outcome)).toContain('not on the list');
	});

	it('leaves the site as it was when the removal fails', async () => {
		const mw = await moduleWorld({ token: { present: true, enabled: true } });
		mw.fake.script.uninstall = plan();
		const real = mw.fake.worker.uninstall;
		mw.fake.worker.uninstall = async (host, project, options, auth) =>
			options.dryRun ? real(host, project, options, auth) : { kind: 'not_available' };
		const { outcome } = await runRemove(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('left as it was');
		expect(mw.fake.modules.get('token')!.enabled).toBe(true);
	});

	it('answers the plain refusal with the real adapter, before any restore point', async () => {
		const mw = await moduleWorld();
		const fetcher = siteFetcherOf({
			'/enable': { ok: true, discoverable: true, alreadyEnabled: true }
		});
		mw.deps.modules = moduleWorkerOf(fetcher, 1_000);
		const { outcome } = await runRemove(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain(NEEDS_WORKER_UPDATE);
		expect(await restorePoint(mw)).toBeNull();
		expect(mw.blobs.objects.size).toBe(0);
		expect((await operationOf(mw)).status).toBe('failed');
	});
});

describe('a default theme change', () => {
	it('sets the theme after a restore point and asks the site which theme it uses', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: true } });
		const { outcome } = await runTheme(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.script.themes).toEqual({ default: 'gin', admin: null });
		expect(await restorePoint(mw)).toMatchObject({
			label: 'Restore point before changing the default theme'
		});
		expect((await operationOf(mw)).verification).toBe('passed');
	});

	it('sets the admin theme', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: true } });
		await runTheme(mw, themeInput(mw, { target: 'admin' }));
		expect(mw.fake.script.themes).toEqual({ default: null, admin: 'gin' });
	});

	it('does not write again when the theme is already the one asked for', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: true } });
		mw.fake.script.themes.default = 'gin';
		const { outcome } = await runTheme(mw);
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(mw.fake.calls.themes.filter((call) => !call.dryRun)).toEqual([]);
	});

	it('refuses a theme that is not enabled', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: false } });
		const { outcome } = await runTheme(mw);
		expect(reasonOf(outcome)).toContain('Enable the theme');
		expect(await restorePoint(mw)).toBeNull();
	});

	it('refuses a blocked theme and one on no list', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: true } });
		const blocked = await runTheme(
			mw,
			themeInput(mw, { census: { state: 'blocked', reason: 'no' } })
		);
		expect(reasonOf(blocked.outcome)).toContain('no');
		const other = await moduleWorld({ gin: { present: true, enabled: true } });
		const unknown = await runTheme(other, themeInput(other, { census: null }));
		expect(reasonOf(unknown.outcome)).toContain('not on the list');
	});

	it('answers the plain refusal with the real adapter, before any restore point', async () => {
		const mw = await moduleWorld();
		mw.deps.modules = moduleWorkerOf(siteFetcherOf({}), 1_000);
		const { outcome } = await runTheme(mw);
		expect(reasonOf(outcome)).toContain(NEEDS_THEME_UPDATE);
		expect(await restorePoint(mw)).toBeNull();
	});

	it('fails when the site does not report the theme afterward', async () => {
		const mw = await moduleWorld({ gin: { present: true, enabled: true } });
		const real = mw.fake.worker.setDefaultTheme;
		mw.fake.worker.setDefaultTheme = async (host, change, options, auth) => {
			const answer = await real(host, change, options, auth);
			if (!options.dryRun) mw.fake.script.themes.default = 'olivero';
			return answer;
		};
		const { outcome } = await runTheme(mw);
		expect(outcome.status).toBe('failed');
		expect(reasonOf(outcome)).toContain('does not use drupal/gin');
	});
});

// a site that answers every route from a table and records what it was asked
function siteFetcherOf(answers: Record<string, unknown>, status = 200) {
	const seen: string[] = [];
	const fetcher = (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		seen.push(`${url.pathname}${url.search}`);
		const body = answers[url.pathname];
		return Response.json(body ?? { ok: false }, { status: body === undefined ? 404 : status });
	}) as typeof fetch;
	return Object.assign(fetcher, { seen });
}

describe('the site adapter', () => {
	const auth = { bearer: FAKE_OWNER_TOKEN };
	const host = 'a.example.test';

	it('reads the verdict of the check', async () => {
		const fetcher = siteFetcherOf({
			'/installable': {
				verdict: 'blocked',
				conflicts: [
					{ requires: 'php', constraint: '^9', installed: '8.4', reason: 'version' }
				]
			}
		});
		const worker = moduleWorkerOf(fetcher, 1_000);
		expect(await worker.installable(host, TOKEN, auth)).toEqual({
			verdict: 'blocked',
			conflicts: [{ requires: 'php', constraint: '^9', installed: '8.4', reason: 'version' }]
		});
		expect(fetcher.seen).toEqual(['/installable?module=drupal%2Ftoken']);
	});

	it('maps a dry enable to a reading, a theme counting as present', async () => {
		const modules = moduleWorkerOf(
			siteFetcherOf({ '/enable': { ok: true, discoverable: true, alreadyEnabled: false } }),
			1_000
		);
		expect(await modules.read(host, 'token', auth)).toEqual({ present: true, enabled: false });
		const themes = moduleWorkerOf(
			siteFetcherOf({ '/enable': { ok: true, kind: 'theme', alreadyEnabled: true } }),
			1_000
		);
		expect(await themes.read(host, 'gin', auth)).toEqual({ present: true, enabled: true });
		const absent = moduleWorkerOf(
			siteFetcherOf({ '/enable': { ok: false, discoverable: false } }),
			1_000
		);
		expect(await absent.read(host, 'nope', auth)).toEqual({ present: false, enabled: false });
	});

	it('retries when the site drops its interpreter and asks for the call again', async () => {
		const worker = moduleWorkerOf(
			siteFetcherOf({ '/enable': { ok: false, retry: true } }),
			1_000
		);
		await expect(worker.read(host, 'token', auth)).rejects.toThrow('asked for the call again');
		await expect(worker.enable(host, 'token', auth)).rejects.toThrow(
			'asked for the call again'
		);
	});

	it('installs with the packages the module needs and reports a refusal as not ok', async () => {
		const ok = siteFetcherOf({ '/install': { ok: true, name: TOKEN } });
		expect(await moduleWorkerOf(ok, 1_000).install(host, TOKEN, auth)).toEqual({ ok: true });
		expect(ok.seen).toEqual(['/install?module=drupal%2Ftoken&deps=1']);
		const failed = siteFetcherOf({ '/install': { ok: false } }, 502);
		expect(await moduleWorkerOf(failed, 1_000).install(host, TOKEN, auth)).toEqual({
			ok: false
		});
		const refused = siteFetcherOf({ '/install': { ok: false, refused: 'blocked' } }, 409);
		expect(await moduleWorkerOf(refused, 1_000).install(host, TOKEN, auth)).toEqual({
			ok: false
		});
	});

	it('retries a server error from the install and does not retry a refused token', async () => {
		const down = moduleWorkerOf(siteFetcherOf({ '/install': { ok: false } }, 503), 1_000);
		const error = await down.install(host, TOKEN, auth).catch((cause) => cause);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PermanentError);
		const refused = moduleWorkerOf(siteFetcherOf({ '/install': { ok: true } }, 401), 1_000);
		await expect(refused.install(host, TOKEN, auth)).rejects.toBeInstanceOf(PermanentError);
	});

	it('wakes the fill queue after an enable that asks for it', async () => {
		const fetcher = siteFetcherOf({
			'/enable': { ok: true, nowEnabled: true, armFill: true },
			'/armfill': { ok: true }
		});
		expect(await moduleWorkerOf(fetcher, 1_000).enable(host, 'token', auth)).toEqual({
			ok: true
		});
		expect(fetcher.seen).toEqual(['/enable?module=token', '/armfill']);
	});

	it('reports an enable that left the module off as not ok', async () => {
		const worker = moduleWorkerOf(
			siteFetcherOf({ '/enable': { ok: true, nowEnabled: false } }),
			1_000
		);
		expect(await worker.enable(host, 'token', auth)).toEqual({ ok: false });
	});

	it('answers not_available for a removal and a theme change', async () => {
		const worker = moduleWorkerOf(siteFetcherOf({}), 1_000);
		expect(await worker.uninstall(host, 'token', { dryRun: true }, auth)).toEqual({
			kind: 'not_available'
		});
		expect(
			await worker.setDefaultTheme(
				host,
				{ project: 'gin', target: 'admin' },
				{ dryRun: false },
				auth
			)
		).toEqual({ kind: 'not_available' });
	});

	it('refuses an unreadable answer to the check', async () => {
		const worker = moduleWorkerOf(
			siteFetcherOf({ '/installable': { verdict: 'maybe' } }),
			1_000
		);
		await expect(worker.installable(host, TOKEN, auth)).rejects.toThrow('no readable');
	});
});
