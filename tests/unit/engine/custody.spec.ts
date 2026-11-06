import type { D1Database } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromBase64Url, toBase64Url } from '../../../contracts/src/common';
import { custodyOf } from '../../../engine/src/adapters/custody';
import { siteOf } from '../../../engine/src/adapters/site';
import { ConfigError } from '../../../engine/src/config';
import {
	CustodyError,
	CustodySealError,
	readFirstRunSecrets,
	refuseSuppliedPassword
} from '../../../engine/src/custody';
import { PermanentError } from '../../../engine/src/step';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import type { Principal } from '../../../src/server/domain/authorize';
import {
	collegeOwnerTokenStore,
	collegePendingSecretStore,
	revealOwnerToken,
	revealPendingSecret,
	rewrapOwnerToken,
	rewrapPendingSecret,
	type CustodyDeps,
	type PendingSecretDeps
} from '../../../src/server/services/owner-tokens';
import { CryptoError, loadKeyRing, type KeyRing } from '../../../src/shared/custody/envelope';
import { ApiError } from '../../../src/shared/errors';
import {
	beginCreate,
	custodyRows,
	FAKE_ADMIN_PASSWORD,
	FAKE_OWNER_TOKEN,
	Killed,
	makeRunner,
	makeWorld,
	memoryD1,
	type Memo,
	type RunnerScript,
	type World
} from './fakes';

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
const TOKEN = 'owner-token-plain-0123456789abcdef';
const PASSWORD = 'admin-password-plain-0123456789';
const SITE = 'site_aaaaaaaa';
const user: Principal = { kind: 'user', userId: 'user_1' };

function flip(text: string, index: number): string {
	const bytes = fromBase64Url(text);
	bytes[index] = bytes[index]! ^ 1;
	return toBase64Url(bytes);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a failure');
}

// #region the secret scan

function base64Forms(secret: string): string[] {
	const forms: string[] = [];
	for (const pad of ['', 'x', 'xx']) {
		const standard = Buffer.from(pad + secret).toString('base64');
		// the characters that depend on the pad in front or on the bytes after are left out
		const skip = Math.ceil((pad.length * 4) / 3);
		for (const text of [standard, standard.replaceAll('+', '-').replaceAll('/', '_')]) {
			forms.push(text.slice(skip + 1, text.length - 4).replaceAll('=', ''));
		}
	}
	return forms;
}

function leaks(haystack: string, secret: string): string[] {
	const hex = Buffer.from(secret).toString('hex');
	const found: string[] = [];
	if (haystack.includes(secret)) found.push('plain');
	if (base64Forms(secret).some((form) => haystack.includes(form))) found.push('base64');
	if (haystack.includes(hex) || haystack.includes(hex.toUpperCase())) found.push('hex');
	return found;
}

describe('the scan itself', () => {
	it('finds a secret in plain, base64, base64url and hex form, at any offset in a longer text', () => {
		const secret = FAKE_OWNER_TOKEN;
		for (const pad of ['', 'x', 'xx', 'xxx']) {
			const standard = Buffer.from(`${pad}${secret}-tail-bytes`).toString('base64');
			expect(leaks(`before ${standard} after`, secret), pad).toContain('base64');
			const url = standard.replaceAll('+', '-').replaceAll('/', '_');
			expect(leaks(url, secret), pad).toContain('base64');
		}
		expect(leaks(`a ${secret} b`, secret)).toEqual(['plain']);
		expect(leaks(Buffer.from(secret).toString('hex'), secret)).toEqual(['hex']);
		expect(leaks(Buffer.from(secret).toString('hex').toUpperCase(), secret)).toEqual(['hex']);
	});

	it('finds nothing in text that merely resembles the secret', () => {
		expect(
			leaks('otk-Zq8mR4vN2xLw9HcT7pYs3KdA6eJb5UfH and pw-other', FAKE_OWNER_TOKEN)
		).toEqual([]);
		expect(leaks('', FAKE_OWNER_TOKEN)).toEqual([]);
	});
});

function dump(world: World): string {
	const tables = world.sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all()
		.map((row) => String(row.name));
	return JSON.stringify(
		tables.map((name) => [
			name,
			world.sqlite
				.prepare(`SELECT * FROM ${name}`)
				.all()
				.map((row) =>
					Object.fromEntries(
						Object.entries(row).map(([key, value]) => [
							key,
							typeof value === 'bigint' ? Number(value) : value
						])
					)
				)
		])
	);
}

function printable(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return `${value.name} ${value.message} ${value.stack ?? ''}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function memoText(memo: Memo): string {
	return JSON.stringify(
		[...memo].map(([name, saved]) => [name, saved.ok ? saved.value : printable(saved.reason)])
	);
}

// every place a run leaves a record: the saved step results, every table, the account, the
// authority and name stores, the operation, the workflow input and every printed line
async function artefacts(world: World, memo: Memo, logs: string[], extra: unknown[] = []) {
	const operation = await world.store.get(world.operationId);
	return {
		steps: memoText(memo),
		database: dump(world),
		account: world.cf.deep(),
		authority: JSON.stringify(world.authority.snapshot()),
		names: JSON.stringify(world.names.recordOf(world.input.subdomain)),
		operation: JSON.stringify(operation),
		input: JSON.stringify(world.input),
		logs: logs.join('\n'),
		extra: extra.map(printable).join('\n')
	};
}

function captureLogs(): string[] {
	const lines: string[] = [];
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			lines.push(args.map(printable).join(' '));
		});
	}
	return lines;
}

afterEach(() => vi.restoreAllMocks());

async function start(options: Parameters<typeof makeWorld>[0] = {}) {
	const world = await makeWorld(options);
	await beginCreate(world);
	return world;
}

function attempt(world: World, memo: Memo, script: RunnerScript = {}) {
	const { runner, executed } = makeRunner(memo, script);
	return { executed, done: runSiteCreate(runner, world.deps, world.input) };
}

async function expectNoSecrets(label: string, found: Record<string, string>) {
	for (const [place, text] of Object.entries(found)) {
		expect(leaks(text, FAKE_OWNER_TOKEN), `${label}: owner token in ${place}`).toEqual([]);
		expect(leaks(text, FAKE_ADMIN_PASSWORD), `${label}: password in ${place}`).toEqual([]);
	}
}

describe('no plaintext secret outside custody', () => {
	it('reaches every record of an uninterrupted create and finds nothing', async () => {
		const logs = captureLogs();
		const world = await start();
		const memo: Memo = new Map();
		const outcome = await attempt(world, memo).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		const found = await artefacts(world, memo, logs, [outcome]);
		// the scan reaches the sealed rows and the saved step results, so a clean result means something
		expect(found.database).toContain('\\"ct\\"');
		expect(found.steps).toContain('first-run');
		expect(world.site.bearers).toEqual([FAKE_OWNER_TOKEN]);
		await expectNoSecrets('create', found);
	});

	it('holds when the create is killed and resumed at every step', async () => {
		const logs = captureLogs();
		const reference = await start();
		const run = attempt(reference, new Map());
		await run.done;
		for (let k = 0; k < run.executed.length; k++) {
			for (const kind of ['killAfter', 'killDuring'] as const) {
				const world = await start();
				const memo: Memo = new Map();
				const script = kind === 'killAfter' ? { killAfter: k } : { killDuring: k + 1 };
				const killed = await failure(attempt(world, memo, script).done);
				expect(killed).toBeInstanceOf(Killed);
				const outcome = await attempt(world, memo).done;
				expect(outcome, `${kind} ${k}`).toEqual({ status: 'succeeded' });
				await expectNoSecrets(
					`${kind} ${k}`,
					await artefacts(world, memo, logs, [killed, outcome])
				);
			}
		}
	});

	it('holds when the create rolls back after the secrets were sealed', async () => {
		const logs = captureLogs();
		for (const step of ['first-run', 'verify', 'activate']) {
			for (const when of ['before', 'after'] as const) {
				const world = await start();
				const memo: Memo = new Map();
				const outcome = await attempt(world, memo, { failAt: { step, when } }).done;
				expect(outcome.status, `${step} ${when}`).toBe('rolled-back');
				expect(custodyRows(world), `${step} ${when}`).toEqual({
					ownerToken: false,
					pending: []
				});
				await expectNoSecrets(
					`${step} ${when}`,
					await artefacts(world, memo, logs, [outcome])
				);
			}
		}
	});

	it('holds when sealing fails with an error that quotes the secret', async () => {
		const logs = captureLogs();
		for (const method of ['sealOwnerToken', 'sealPendingSecret'] as const) {
			const world = await start();
			const real = world.deps.custody;
			world.deps.custody = {
				...real,
				[method]: async (_site: string, ...rest: unknown[]) => {
					throw new Error(
						`d1 refused ${rest.at(-1)} ${FAKE_ADMIN_PASSWORD} ${FAKE_OWNER_TOKEN}`
					);
				}
			};
			const memo: Memo = new Map();
			const outcome = await attempt(world, memo).done;
			expect(outcome.status, method).toBe('rolled-back');
			if (outcome.status !== 'rolled-back') return;
			expect(outcome.reason).toContain('could not be sealed');
			expect(custodyRows(world), method).toEqual({ ownerToken: false, pending: [] });
			await expectNoSecrets(method, await artefacts(world, memo, logs, [outcome]));
		}
	});

	it('holds when a run died between the two seals and the retry finds the site already claimed', async () => {
		const logs = captureLogs();
		const world = await start();
		// what the dead run left: the site claimed, the password sealed, no token
		const answer = await world.deps.site.firstRun(world.input.hostname, world.input.firstRun!);
		await world.deps.custody.sealPendingSecret(
			world.siteId,
			'admin-password',
			answer.secrets!.adminPassword!
		);
		expect(custodyRows(world)).toEqual({
			ownerToken: false,
			pending: [`${world.siteId}:admin-password`]
		});
		const memo: Memo = new Map();
		const outcome = await attempt(world, memo).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('answered 409');
		expect(custodyRows(world)).toEqual({ ownerToken: false, pending: [] });
		expect(world.site.calls.firstRun).toBe(2);
		await expectNoSecrets('between seals', await artefacts(world, memo, logs, [outcome]));
	});
});

// #endregion

describe('the first-run step', () => {
	it('returns ids and the status, and nothing else', async () => {
		const world = await start();
		const memo: Memo = new Map();
		await attempt(world, memo).done;
		const saved = memo.get('first-run');
		expect(saved).toEqual({
			ok: true,
			value: {
				status: 200,
				ownerTokenId: `owner-token:${world.siteId}`,
				pendingSecretId: `pending-secret:${world.siteId}:admin-password`
			}
		});
	});

	it('seals each secret once when killed inside the step and resumed', async () => {
		const world = await start();
		const real = world.deps.custody;
		const sealed: string[] = [];
		world.deps.custody = {
			...real,
			async sealOwnerToken(siteId, token) {
				sealed.push('owner-token');
				return real.sealOwnerToken(siteId, token);
			},
			async sealPendingSecret(siteId, kind, value) {
				sealed.push(kind);
				return real.sealPendingSecret(siteId, kind, value);
			}
		};
		const memo: Memo = new Map();
		const reference = attempt(await start(), new Map());
		await reference.done;
		const index = reference.executed.indexOf('first-run') + 1;
		await failure(attempt(world, memo, { killDuring: index }).done);
		const outcome = await attempt(world, memo).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(sealed).toEqual(['admin-password', 'owner-token']);
		expect(world.site.calls.firstRun).toBe(1);
		expect(memo.get('first-run')).toMatchObject({
			ok: true,
			value: { status: null, ownerTokenId: `owner-token:${world.siteId}` }
		});
	});

	it('probes with the owner token only when the probe asks for it', async () => {
		const world = await start();
		world.input.probe = { path: '/health', expectStatus: 200 };
		await attempt(world, new Map()).done;
		expect(world.site.bearers).toEqual([null]);
	});

	it('creates a site with no first-run call and seals nothing', async () => {
		const world = await makeWorld();
		world.input.firstRun = undefined;
		world.input.probe = undefined;
		await beginCreate(world);
		const outcome = await attempt(world, new Map()).done;
		expect(outcome).toEqual({ status: 'succeeded' });
		expect(custodyRows(world)).toEqual({ ownerToken: false, pending: [] });
		expect(world.site.calls.firstRun).toBe(0);
	});

	it('refuses a probe that needs a token when nothing was sealed', async () => {
		const world = await makeWorld();
		world.input.firstRun = undefined;
		await beginCreate(world);
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('probe_needs_owner_token');
	});

	it('rolls back when the response carries no owner token, naming the typed error', async () => {
		const world = await start();
		world.deps.site = {
			...world.deps.site,
			firstRun: async () => ({
				status: 200,
				secrets: { ownerToken: null, adminPassword: FAKE_ADMIN_PASSWORD }
			})
		};
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('first_run_no_owner_token');
		expect(leaks(outcome.reason, FAKE_ADMIN_PASSWORD)).toEqual([]);
		expect(custodyRows(world)).toEqual({ ownerToken: false, pending: [] });
	});

	it('keeps no pending secret when the site returns no password', async () => {
		const world = await start();
		world.deps.site = {
			...world.deps.site,
			firstRun: async () => ({
				status: 200,
				secrets: { ownerToken: FAKE_OWNER_TOKEN, adminPassword: null }
			})
		};
		const memo: Memo = new Map();
		expect(await attempt(world, memo).done).toEqual({ status: 'succeeded' });
		expect(memo.get('first-run')).toMatchObject({ value: { pendingSecretId: null } });
		expect(custodyRows(world)).toEqual({ ownerToken: true, pending: [] });
	});

	it('refuses a call that carries an admin password and does not repeat it', async () => {
		const world = await start();
		const supplied = 'supplied-by-the-caller-9876';
		world.input.firstRun = {
			...world.input.firstRun!,
			body: JSON.stringify({ siteName: 'Quiet', adminPass: supplied })
		};
		const outcome = await attempt(world, new Map()).done;
		expect(outcome.status).toBe('rolled-back');
		if (outcome.status !== 'rolled-back') return;
		expect(outcome.reason).toContain('first_run_password_supplied');
		expect(outcome.reason).not.toContain(supplied);
		expect(world.site.calls.firstRun).toBe(0);
	});
});

describe('refuseSuppliedPassword and readFirstRunSecrets', () => {
	const reads = { ownerToken: 'ownerToken', adminPassword: 'adminPass' };

	it('lets a body without the password field through, whatever else it holds', () => {
		expect(() => refuseSuppliedPassword(undefined, reads)).not.toThrow();
		expect(() => refuseSuppliedPassword('{"siteName":"x"}', reads)).not.toThrow();
		expect(() => refuseSuppliedPassword('not json', reads)).not.toThrow();
		expect(() => refuseSuppliedPassword('"text"', reads)).not.toThrow();
		expect(() =>
			refuseSuppliedPassword('{"adminPass":"x"}', { ownerToken: 'o' })
		).not.toThrow();
	});

	it('refuses the field even when its value is empty', () => {
		for (const body of ['{"adminPass":"x"}', '{"adminPass":""}', '{"adminPass":null}']) {
			expect(() => refuseSuppliedPassword(body, reads)).toThrow(PermanentError);
		}
	});

	it('reads the two named fields and nothing else', () => {
		expect(
			readFirstRunSecrets('{"ownerToken":"t","adminPass":"p","other":"o"}', reads)
		).toEqual({ ownerToken: 't', adminPassword: 'p' });
		expect(
			readFirstRunSecrets('{"ownerToken":"t","adminPass":"p"}', { ownerToken: 'ownerToken' })
		).toEqual({
			ownerToken: 't',
			adminPassword: null
		});
		expect(readFirstRunSecrets('{}', reads)).toEqual({ ownerToken: null, adminPassword: null });
		expect(readFirstRunSecrets('{"ownerToken":null}', reads).ownerToken).toBeNull();
	});

	it('names an unreadable response without quoting any of it', () => {
		const quoted = 'secret-body-text-zzz';
		for (const text of [
			`{"ownerToken":"${quoted}"`,
			`["${quoted}"]`,
			`"${quoted}"`,
			`{"ownerToken":["${quoted}"]}`,
			`{"ownerToken":"${'x'.repeat(5000)}"}`,
			'{"adminPass":""}'
		]) {
			let error: unknown;
			try {
				readFirstRunSecrets(text, reads);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(PermanentError);
			expect((error as PermanentError).code).toBe('first_run_response_unreadable');
			expect((error as PermanentError).message).not.toContain(quoted);
		}
	});
});

describe('the site adapter and secrets', () => {
	const make = () => {
		const answer = {
			status: 200,
			body: undefined as string | undefined,
			calls: [] as string[],
			authorizations: [] as (string | null)[]
		};
		const fetcher = (async (input: string | URL, init: RequestInit) => {
			answer.calls.push(`${init.method} ${String(input)}`);
			answer.authorizations.push(new Headers(init.headers).get('authorization'));
			return new Response(answer.body ?? null, { status: answer.status });
		}) as unknown as typeof fetch;
		return { answer, site: siteOf(fetcher, 1_000) };
	};
	const call = {
		method: 'POST',
		path: '/firstrun',
		reads: { ownerToken: 'ownerToken' }
	} as const;

	it('returns the named fields of an accepted first-run response', async () => {
		const { answer, site } = make();
		answer.body = JSON.stringify({ ownerToken: 'tok', adminPass: 'pw', applied: true });
		expect(await site.firstRun('a.example.com', call)).toEqual({
			status: 200,
			secrets: { ownerToken: 'tok', adminPassword: null }
		});
	});

	it('leaves the body unread when the call names no fields, or the status was not wanted', async () => {
		const { answer, site } = make();
		answer.body = JSON.stringify({ ownerToken: 'tok' });
		expect(await site.firstRun('a.example.com', { method: 'POST', path: '/firstrun' })).toEqual(
			{
				status: 200
			}
		);
		answer.status = 409;
		const refused = await failure(site.firstRun('a.example.com', call));
		expect(refused).toBeInstanceOf(PermanentError);
		expect((refused as PermanentError).code).toBe('site_rejected');
		expect(refused.message).not.toContain('tok');
	});

	it('fails with the typed error for a body that is not json, without quoting it', async () => {
		const { answer, site } = make();
		answer.body = 'ownerToken=tok-in-a-form-body';
		const error = await failure(site.firstRun('a.example.com', call));
		expect((error as PermanentError).code).toBe('first_run_response_unreadable');
		expect(error.message).not.toContain('tok-in-a-form-body');
	});

	it('sends the bearer token on a probe that has one, and no authorization otherwise', async () => {
		const { answer, site } = make();
		await site.probe('a.example.com', '/health', 200, { bearer: 'tok' });
		await site.probe('a.example.com', '/health', 200);
		await site.firstRun('a.example.com', call).catch(() => undefined);
		expect(answer.authorizations).toEqual(['Bearer tok', null, null]);
		expect(answer.calls.every((line) => !line.includes('tok'))).toBe(true);
	});
});

// #region the custody adapter

function setup(secrets: Record<string, string | undefined> = { KEK_V1: kek(1) }) {
	const { db, sqlite } = memoryD1();
	let clock = 1_000;
	const custody = custodyOf({ db, secrets, pendingTtlMs: 500, now: () => clock });
	return {
		db,
		sqlite,
		custody,
		secrets,
		advance: (ms: number) => void (clock += ms),
		rows: (table: string) => sqlite.prepare(`SELECT * FROM ${table}`).all()
	};
}

describe('custodyOf', () => {
	it('seals both secrets and answers with ids that carry none of them', async () => {
		const { custody, sqlite } = setup();
		const pendingId = await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		const tokenId = await custody.sealOwnerToken(SITE, TOKEN);
		expect(pendingId).toBe(`pending-secret:${SITE}:admin-password`);
		expect(tokenId).toBe(`owner-token:${SITE}`);
		for (const id of [pendingId, tokenId]) {
			expect(leaks(id, TOKEN)).toEqual([]);
			expect(leaks(id, PASSWORD)).toEqual([]);
		}
		const everything = JSON.stringify([
			sqlite.prepare('SELECT * FROM owner_tokens').all(),
			sqlite.prepare('SELECT * FROM pending_secrets').all()
		]);
		expect(leaks(everything, TOKEN)).toEqual([]);
		expect(leaks(everything, PASSWORD)).toEqual([]);
		expect(await custody.sealed(SITE)).toEqual({
			ownerTokenId: tokenId,
			pendingSecretId: pendingId
		});
	});

	it('reports nothing sealed for a site that has nothing', async () => {
		const { custody } = setup();
		expect(await custody.sealed(SITE)).toEqual({ ownerTokenId: null, pendingSecretId: null });
	});

	it('stores the key version and an expiry the configured window after the seal', async () => {
		const { custody, rows } = setup({ KEK_V1: kek(1), KEK_V3: kek(3) });
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		expect(rows('pending_secrets')).toEqual([
			expect.objectContaining({
				site_id: SITE,
				kind: 'admin-password',
				key_version: 3,
				created_at: 1_000,
				expires_at: 1_500,
				revealed_at: null
			})
		]);
	});

	it('opens the owner token for its own id only, and hands it to the callback alone', async () => {
		const { custody } = setup();
		const id = await custody.sealOwnerToken(SITE, TOKEN);
		expect(await custody.withOwnerToken(SITE, id, async (token) => token.length)).toBe(
			TOKEN.length
		);
		const other = await failure(
			custody.withOwnerToken(SITE, `owner-token:site_other`, async () => 1)
		);
		expect(other).toBeInstanceOf(CustodyError);
		expect((other as CustodyError).code).toBe('custody_unknown_id');
		expect(other.message).not.toContain(TOKEN);
	});

	it('names a site with no sealed owner token', async () => {
		const { custody } = setup();
		const error = await failure(
			custody.withOwnerToken(SITE, `owner-token:${SITE}`, async () => 1)
		);
		expect((error as CustodyError).code).toBe('custody_not_sealed');
	});

	it('refuses a stored record that is not an envelope', async () => {
		const { custody, sqlite } = setup();
		const id = await custody.sealOwnerToken(SITE, TOKEN);
		sqlite.prepare('UPDATE owner_tokens SET current_envelope = ?').run('not json');
		const error = await failure(custody.withOwnerToken(SITE, id, async () => 1));
		expect((error as CustodyError).code).toBe('custody_bad_record');
	});

	it('refuses a tampered ciphertext, a wrong key and a retired key version with typed errors', async () => {
		const { custody, sqlite, db } = setup();
		const id = await custody.sealOwnerToken(SITE, TOKEN);
		const row = sqlite.prepare('SELECT current_envelope FROM owner_tokens').get() as {
			current_envelope: string;
		};
		const envelope = JSON.parse(row.current_envelope) as { ct: string };
		sqlite
			.prepare('UPDATE owner_tokens SET current_envelope = ?')
			.run(JSON.stringify({ ...envelope, ct: flip(envelope.ct, 0) }));
		const tampered = await failure(custody.withOwnerToken(SITE, id, async () => 1));
		expect((tampered as CryptoError).code).toBe('decrypt_failed');
		sqlite.prepare('UPDATE owner_tokens SET current_envelope = ?').run(row.current_envelope);
		const wrongKey = custodyOf({
			db,
			secrets: { KEK_V1: kek(9) },
			pendingTtlMs: 500,
			now: () => 0
		});
		expect(
			((await failure(wrongKey.withOwnerToken(SITE, id, async () => 1))) as CryptoError).code
		).toBe('decrypt_failed');
		const retired = custodyOf({
			db,
			secrets: { KEK_V2: kek(2) },
			pendingTtlMs: 500,
			now: () => 0
		});
		expect(
			((await failure(retired.withOwnerToken(SITE, id, async () => 1))) as CryptoError).code
		).toBe('key_version_missing');
	});

	it('names a missing key ring and loads it again once a key appears', async () => {
		const secrets: Record<string, string | undefined> = {};
		const { custody } = setup(secrets);
		const first = await failure(custody.sealOwnerToken(SITE, TOKEN));
		expect((first as CryptoError).code).toBe('no_keys');
		expect(first.message).not.toContain(TOKEN);
		secrets.KEK_V1 = kek(1);
		expect(await custody.sealOwnerToken(SITE, TOKEN)).toBe(`owner-token:${SITE}`);
	});

	it('lets a fresh seal replace an older one and bumps the version', async () => {
		const { custody, rows } = setup();
		await custody.sealOwnerToken(SITE, TOKEN);
		const id = await custody.sealOwnerToken(SITE, `${TOKEN}-second`);
		expect(await custody.withOwnerToken(SITE, id, async (token) => token)).toBe(
			`${TOKEN}-second`
		);
		expect(rows('owner_tokens')).toEqual([expect.objectContaining({ version: 2 })]);
	});

	it('names a conflict when the row changed between the read and the write', async () => {
		const { custody, db } = setup();
		await custody.sealOwnerToken(SITE, TOKEN);
		const racing = custodyOf({
			db: {
				...db,
				prepare: (sql: string) =>
					sql.startsWith('SELECT version, current_envelope')
						? { bind: () => ({ first: async () => ({ version: 99 }) }) }
						: db.prepare(sql)
			} as unknown as D1Database,
			secrets: { KEK_V1: kek(1) },
			pendingTtlMs: 500,
			now: () => 0
		});
		const error = await failure(racing.sealOwnerToken(SITE, TOKEN));
		expect(error).toBeInstanceOf(CustodyError);
		expect((error as CustodyError).code).toBe('custody_conflict');
	});

	it('discards the pending secret alone, or both secrets, and only for that site', async () => {
		const { custody } = setup();
		for (const site of [SITE, 'site_bbbbbbbb']) {
			await custody.sealPendingSecret(site, 'admin-password', PASSWORD);
			await custody.sealOwnerToken(site, TOKEN);
		}
		await custody.discardPending(SITE);
		expect(await custody.sealed(SITE)).toMatchObject({ pendingSecretId: null });
		expect((await custody.sealed(SITE)).ownerTokenId).not.toBeNull();
		await custody.discard(SITE);
		expect(await custody.sealed(SITE)).toEqual({ ownerTokenId: null, pendingSecretId: null });
		expect((await custody.sealed('site_bbbbbbbb')).ownerTokenId).not.toBeNull();
		await custody.discard(SITE);
	});

	it('refuses a window that is not a positive whole number', () => {
		const { db } = memoryD1();
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => custodyOf({ db, secrets: {}, pendingTtlMs: bad, now: () => 0 })).toThrow(
				ConfigError
			);
		}
	});

	it('has an error type that carries only its fixed text', () => {
		const error = new CustodySealError('the owner token');
		expect(error.message).toBe('the owner token could not be sealed');
		expect(error).not.toBeInstanceOf(PermanentError);
		expect(error.cause).toBeUndefined();
	});
});

// #endregion

// #region engine seals, dashboard reads

// the dashboard's client over the same in-memory database the engine wrote to
function dashboardClient(db: D1Database): CollegeDBClient {
	const statement = (sql: string, params: unknown[] = []) => db.prepare(sql).bind(...params);
	return {
		first: async (_key: string, sql: string, params?: unknown[]) =>
			statement(sql, params).first(),
		run: async (_key: string, sql: string, params?: unknown[]) => statement(sql, params).run(),
		all: async (_key: string, sql: string, params?: unknown[]) => statement(sql, params).all()
	} as unknown as CollegeDBClient;
}

function dashboard(db: D1Database, ring: KeyRing, now = () => 1_100) {
	const getDb = async () => dashboardClient(db);
	const audit: { action: string; detail: unknown }[] = [];
	const sink = {
		async append(input: { action: string; detail: unknown }) {
			audit.push({ action: input.action, detail: input.detail });
		}
	};
	const custodyDeps: CustodyDeps = {
		store: collegeOwnerTokenStore(getDb),
		audit: sink as CustodyDeps['audit'],
		ring
	};
	const pendingDeps: PendingSecretDeps = {
		store: {
			...collegePendingSecretStore(getDb),
			siteInOrganization: async () => true
		},
		audit: sink as PendingSecretDeps['audit'],
		ring,
		now
	};
	return { custodyDeps, pendingDeps, audit };
}

const session = { siteId: SITE, principal: user, stepUp: true };

describe('what the engine seals the dashboard reads', () => {
	it('reveals the owner token the engine sealed', async () => {
		const { custody, db } = setup();
		await custody.sealOwnerToken(SITE, TOKEN);
		const { custodyDeps, audit } = dashboard(db, await loadKeyRing({ KEK_V1: kek(1) }));
		expect(await revealOwnerToken(custodyDeps, session)).toBe(TOKEN);
		expect(audit.map((row) => row.action)).toEqual(['site.owner-token.reveal']);
		expect(leaks(JSON.stringify(audit), TOKEN)).toEqual([]);
	});

	it('reveals the pending password once, then answers not found', async () => {
		const { custody, db } = setup();
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		const { pendingDeps } = dashboard(db, await loadKeyRing({ KEK_V1: kek(1) }));
		const call = {
			orgId: 'org_1',
			siteId: SITE,
			kind: 'admin-password' as const,
			principal: user
		};
		expect(await revealPendingSecret(pendingDeps, call)).toBe(PASSWORD);
		const again = await failure(revealPendingSecret(pendingDeps, call));
		expect(again).toBeInstanceOf(ApiError);
		expect((again as ApiError).code).toBe('not_found');
	});

	it('wipes the ciphertext when the password is revealed', async () => {
		const { custody, db, rows } = setup();
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		const { pendingDeps } = dashboard(db, await loadKeyRing({ KEK_V1: kek(1) }));
		await revealPendingSecret(pendingDeps, {
			orgId: 'org_1',
			siteId: SITE,
			kind: 'admin-password',
			principal: user
		});
		expect(rows('pending_secrets')).toEqual([
			expect.objectContaining({ ciphertext: '', revealed_at: 1_100 })
		]);
		expect(await custody.sealed(SITE)).toMatchObject({ pendingSecretId: expect.any(String) });
	});

	it('keeps both secrets readable by both sides after a key rotation by re-wrap', async () => {
		const { custody, db } = setup({ KEK_V1: kek(1) });
		await custody.sealOwnerToken(SITE, TOKEN);
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const { custodyDeps, pendingDeps } = dashboard(db, both);
		expect(await rewrapOwnerToken(custodyDeps, { siteId: SITE, actor: 'system:rotate' })).toBe(
			true
		);
		expect(
			await rewrapPendingSecret(pendingDeps, {
				siteId: SITE,
				kind: 'admin-password',
				actor: 'system:rotate'
			})
		).toBe(true);
		const rotated = custodyOf({
			db,
			secrets: { KEK_V2: kek(2) },
			pendingTtlMs: 500,
			now: () => 1_100
		});
		expect(
			await rotated.withOwnerToken(SITE, `owner-token:${SITE}`, async (token) => token)
		).toBe(TOKEN);
		const retired = dashboard(db, await loadKeyRing({ KEK_V2: kek(2) }));
		expect(await revealOwnerToken(retired.custodyDeps, session)).toBe(TOKEN);
		expect(
			await revealPendingSecret(retired.pendingDeps, {
				orgId: 'org_1',
				siteId: SITE,
				kind: 'admin-password',
				principal: user
			})
		).toBe(PASSWORD);
	});

	it('moves nothing when the secret is on the newest key, expired, read or absent', async () => {
		const { custody, db } = setup({ KEK_V1: kek(1) });
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		const call = { siteId: SITE, kind: 'admin-password' as const, actor: 'system:rotate' };
		const one = await loadKeyRing({ KEK_V1: kek(1) });
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		expect(await rewrapPendingSecret(dashboard(db, one).pendingDeps, call)).toBe(false);
		expect(await rewrapPendingSecret(dashboard(db, both, () => 2_000).pendingDeps, call)).toBe(
			false
		);
		const { pendingDeps } = dashboard(db, both);
		await revealPendingSecret(pendingDeps, {
			orgId: 'org_1',
			siteId: SITE,
			kind: 'admin-password',
			principal: user
		});
		expect(await rewrapPendingSecret(pendingDeps, call)).toBe(false);
		expect(await rewrapPendingSecret(pendingDeps, { ...call, siteId: 'site_none0000' })).toBe(
			false
		);
	});

	it('names a stored pending record that is not an envelope', async () => {
		const { custody, db, sqlite } = setup();
		await custody.sealPendingSecret(SITE, 'admin-password', PASSWORD);
		sqlite.prepare('UPDATE pending_secrets SET ciphertext = ?').run('not json');
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const { pendingDeps } = dashboard(db, both);
		const call = {
			orgId: 'org_1',
			siteId: SITE,
			kind: 'admin-password' as const,
			principal: user
		};
		expect(((await failure(revealPendingSecret(pendingDeps, call))) as CryptoError).code).toBe(
			'bad_record'
		);
		expect(
			(
				(await failure(
					rewrapPendingSecret(pendingDeps, {
						siteId: SITE,
						kind: 'admin-password',
						actor: 'system:rotate'
					})
				)) as CryptoError
			).code
		).toBe('bad_record');
	});
});

// #endregion
