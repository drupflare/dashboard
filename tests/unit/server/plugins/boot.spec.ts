import { createHooks } from 'hookable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../../../../src/server/plugins/boot';
import {
	bootedServices,
	bootOnce,
	isBooted,
	resetBoot,
	type BootEnv
} from '../../../../src/server/services/boot';

vi.mock('../../../../src/server/services/boot', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../../../src/server/services/boot')>();
	return { ...original, bootOnce: vi.fn(original.bootOnce) };
});

const runtimeConfig = vi.fn();

vi.mock('nitropack/runtime', () => ({
	defineNitroPlugin: (plugin: unknown) => plugin,
	useRuntimeConfig: (event?: unknown) => runtimeConfig(event)
}));

const bindings = { KV: {}, BLOB: {}, DB: { prepare: () => ({}) } };
const envWith = (extra: Record<string, unknown> = {}) =>
	({ ...bindings, ...extra }) as unknown as BootEnv;

const configOf = (baseUrl: string) => ({
	baseUrl,
	public: {
		githubClientId: 'gh-client',
		gitlabClientId: '',
		cloudflareClientId: '',
		githubAppId: '',
		githubAppClientId: '',
		githubAppSlug: 'drupflare'
	},
	githubApp: { privateKey: '', clientSecret: '', webhookSecret: '' },
	releaseHook: { secret: '' }
});

const APP = {
	NUXT_PUBLIC_GITHUB_APP_ID: '1',
	NUXT_PUBLIC_GITHUB_APP_CLIENT_ID: 'Iv1.abc',
	NUXT_GITHUB_APP_CLIENT_SECRET: 'client-secret',
	NUXT_GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
	NUXT_GITHUB_APP_PRIVATE_KEY: 'pem'
};

// the plugin registers on a real hook table, so the order the preset relies on is the real one
function load() {
	const hooks = createHooks();
	(plugin as unknown as (app: unknown) => void)({ hooks });
	const scheduled = (env: unknown) =>
		hooks.callHook('cloudflare:scheduled', { controller: {}, env, context: {} });
	const request = (env: unknown) =>
		hooks.callHook('request', { context: { cloudflare: env === undefined ? {} : { env } } });
	return { scheduled, request };
}

beforeEach(() => {
	runtimeConfig.mockReset();
	runtimeConfig.mockImplementation(() => configOf('https://stage.example.test'));
	vi.mocked(bootOnce).mockClear();
});

afterEach(() => {
	resetBoot();
	vi.restoreAllMocks();
});

describe('boot plugin, scheduled runs (regression: scheduled boots are covered)', () => {
	it('installs the services on a cloudflare:scheduled call that carries an env and no request', async () => {
		const { scheduled } = load();
		const env = envWith();
		await scheduled(env);
		expect(bootOnce).toHaveBeenCalledTimes(1);
		const [bootEnv, options] = vi.mocked(bootOnce).mock.calls[0]!;
		expect(bootEnv).toBe(env);
		expect(options).toMatchObject({
			baseUrl: 'https://stage.example.test',
			oauthClientIds: { github: 'gh-client' },
			githubApp: { slug: 'drupflare' },
			releaseHook: { secret: '' }
		});
		expect(isBooted()).toBe(true);
		expect(bootedServices().auth.kv).toBe(bindings.KV);
	});

	it('hands useRuntimeConfig an event with a nitro context, so the NUXT_ overrides apply', async () => {
		const { scheduled } = load();
		await scheduled(envWith());
		const event = runtimeConfig.mock.calls[0]![0] as { context: { nitro: object } };
		expect(event.context.nitro).toEqual({});
	});

	it('builds the options from the same config on both paths', async () => {
		const { scheduled, request } = load();
		await scheduled(envWith());
		const fromScheduled = vi.mocked(bootOnce).mock.calls[0]![1];
		resetBoot();
		vi.mocked(bootOnce).mockClear();
		await request(envWith());
		expect(vi.mocked(bootOnce).mock.calls[0]![1]).toEqual(fromScheduled);
	});

	it('does not boot twice for a second scheduled call or a later request', async () => {
		const { scheduled, request } = load();
		await scheduled(envWith());
		const first = bootedServices();
		await scheduled(envWith());
		expect(bootOnce).toHaveBeenCalledTimes(1);
		await request(envWith({ KV: { other: true } }));
		expect(bootedServices()).toBe(first);
	});

	it('leaves a scheduled boot in place for a request that follows, and the reverse', async () => {
		const { scheduled, request } = load();
		await request(envWith());
		const first = bootedServices();
		await scheduled(envWith());
		expect(bootOnce).toHaveBeenCalledTimes(1);
		expect(bootedServices()).toBe(first);
	});

	it('logs and does not throw when the scheduled call has no env', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { scheduled } = load();
		await expect(scheduled(undefined)).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(expect.stringContaining('no cloudflare env'));
		expect(bootOnce).not.toHaveBeenCalled();
		expect(isBooted()).toBe(false);
	});

	it('logs a failed scheduled boot and does not throw, leaving the services uninstalled', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { scheduled } = load();
		await expect(scheduled({ DB: {} })).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('boot failed on a scheduled run'),
			expect.anything()
		);
		expect(isBooted()).toBe(false);
	});

	it('fails closed the way a request does: the GitHub app stays off without its secrets', async () => {
		const { scheduled } = load();
		await scheduled(envWith());
		expect(bootedServices().repoConnections.github).toBeNull();
		resetBoot();
		await scheduled(envWith(APP));
		expect(bootedServices().repoConnections.github).toMatchObject({ appId: '1' });
	});

	it('runs before a task that starts one tick after the hook, as the preset starts tasks', async () => {
		const { scheduled } = load();
		const hook = scheduled(envWith());
		const seen = (async () => {
			await Promise.resolve();
			return isBooted();
		})();
		await hook;
		expect(await seen).toBe(true);
	});
});

describe('boot plugin, requests', () => {
	it('still boots from a request env and warns once when the request has none', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { request } = load();
		await request(undefined);
		await request(undefined);
		expect(warn).toHaveBeenCalledTimes(1);
		await request(envWith());
		expect(bootOnce).toHaveBeenCalledTimes(1);
		expect(isBooted()).toBe(true);
	});
});
