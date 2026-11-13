import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUTOVER_MISSING_CONTRACTS } from '../../../../engine/src/adapters/cutover-destination';
import { backupServices } from '../../../../src/server/services/backups';
import {
	BootError,
	assertSingleShard,
	bootOnce,
	bootedServices,
	buildServices,
	githubAppOf,
	mailFor,
	oauthConfig,
	resetBoot,
	turnstileSecretOf,
	webauthnConfig,
	type BootEnv
} from '../../../../src/server/services/boot';
import { capacityServices } from '../../../../src/server/services/capacity';
import { consoleMailSender } from '../../../../src/server/services/email-codes';
import { factsLoader } from '../../../../src/server/services/facts';
import { fleetServices } from '../../../../src/server/services/fleet';
import { cutoverServices } from '../../../../src/server/services/migration-cutover';
import { repoConnectionDeps } from '../../../../src/server/services/repo-connections';
import { importServices } from '../../../../src/server/services/site-import';
import { siteServices } from '../../../../src/server/services/sites';
import { authServices, stepUpAtOf } from '../../../../src/server/utils/auth';
import { ApiError } from '../../../../src/shared/errors';
import { useClock } from './auth-support';

const bindings = { KV: {}, BLOB: {}, DB: { prepare: () => ({}) } };
const envWith = (extra: Record<string, unknown> = {}) =>
	({ ...bindings, ...extra }) as unknown as BootEnv;

afterEach(() => {
	resetBoot();
	vi.restoreAllMocks();
});

describe('buildServices', () => {
	it('stops when the KV or the audit head bucket is not bound, so nothing falls back to memory', () => {
		expect(() => buildServices({ BLOB: {}, DB: {} } as never)).toThrow(BootError);
		expect(() => buildServices({ KV: {}, DB: {} } as never)).toThrow(/BLOB/);
	});

	it('builds one store per concern from the bindings, with the code secret closed by default', () => {
		const built = buildServices(envWith());
		expect(built.auth.codeSecret).toBe('');
		expect(built.auth.kv).toBe(bindings.KV);
		for (const store of [built.auth.once, built.auth.attempts, built.identity.store]) {
			expect(store).toBeDefined();
		}
		expect(Object.keys(built.api).sort()).toEqual([
			'access',
			'audit',
			'auditDenied',
			'idempotency',
			'load',
			'resolvePrincipal'
		]);
		expect(built.ownerTokens).toBeDefined();
		expect(built.heads).toBeDefined();
	});

	it('takes the code secret and the bot check secret from the environment', async () => {
		const calls: string[] = [];
		vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
			calls.push(String((init.body as URLSearchParams).get('secret')));
			return new Response(JSON.stringify({ success: true }));
		});
		const built = buildServices(envWith({ AUTH_CODE_SECRET: 'c', TURNSTILE_SECRET_KEY: 't' }));
		expect(built.auth.codeSecret).toBe('c');
		expect(await built.auth.turnstile('token', undefined)).toBe(true);
		expect(calls).toEqual(['t']);
		vi.unstubAllGlobals();
	});

	it('leaves the bot check closed without a secret', async () => {
		const built = buildServices(envWith());
		await expect(built.auth.turnstile('token', undefined)).rejects.toMatchObject({
			code: 'not_built'
		});
	});
});

describe('bootOnce', () => {
	it('installs the services the first time and ignores later calls, whatever the env', () => {
		const first = bootOnce(envWith({ AUTH_CODE_SECRET: 'one' }));
		const second = bootOnce(envWith({ AUTH_CODE_SECRET: 'two' }));
		expect(second).toBe(first);
		expect(bootedServices()).toBe(first);
		expect(authServices().codeSecret).toBe('one');
	});

	it('installs nothing when the build fails, so the routes stay closed', () => {
		expect(() => bootOnce({ KV: {} } as never)).toThrow(BootError);
		expect(() => authServices()).toThrow(ApiError);
		expect(() => bootedServices()).toThrow(ApiError);
	});

	it('forgets the install on reset', () => {
		bootOnce(envWith());
		resetBoot();
		expect(() => bootedServices()).toThrow(ApiError);
	});

	it('installs the site services from the env and takes them away on reset', () => {
		bootOnce(
			envWith({
				MANAGED_ACCOUNT_ID: 'a'.repeat(32),
				MANAGED_HOST_SUFFIX: 'sites.example.net',
				MANAGED_LABEL_SUFFIX: '-staging',
				RELEASE_DRUPAL: 'v1.0.4'
			})
		);
		expect(siteServices().config).toEqual({
			hostSuffix: 'sites.example.net',
			labelSuffix: '-staging',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.4' }
		});
		resetBoot();
		expect(siteServices().config.accountId).toBeNull();
	});

	it('reads Cloudflare only with the managed account id and a token, and takes the install away on reset', async () => {
		const account = 'a'.repeat(32);
		expect(buildServices(envWith()).capacity.reads).toBeNull();
		expect(buildServices(envWith({ MANAGED_ACCOUNT_ID: account })).capacity.reads).toBeNull();
		expect(buildServices(envWith({ CF_BILLING_TOKEN: 't' })).capacity.reads).toBeNull();
		const built = bootOnce(envWith({ MANAGED_ACCOUNT_ID: account, CF_BILLING_TOKEN: 't' }));
		expect(built.capacity.reads).not.toBeNull();
		expect(capacityServices().reads).toBe(built.capacity.reads);
		expect(capacityServices().getDb).toBe(built.capacity.getDb);
		resetBoot();
		expect(capacityServices().reads).toBeNull();
	});

	it('installs the fleet services with the link host and key from the env, and takes them away on reset', async () => {
		const key = 'r2EXtK8adXShcS1LcXu6-pg-dlzFrrSaWFSUBElQY2s';
		const built = bootOnce(
			envWith({ FLEET_LINK_ORIGIN: 'wss://link.example/ignored', FLEET_PUBLIC_KEY: key }),
			{ baseUrl: 'https://app.example' }
		);
		expect(fleetServices()).toMatchObject({
			getDb: built.fleet.getDb,
			baseUrl: 'https://app.example',
			linkOrigin: 'wss://link.example',
			dashboardPublicKey: key
		});
		resetBoot();
		expect(fleetServices().linkOrigin).toBeNull();
		await expect(fleetServices().getDb()).rejects.toMatchObject({ code: 'not_built' });
	});

	it('installs the import services and takes them away on reset', async () => {
		const built = bootOnce(envWith({}));
		expect(importServices().audit).toBe(built.imports.audit);
		expect(importServices().probe).toBe(built.imports.probe);
		resetBoot();
		await expect(importServices().ring()).rejects.toMatchObject({ code: 'not_built' });
		await expect(importServices().probe({ host: 'a.example', port: 22 })).rejects.toMatchObject(
			{
				code: 'not_built'
			}
		);
	});

	it('installs the backup services from the bindings and takes them away on reset', async () => {
		const built = bootOnce(envWith({}));
		expect(backupServices().getDb).toBe(built.backups.getDb);
		resetBoot();
		await expect(backupServices().startOperation({} as never)).rejects.toMatchObject({
			code: 'not_built'
		});
	});
});

describe('cutover services', () => {
	it('stay closed while the new site lacks a worker route the move needs', () => {
		bootOnce(envWith({}));
		expect(CUTOVER_MISSING_CONTRACTS.length).toBeGreaterThan(0);
		expect(cutoverServices().adaptersBuilt).toBe(false);
	});
});

describe('repository connections', () => {
	const app = {
		NUXT_PUBLIC_GITHUB_APP_ID: '5738550',
		NUXT_PUBLIC_GITHUB_APP_CLIENT_ID: 'Iv-client',
		NUXT_GITHUB_APP_PRIVATE_KEY:
			'-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
		NUXT_GITHUB_APP_CLIENT_SECRET: 'client-secret',
		NUXT_GITHUB_APP_WEBHOOK_SECRET: 'hook-secret'
	};

	it('installs the deps on boot and takes them away on reset', () => {
		const built = bootOnce(envWith(app));
		expect(repoConnectionDeps()).toBe(built.repoConnections);
		resetBoot();
		expect(() => repoConnectionDeps()).toThrow(expect.objectContaining({ code: 'not_built' }));
	});

	it('reads the app from the Worker secrets and the public ids, with the slug defaulting', () => {
		const github = buildServices(envWith(app)).repoConnections.github;
		expect(github).toEqual({
			appId: '5738550',
			clientId: 'Iv-client',
			slug: 'drupflare',
			privateKey: app.NUXT_GITHUB_APP_PRIVATE_KEY,
			clientSecret: 'client-secret',
			webhookSecret: 'hook-secret'
		});
	});

	it('takes the ids and secrets from the runtime config when the Worker has none', () => {
		const github = githubAppOf(envWith(), {
			appId: '1',
			clientId: 'c',
			slug: 'other',
			privateKey: 'k',
			clientSecret: 's',
			webhookSecret: 'w'
		});
		expect(github).toEqual({
			appId: '1',
			clientId: 'c',
			slug: 'other',
			privateKey: 'k',
			clientSecret: 's',
			webhookSecret: 'w'
		});
		const mixed = githubAppOf(envWith({ NUXT_GITHUB_APP_WEBHOOK_SECRET: 'from-secret' }), {
			appId: '1',
			clientId: 'c',
			privateKey: 'k',
			clientSecret: 's',
			webhookSecret: 'from-config'
		});
		expect(mixed?.webhookSecret).toBe('from-secret');
	});

	it('leaves the app out when any of its six values is missing or empty, and keeps the rest', () => {
		for (const name of Object.keys(app)) {
			const github = githubAppOf(envWith({ ...app, [name]: '' }));
			expect(github, name).toBeNull();
		}
		const built = buildServices(envWith());
		expect(built.repoConnections.github).toBeNull();
		expect(built.repoConnections.gitlab).toBeNull();
		expect(built.repoConnections.store).toBeDefined();
	});

	it('turns a one-line PEM back into lines', () => {
		const github = githubAppOf(envWith({ ...app, NUXT_GITHUB_APP_PRIVATE_KEY: 'a\\nb\\nc' }));
		expect(github?.privateKey).toBe('a\nb\nc');
	});

	it('answers 501 for a credential until a KEK_V<n> secret is set', async () => {
		const closed = buildServices(envWith(app)).repoConnections;
		await expect(closed.ring()).rejects.toMatchObject({ code: 'not_built' });
		const key = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');
		const open = buildServices(envWith({ ...app, KEK_V1: key })).repoConnections;
		expect((await open.ring()).current).toBe(1);
	});

	it('starts a pull as a git.pull operation, so a missing site answers not found', async () => {
		const deps = buildServices(envWith(app)).repoConnections;
		expect(typeof deps.pullRemote).toBe('function');
		const remote = { organizationId: 'org_1', siteId: 'site_1', id: 'rem_1' } as never;
		await expect(deps.pullRemote(remote, { key: 'k' })).rejects.toBeDefined();
	});

	it('sends provider calls through the guard, so a private address is refused before a request', async () => {
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string) => {
			sent.push(url);
			return new Response('{}');
		});
		const deps = buildServices(envWith(app)).repoConnections;
		await expect(deps.fetch('http://api.github.com/user')).rejects.toThrow(/public https/);
		await expect(deps.fetch('https://127.0.0.1/user')).rejects.toThrow(/public https/);
		expect(sent).toEqual([]);
		vi.unstubAllGlobals();
	});
});

describe('the one-shard rule', () => {
	it('stops the build when more than one D1 shard is bound, naming them', () => {
		const error = (() => {
			try {
				buildServices(envWith({ DB_2: { prepare: () => ({}) } }));
			} catch (caught) {
				return caught;
			}
		})();
		expect(error).toBeInstanceOf(BootError);
		expect((error as BootError).message).toContain('DB, DB_2');
		expect(() => assertSingleShard(envWith())).not.toThrow();
		expect(() => assertSingleShard(envWith({ DB_2: {}, DB_3: {} }))).toThrow(/3 D1 shards/);
	});

	it('does not count other bindings as shards', () => {
		expect(() => assertSingleShard(envWith({ DB_ARCHIVE: {}, HOSTS_KV: {} }))).not.toThrow();
	});
});

describe('the pending secret key ring', () => {
	it('answers 501 until a KEK_V<n> secret is set, and loads once one is', async () => {
		const closed = buildServices(envWith());
		await expect(closed.pendingSecrets()).rejects.toMatchObject({ code: 'not_built' });
		const key = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');
		const open = buildServices(envWith({ KEK_V1: key }));
		const deps = await open.pendingSecrets();
		expect(deps.ring.current).toBe(1);
		expect(typeof deps.now()).toBe('number');
	});

	it('keeps a malformed key a typed crypto error, not a missing feature', async () => {
		const built = buildServices(envWith({ KEK_V1: 'short' }));
		await expect(built.pendingSecrets()).rejects.toMatchObject({ code: 'bad_key' });
	});
});

describe('turnstileSecretOf', () => {
	it('reads the name the Turnstile module uses, so one .dev.vars line serves both', () => {
		expect(turnstileSecretOf(envWith({ NUXT_TURNSTILE_SECRET_KEY: 'from-module' }))).toBe(
			'from-module'
		);
	});

	it('prefers TURNSTILE_SECRET_KEY and treats an empty value as unset', () => {
		expect(
			turnstileSecretOf(
				envWith({ TURNSTILE_SECRET_KEY: 'plain', NUXT_TURNSTILE_SECRET_KEY: 'module' })
			)
		).toBe('plain');
		expect(turnstileSecretOf(envWith({ TURNSTILE_SECRET_KEY: '' }))).toBeUndefined();
	});
});

describe('mailFor', () => {
	const send = (sender: ReturnType<typeof mailFor>) =>
		sender.send('a@example.test', { kind: 'login-code', code: '123456', expiresInMinutes: 10 });

	it('prints codes only on a development server with no mail binding', async () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		await send(mailFor(envWith(), { dev: true }));
		expect(log).toHaveBeenCalledWith(expect.stringContaining('123456'));
	});

	it('keeps mail closed outside development, so production logs never hold a code', async () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		await expect(send(mailFor(envWith(), { dev: false }))).rejects.toMatchObject({
			code: 'not_built'
		});
		await expect(send(mailFor(envWith(), {}))).rejects.toMatchObject({ code: 'not_built' });
		expect(log).not.toHaveBeenCalled();
	});

	it('sends the code through a bound EMAIL and never prints it', async () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const sent: Record<string, unknown>[] = [];
		const EMAIL = { send: async (message: Record<string, unknown>) => void sent.push(message) };
		await send(mailFor(envWith({ EMAIL }), { dev: true }));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			to: 'a@example.test',
			from: { email: 'no-reply@drupflare.com', name: 'Drupflare' }
		});
		expect(String(sent[0]?.text)).toContain('123456');
		expect(log).not.toHaveBeenCalled();
	});

	it('sends from MAIL_FROM when it is set', async () => {
		const sent: Record<string, unknown>[] = [];
		const EMAIL = { send: async (message: Record<string, unknown>) => void sent.push(message) };
		await send(mailFor(envWith({ EMAIL, MAIL_FROM: 'codes@drupflare.app' }), {}));
		expect(sent[0]).toMatchObject({ from: { email: 'codes@drupflare.app' } });
	});

	it('marks a binding failure with a 5xx status as retryable', async () => {
		const EMAIL = {
			send: async () => {
				throw Object.assign(new Error('unavailable'), { status: 503 });
			}
		};
		await expect(send(mailFor(envWith({ EMAIL }), {}))).rejects.toMatchObject({
			name: 'MailDeliveryError',
			retryable: true
		});
	});

	it('treats an EMAIL value with no send function as no binding', async () => {
		await expect(send(mailFor(envWith({ EMAIL: {} }), {}))).rejects.toMatchObject({
			code: 'not_built'
		});
	});

	it('writes one line to the sink it is given', async () => {
		const lines: string[] = [];
		await send(consoleMailSender((line) => lines.push(line)));
		expect(lines).toEqual(['[dev mail] login-code to a@example.test: 123456 (10 min)']);
	});
});

describe('webauthnConfig and oauthConfig', () => {
	it('derives the relying party from the base url unless the environment names one', () => {
		expect(webauthnConfig(envWith(), 'https://app.example.test/x')).toEqual({
			rpId: 'app.example.test',
			rpName: 'Drupflare',
			origin: 'https://app.example.test'
		});
		expect(
			webauthnConfig(
				envWith({
					WEBAUTHN_RP_ID: 'example.test',
					WEBAUTHN_ORIGIN: 'https://id.example.test'
				}),
				'https://app.example.test'
			)
		).toMatchObject({ rpId: 'example.test', origin: 'https://id.example.test' });
	});

	it.each(['github', 'gitlab'] as const)(
		'configures %s from the crust names, with the redirect on /auth/callback',
		(provider) => {
			const name = provider.toUpperCase();
			const config = oauthConfig(
				envWith({
					[`NUXT_PUBLIC_${name}_CLIENT_ID`]: 'public-id',
					[`NUXT_${name}_CLIENT_SECRET`]: 's'
				}),
				'https://app.example.test'
			);
			expect(config[provider]).toEqual({
				clientId: 'public-id',
				clientSecret: 's',
				redirectUri: 'https://app.example.test/auth/callback'
			});
		}
	);

	it('takes the public client id from the runtime config when the worker has none', () => {
		const env = envWith({ NUXT_GITHUB_CLIENT_SECRET: 's' });
		expect(oauthConfig(env, undefined, { github: 'from-build' }).github?.clientId).toBe(
			'from-build'
		);
		expect(oauthConfig(env, undefined, { github: '' })).toEqual({});
	});

	it('leaves a provider out when its secret is missing', () => {
		expect(oauthConfig(envWith({ NUXT_PUBLIC_GITHUB_CLIENT_ID: 'id' }))).toEqual({});
	});

	it('configures a provider when its id and secret are set, and names the callback if none is', () => {
		const config = oauthConfig(
			envWith({
				OAUTH_GITHUB_CLIENT_ID: 'id',
				OAUTH_GITHUB_CLIENT_SECRET: 's',
				OAUTH_GITHUB_REDIRECT_URI: 'https://app.example.test/cb',
				OAUTH_GOOGLE_CLIENT_ID: 'id',
				OAUTH_GOOGLE_CLIENT_SECRET: 's',
				OAUTH_GITLAB_CLIENT_ID: 'id',
				OAUTH_GITLAB_CLIENT_SECRET: 's',
				OAUTH_GITLAB_REDIRECT_URI: 'https://app.example.test/cb',
				OAUTH_GITLAB_BASE_URL: 'https://git.example.test',
				OAUTH_MICROSOFT_CLIENT_ID: 'id',
				OAUTH_MICROSOFT_CLIENT_SECRET: 's',
				OAUTH_MICROSOFT_REDIRECT_URI: 'https://app.example.test/cb',
				OAUTH_MICROSOFT_TENANT: 'contoso'
			})
		);
		expect(Object.keys(config).sort()).toEqual(['github', 'gitlab', 'google', 'microsoft']);
		expect(config.google?.redirectUri).toBe('https://app.drupflare.com/auth/callback');
		expect(config.gitlab?.baseUrl).toBe('https://git.example.test');
		expect(config.microsoft?.tenant).toBe('contoso');
		expect(config.github).not.toHaveProperty('baseUrl');
	});
});

describe('factsLoader on the account and platform scopes', () => {
	const untouched = async (): Promise<never> => {
		throw new Error('the store is not read on these scopes');
	};
	const load = factsLoader({
		store: {
			organization: untouched,
			site: untouched,
			member: untouched,
			siteGrants: untouched,
			delegations: untouched
		}
	});
	const clock = useClock();

	afterEach(() => clock.stop());

	it('gives a signed-in user empty standing and the step-up time from the session', async () => {
		const loaded = await load({
			principal: { kind: 'user', userId: 'u1', sessionId: 's', stepUpAt: 5 } as never,
			scope: 'session',
			action: 'account.read',
			params: {}
		});
		expect(loaded?.resource).toEqual({});
		expect(loaded?.facts).toMatchObject({
			stepUpAt: 5,
			grants: [],
			delegations: [],
			flags: {}
		});
		expect(stepUpAtOf({ kind: 'user', userId: 'u1', stepUpAt: 5 } as never)).toBe(5);
	});

	it('gives the platform scope no standing without a role, and refuses a key there', async () => {
		const loaded = await load({
			principal: { kind: 'user', userId: 'u1' },
			scope: 'admin',
			action: 'admin.aggregates.read',
			params: {}
		});
		expect(loaded?.facts.platform).toBeUndefined();
		expect(
			await load({
				principal: { kind: 'key', keyId: 'k', issuerId: 'u1' },
				scope: 'admin',
				action: 'admin.aggregates.read',
				params: {}
			})
		).toBeNull();
	});

	it('finds nothing for a key that did not come through the resolver', async () => {
		const loaded = await load({
			principal: { kind: 'key', keyId: 'k', issuerId: 'u1' },
			scope: 'session',
			action: 'account.read',
			params: {}
		});
		expect(loaded).toBeNull();
	});
});
