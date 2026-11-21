import { createHooks } from 'hookable';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../../../src/server/plugins/boot';
import { isBooted, resetBoot, type BootEnv } from '../../../src/server/services/boot';
import budgetEvaluate from '../../../src/server/tasks/budget-evaluate';
import usageCollect from '../../../src/server/tasks/usage-collect';
import { openBindings, type Bindings, type OpenBindings } from '../support';

vi.mock('nitropack/runtime', () => ({
	defineNitroPlugin: (p: unknown) => p,
	defineTask: (t: unknown) => t,
	useRuntimeConfig: () => ({
		baseUrl: 'https://stage.example.test',
		public: {
			githubClientId: '',
			gitlabClientId: '',
			cloudflareClientId: '',
			githubAppId: '',
			githubAppClientId: '',
			githubAppSlug: 'drupflare'
		},
		githubApp: { privateKey: '', clientSecret: '', webhookSecret: '' },
		releaseHook: { secret: '' }
	})
}));

type Task = { run(input: { context: unknown }): Promise<{ result?: unknown }> };
const budget = budgetEvaluate as unknown as Task;
const usage = usageCollect as unknown as Task;

// the database library logs its own first-open errors, so only the task lines count
const taskErrors = (spy: { mock: { calls: unknown[][] } }) =>
	spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('task '));

const COUNTS = 'counts-scheduled-secret-'.repeat(2);
const engine = { fetch: async () => Response.json({ ok: true, results: [] }) };

let open: OpenBindings;
let env: Bindings;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
});

afterAll(() => open.close());

beforeEach(() => resetBoot());

afterEach(() => {
	resetBoot();
	vi.restoreAllMocks();
});

// the preset's scheduled(): the hook first, then the task with the cloudflare env as its context
async function scheduledRun(run: Task, withEnv: Record<string, unknown>) {
	const hooks = createHooks();
	(plugin as unknown as (app: unknown) => void)({ hooks });
	const bootEnv = Object.assign({}, env, withEnv) as BootEnv;
	const hook = hooks.callHook('cloudflare:scheduled', {
		controller: {},
		env: bootEnv,
		context: {}
	});
	// runTask awaits the task module before it calls run, so the task starts a tick after the hook
	const result = (async () => {
		await Promise.resolve();
		return run.run({ context: { cloudflare: { env: bootEnv, context: {} } } });
	})();
	await hook;
	return result;
}

describe('scheduled tasks after only a scheduled boot (regression: scheduled boots are covered)', () => {
	it('evaluates the budgets instead of skipping as not installed', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		expect(isBooted()).toBe(false);
		const out = await scheduledRun(budget, { ENGINE: engine, COUNTS_SECRET: COUNTS });
		expect(out.result).toEqual({ mode: 'shadow', organisations: 0, changed: 0 });
		expect(taskErrors(error)).toEqual([]);
	});

	it('collects usage instead of skipping as not installed', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const out = await scheduledRun(usage, { ENGINE: engine, COUNTS_SECRET: COUNTS });
		expect(out.result).toMatchObject({ checked: 0, written: 0, failed: [] });
		expect(taskErrors(error)).toEqual([]);
	});

	it('keeps the missing-secret reason when the engine binding or counts secret is absent', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const budgets = await scheduledRun(budget, {});
		expect(budgets.result).toEqual({
			skipped: 'the engine binding or the counts secret is missing'
		});
		resetBoot();
		const collected = await scheduledRun(usage, {});
		expect(collected.result).toEqual({
			skipped: 'the engine binding or the counts secret is missing'
		});
		expect(taskErrors(error)).toEqual([]);
	});

	it('logs one error line naming the task when no boot ran', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const context = { cloudflare: { env } };
		const budgets = await budget.run({ context });
		expect(budgets.result).toEqual({
			skipped: 'the services are not installed in this isolate yet'
		});
		const collected = await usage.run({ context });
		expect(collected.result).toEqual({
			skipped: 'the services are not installed in this isolate yet'
		});
		expect(taskErrors(error)).toEqual([
			'task budget-evaluate: the services are not installed after the boot hook ran',
			'task usage-collect: the services are not installed after the boot hook ran'
		]);
	});
});
