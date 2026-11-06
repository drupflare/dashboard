import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupServices } from '../../../../src/server/services/backups';
import {
	BootError,
	assertSingleShard,
	bootOnce,
	bootedServices,
	buildServices,
	mailFor,
	oauthConfig,
	resetBoot,
	webauthnConfig,
	type BootEnv
} from '../../../../src/server/services/boot';
import { consoleMailSender } from '../../../../src/server/services/email-codes';
import { factsLoader } from '../../../../src/server/services/facts';
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
				RELEASE_DRUPAL: 'v1.0.4'
			})
		);
		expect(siteServices().config).toEqual({
			hostSuffix: 'sites.example.net',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.4' }
		});
		resetBoot();
		expect(siteServices().config.accountId).toBeNull();
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

	it('keeps mail closed when an EMAIL binding exists, because the adapter is not built', async () => {
		const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		await expect(send(mailFor(envWith({ EMAIL: {} }), { dev: true }))).rejects.toMatchObject({
			code: 'not_built'
		});
		expect(log).not.toHaveBeenCalled();
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

	it('configures a provider only when all three of its values are set', () => {
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
		expect(Object.keys(config).sort()).toEqual(['github', 'gitlab', 'microsoft']);
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

	it('still refuses the platform scope', async () => {
		await expect(
			load({
				principal: { kind: 'user', userId: 'u1' },
				scope: 'admin',
				action: 'site.read',
				params: {}
			})
		).rejects.toMatchObject({ code: 'not_built' });
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
