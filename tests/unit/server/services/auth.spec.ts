import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stepUpFresh } from '../../../../src/server/domain/authorize';
import { generateApiKey } from '../../../../src/server/services/api-keys';
import { requestCode, stepUp, stepUpUntil, verifyCode } from '../../../../src/server/services/auth';
import { CODE_RESEND_COOLDOWN_MS, CODE_TTL_MS } from '../../../../src/server/services/email-codes';
import {
	SESSION_COOKIE_NAME,
	SESSION_IDLE_MS,
	createSession,
	getSession,
	hashSessionToken,
	revokeSession
} from '../../../../src/server/services/sessions';
import {
	authServices,
	createPrincipalResolver,
	kvKeyIndex,
	productionServices,
	resolveCredential,
	setAuthServices,
	siteverifyTurnstile,
	stepUpAtOf,
	type AuthServices
} from '../../../../src/server/utils/auth';
import { ApiError } from '../../../../src/shared/errors';
import { STEP_UP_WINDOW_MS } from '../../../../src/shared/permissions';
import { facts } from '../../domain/fixtures';
import { harness, useClock, type Harness } from './auth-support';

let clock: ReturnType<typeof useClock>;
beforeEach(() => {
	clock = useClock();
});
afterEach(() => {
	clock.stop();
	setAuthServices(null);
	vi.restoreAllMocks();
});

async function thrown(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		return error as ApiError;
	}
	throw new Error('expected a rejection');
}

// request a code for the address and return the code the fake mailbox received
async function codeFor(h: Harness, email: string): Promise<string> {
	await requestCode(h, { email });
	return h.mail.lastCode();
}

async function signIn(h: Harness, email = 'ada@example.com') {
	const result = await verifyCode(h, { email, code: await codeFor(h, email) });
	clock.advance(CODE_RESEND_COOLDOWN_MS);
	return result;
}

describe('requestCode', () => {
	it('checks the bot challenge first and passes the token and address through', async () => {
		const h = harness();
		await requestCode(h, {
			email: 'ada@example.com',
			turnstileToken: 'tok',
			ip: '203.0.113.5'
		});
		expect(h.turnstileCalls).toEqual([{ token: 'tok', ip: '203.0.113.5' }]);
		expect(h.mail.sent).toHaveLength(1);
	});

	it('sends nothing and stores nothing when the bot challenge fails', async () => {
		const h = harness();
		h.passTurnstile = false;
		const error = await thrown(requestCode(h, { email: 'ada@example.com' }));
		expect(error.code).toBe('forbidden');
		expect(error.details).toEqual({ requires: 'challenge' });
		expect(h.mail.sent).toEqual([]);
		expect(h.kv.keys()).toEqual([]);
	});

	it('turns a cooldown into a rate_limited error with a wait', async () => {
		const h = harness();
		await requestCode(h, { email: 'ada@example.com' });
		const error = await thrown(requestCode(h, { email: 'ada@example.com' }));
		expect(error.code).toBe('rate_limited');
		expect(error.details).toEqual({ retryAfterSeconds: CODE_RESEND_COOLDOWN_MS / 1000 });
	});

	it('treats a known address and an unknown one the same', async () => {
		const h = harness();
		await signIn(h, 'known@example.com');
		const before = h.directory.users.length;
		await requestCode(h, { email: 'known@example.com' });
		await requestCode(h, { email: 'unknown@example.com' });
		expect(h.mail.sent.slice(-2).map((m) => m.template.kind)).toEqual([
			'login-code',
			'login-code'
		]);
		expect(h.directory.users).toHaveLength(before);
	});

	it('refuses to run without a code secret', async () => {
		const h = harness();
		h.codeSecret = '';
		const error = await thrown(requestCode(h, { email: 'ada@example.com' }));
		expect(error.code).toBe('not_built');
		expect(h.mail.sent).toEqual([]);
	});
});

describe('verifyCode', () => {
	it('creates one user, one personal organisation, one owner membership and one audit row', async () => {
		const h = harness();
		const result = await signIn(h);
		expect(result.isNew).toBe(true);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.members).toHaveLength(1);
		expect(h.directory.orgs[0]).toMatchObject({ personal: true, createdBy: result.user.id });
		expect(h.directory.members[0]).toMatchObject({
			userId: result.user.id,
			organizationId: h.directory.orgs[0]!.id,
			role: 'owner'
		});
		expect(h.directory.audits).toEqual([
			{
				organizationId: h.directory.orgs[0]!.id,
				input: {
					actor: result.user.id,
					action: 'account.create',
					target: result.user.id,
					detail: { method: 'email-code' }
				}
			}
		]);
	});

	it('signs an existing address in without a second user, organisation or membership', async () => {
		const h = harness();
		const first = await signIn(h);
		const second = await signIn(h, 'ADA@example.com ');
		expect(second.isNew).toBe(false);
		expect(second.user.id).toBe(first.user.id);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.members).toHaveLength(1);
		expect(h.directory.audits).toHaveLength(1);
		expect(second.session.id).not.toBe(first.session.id);
	});

	it('signs in a user that already exists, such as one a provider created, without making an organisation', async () => {
		const h = harness();
		const existing = await h.directory.createUser('grace@example.com');
		const result = await signIn(h, 'grace@example.com');
		expect(result.user.id).toBe(existing.id);
		expect(result.isNew).toBe(false);
		expect(h.directory.orgs).toEqual([]);
	});

	it('is safe when two verifications for one new address run at once', async () => {
		const h = harness();
		const code = await codeFor(h, 'ada@example.com');
		// both lookups answer before either insert, so both callers try to create the user
		let arrivals = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
			setTimeout(resolve, 500);
		});
		const find = h.directory.findUserByEmail.bind(h.directory);
		vi.spyOn(h.directory, 'findUserByEmail').mockImplementation(async (email) => {
			const found = await find(email);
			if (++arrivals <= 2) {
				if (arrivals === 2) release();
				await gate;
			}
			return found;
		});
		const createUser = vi.spyOn(h.directory, 'createUser');
		const results = await Promise.all([
			verifyCode(h, { email: 'ada@example.com', code }),
			verifyCode(h, { email: 'ada@example.com', code })
		]);
		expect(createUser).toHaveBeenCalledTimes(2);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toHaveLength(1);
		expect(h.directory.members).toHaveLength(1);
		expect(h.directory.audits).toHaveLength(1);
		expect(results[0].user.id).toBe(results[1].user.id);
		expect(results.filter((r) => r.isNew)).toHaveLength(1);
	});

	it('adopts the winner when a parallel verification made the user after this one looked', async () => {
		const h = harness();
		const winner = await h.directory.createUser('ada@example.com');
		const find = h.directory.findUserByEmail.bind(h.directory);
		const stale = vi.spyOn(h.directory, 'findUserByEmail').mockResolvedValueOnce(null);
		stale.mockImplementation(find);
		const createUser = vi.spyOn(h.directory, 'createUser');
		const result = await verifyCode(h, {
			email: 'ada@example.com',
			code: await codeFor(h, 'ada@example.com')
		});
		expect(createUser).toHaveBeenCalledTimes(1);
		expect(result.user.id).toBe(winner.id);
		expect(result.isNew).toBe(false);
		expect(h.directory.users).toHaveLength(1);
		expect(h.directory.orgs).toEqual([]);
		expect(h.directory.audits).toEqual([]);
	});

	it('gives one answer for a wrong code, no code, an expired code and a code for another address', async () => {
		const h = harness();
		const code = await codeFor(h, 'ada@example.com');
		const wrong = code === '123456' ? '654321' : '123456';
		const attempts = [
			verifyCode(h, { email: 'ada@example.com', code: wrong }),
			verifyCode(h, { email: 'nobody@example.com', code }),
			verifyCode(h, { email: 'never-asked@example.com', code: '123456' })
		];
		const errors = await Promise.all(attempts.map(thrown));
		clock.advance(CODE_TTL_MS + 1);
		errors.push(await thrown(verifyCode(h, { email: 'ada@example.com', code })));
		for (const error of errors) {
			expect(error.code).toBe('unauthenticated');
			expect(error.message).toBe(errors[0]!.message);
			expect(error.details).toBeNull();
		}
		expect(h.directory.users).toEqual([]);
	});

	it('uses a code once', async () => {
		const h = harness();
		const code = await codeFor(h, 'ada@example.com');
		await verifyCode(h, { email: 'ada@example.com', code });
		expect((await thrown(verifyCode(h, { email: 'ada@example.com', code }))).code).toBe(
			'unauthenticated'
		);
	});

	it('never stores the session token or the code in plaintext', async () => {
		const h = harness();
		const code = await codeFor(h, 'ada@example.com');
		const result = await verifyCode(h, { email: 'ada@example.com', code });
		const everything = JSON.stringify(h.kv.dump()) + JSON.stringify(h.kv.keys());
		expect(everything).not.toContain(result.token);
		expect(everything).not.toContain(`"${code}"`);
		expect(h.kv.keys()).toContain(`session:token:${await hashSessionToken(result.token)}`);
	});

	it('records the device label and a truncated address on the session', async () => {
		const h = harness();
		const code = await codeFor(h, 'ada@example.com');
		const result = await verifyCode(h, {
			email: 'ada@example.com',
			code,
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
			ip: '198.51.100.23'
		});
		expect(result.session).toMatchObject({ device: 'Firefox on Linux', ip: '198.51.100.0/24' });
	});
});

describe('stepUp', () => {
	it('marks the session fresh and swaps its token and id', async () => {
		const h = harness();
		const { user, token, session } = await signIn(h);
		const code = await codeFor(h, user.email);
		const issued = await stepUp(h, { userId: user.id, sessionId: session.id, code });
		expect(issued.token).not.toBe(token);
		expect(issued.session.id).not.toBe(session.id);
		expect(issued.session.stepUpAt).toBe(clock.now);
		expect(await getSession(h.kv, token)).toBeNull();
		expect((await getSession(h.kv, issued.token))?.stepUpAt).toBe(clock.now);
		expect(stepUpUntil(issued.session)).toBe(clock.now + STEP_UP_WINDOW_MS);
		expect(stepUpUntil({})).toBeNull();
	});

	it('is fresh inside the window and stale one millisecond after it', async () => {
		const h = harness();
		const { user, session } = await signIn(h);
		const issued = await stepUp(h, {
			userId: user.id,
			sessionId: session.id,
			code: await codeFor(h, user.email)
		});
		const principal = { kind: 'user' as const, userId: user.id };
		const at = issued.session.stepUpAt!;
		expect(stepUpFresh(principal, facts({ now: at + STEP_UP_WINDOW_MS, stepUpAt: at }))).toBe(
			true
		);
		expect(
			stepUpFresh(principal, facts({ now: at + STEP_UP_WINDOW_MS + 1, stepUpAt: at }))
		).toBe(false);
	});

	it('refuses a wrong code and leaves the session as it was', async () => {
		const h = harness();
		const { user, token, session } = await signIn(h);
		const code = await codeFor(h, user.email);
		const wrong = code === '123456' ? '654321' : '123456';
		const error = await thrown(
			stepUp(h, { userId: user.id, sessionId: session.id, code: wrong })
		);
		expect(error.code).toBe('unauthenticated');
		const still = await getSession(h.kv, token);
		expect(still?.id).toBe(session.id);
		expect(still?.stepUpAt).toBeUndefined();
	});

	it('does not accept a code that was sent to a different address', async () => {
		const h = harness();
		const { user, session } = await signIn(h);
		const other = await codeFor(h, 'someone@else.com');
		const error = await thrown(
			stepUp(h, { userId: user.id, sessionId: session.id, code: other })
		);
		expect(error.code).toBe('unauthenticated');
	});

	it('refuses when the session was revoked in the meantime', async () => {
		const h = harness();
		const { user, session } = await signIn(h);
		const code = await codeFor(h, user.email);
		await revokeSession(h.kv, user.id, session.id);
		const error = await thrown(stepUp(h, { userId: user.id, sessionId: session.id, code }));
		expect(error.code).toBe('unauthenticated');
	});

	it('refuses an unknown user', async () => {
		const h = harness();
		const error = await thrown(
			stepUp(h, { userId: 'ghost', sessionId: 'ses_x', code: '123456' })
		);
		expect(error.code).toBe('unauthenticated');
	});
});

// #region resolver

function services(h: Harness): AuthServices {
	return { ...h, keys: kvKeyIndex(h.kv) };
}

async function issueKey(h: Harness, over: { expiresAt?: number; revokedAt?: number } = {}) {
	const generated = await generateApiKey({
		scopes: ['site.read'],
		expiry: '90d',
		now: clock.now
	});
	await kvKeyIndex(h.kv).put(generated.data.lookupId, {
		keyId: 'key-1',
		issuerId: 'user-9',
		orgId: 'org-1',
		keyHash: generated.data.keyHash,
		expiresAt: generated.data.expiresAt,
		...over
	});
	return generated;
}

const cookies = (token: string) => ({ [SESSION_COOKIE_NAME]: token });

describe('resolveCredential: sessions', () => {
	it('resolves a live session cookie to a user principal with the session id', async () => {
		const h = harness();
		const { token, user, session } = await signIn(h);
		const principal = await resolveCredential(services(h), {
			kind: 'cookies',
			cookies: cookies(token)
		});
		expect(principal).toEqual({ kind: 'user', userId: user.id, sessionId: session.id });
		expect(stepUpAtOf(principal!)).toBeUndefined();
	});

	it('carries the step-up time once the session has one', async () => {
		const h = harness();
		const { user, session } = await signIn(h);
		const issued = await stepUp(h, {
			userId: user.id,
			sessionId: session.id,
			code: await codeFor(h, user.email)
		});
		const principal = await resolveCredential(services(h), {
			kind: 'cookies',
			cookies: cookies(issued.token)
		});
		expect(stepUpAtOf(principal!)).toBe(clock.now);
	});

	it('resolves nothing for a revoked session, an expired one, no cookie or another cookie name', async () => {
		const h = harness();
		const live = await createSession(h.kv, { userId: 'u1' });
		const revoked = await createSession(h.kv, { userId: 'u1' });
		await revokeSession(h.kv, 'u1', revoked.session.id);
		const s = services(h);
		const resolve = (c: Record<string, string>) =>
			resolveCredential(s, { kind: 'cookies', cookies: c });
		expect(await resolve(cookies(revoked.token))).toBeNull();
		expect(await resolve({})).toBeNull();
		expect(await resolve({ session: live.token })).toBeNull();
		expect(await resolve(cookies('garbage'))).toBeNull();
		clock.advance(SESSION_IDLE_MS + 1000);
		expect(await resolve(cookies(live.token))).toBeNull();
	});
});

describe('resolveCredential: keys', () => {
	it('resolves a live key to a key principal with no step-up fact', async () => {
		const h = harness();
		const { token } = await issueKey(h);
		const principal = await resolveCredential(services(h), { kind: 'bearer', token });
		expect(principal).toEqual({ kind: 'key', keyId: 'key-1', issuerId: 'user-9' });
		expect(stepUpAtOf(principal!)).toBeUndefined();
		expect(principal).not.toHaveProperty('stepUpAt');
	});

	it('resolves nothing for a revoked key, an expired key or a key removed from the index', async () => {
		const h = harness();
		const s = services(h);
		const resolve = (token: string) => resolveCredential(s, { kind: 'bearer', token });
		const revoked = await issueKey(h, { revokedAt: clock.now - 1 });
		expect(await resolve(revoked.token)).toBeNull();
		const expired = await issueKey(h, { expiresAt: clock.now - 1 });
		expect(await resolve(expired.token)).toBeNull();
		const gone = await issueKey(h);
		expect(await resolve(gone.token)).not.toBeNull();
		await kvKeyIndex(h.kv).remove(gone.data.lookupId);
		expect(await resolve(gone.token)).toBeNull();
	});

	it('resolves nothing when the secret is wrong or the token is not a dfk_ key', async () => {
		const h = harness();
		const s = services(h);
		const { token, data } = await issueKey(h);
		const tampered = `${data.displayPrefix}_${'A'.repeat(43)}`;
		expect(await resolveCredential(s, { kind: 'bearer', token: tampered })).toBeNull();
		expect(await resolveCredential(s, { kind: 'bearer', token: 'dfk_nope' })).toBeNull();
		expect(
			await resolveCredential(s, { kind: 'bearer', token: token.slice(0, -1) })
		).toBeNull();
	});

	it('expires a key at its stored expiry', async () => {
		const h = harness();
		const s = services(h);
		const { token, data } = await issueKey(h);
		clock.advance(data.expiresAt - clock.now - 1);
		expect(await resolveCredential(s, { kind: 'bearer', token })).not.toBeNull();
		clock.advance(1);
		expect(await resolveCredential(s, { kind: 'bearer', token })).toBeNull();
	});
});

describe('the installed services', () => {
	it('throws not_built until services are installed', () => {
		expect(() => authServices()).toThrow(ApiError);
		try {
			authServices();
		} catch (error) {
			expect((error as ApiError).code).toBe('not_built');
		}
	});

	it('hands back what was installed, and the resolver reads it on each call', async () => {
		const h = harness();
		const resolver = createPrincipalResolver();
		const { token } = await createSession(h.kv, { userId: 'u1' });
		await expect(resolver({ kind: 'cookies', cookies: cookies(token) })).rejects.toThrow(
			ApiError
		);
		const installed = services(h);
		setAuthServices(installed);
		expect(authServices()).toBe(installed);
		expect(await resolver({ kind: 'cookies', cookies: cookies(token) })).toMatchObject({
			kind: 'user',
			userId: 'u1'
		});
	});
});

describe('key index', () => {
	it('round-trips a record and ignores a damaged one', async () => {
		const h = harness();
		const index = kvKeyIndex(h.kv);
		const record = { keyId: 'k', issuerId: 'i', orgId: 'o', keyHash: 'h' };
		await index.put('abc123abc123', record);
		expect(await index.find('abc123abc123')).toEqual(record);
		expect(await index.find('missing')).toBeNull();
		await h.kv.put('apikey:bad', '{not json');
		await h.kv.put('apikey:odd', JSON.stringify({ keyId: 1 }));
		expect(await index.find('bad')).toBeNull();
		expect(await index.find('odd')).toBeNull();
	});
});

// #endregion

// #region production wiring

describe('siteverifyTurnstile', () => {
	const reply = (body: unknown, ok = true) =>
		vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response);

	it('posts the secret, token and address and reads the verdict', async () => {
		const fetchFn = reply({ success: true });
		const check = siteverifyTurnstile('secret-1', fetchFn as unknown as typeof fetch);
		expect(await check('tok', '203.0.113.5')).toBe(true);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
		expect(init.method).toBe('POST');
		expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
			secret: 'secret-1',
			response: 'tok',
			remoteip: '203.0.113.5'
		});
	});

	it('fails a rejected token, an error reply and a missing token without asking twice', async () => {
		expect(
			await siteverifyTurnstile('s', reply({ success: false }) as never)('t', undefined)
		).toBe(false);
		expect(await siteverifyTurnstile('s', reply({}, false) as never)('t', undefined)).toBe(
			false
		);
		const none = reply({ success: true });
		expect(await siteverifyTurnstile('s', none as never)(undefined, undefined)).toBe(false);
		expect(none).not.toHaveBeenCalled();
	});

	it('fails closed when no secret is configured', async () => {
		await expect(siteverifyTurnstile(undefined)('t', undefined)).rejects.toMatchObject({
			code: 'not_built'
		});
	});
});

describe('productionServices', () => {
	it('keeps mail and an unconfigured bot check closed, and the code secret empty', async () => {
		const h = harness();
		const prod = productionServices({ KV: h.kv } as never, {});
		expect(prod.kv).toBe(h.kv);
		expect(prod.codeSecret).toBe('');
		await expect(
			prod.mail.send('a@b.co', { kind: 'login-code', code: '1', expiresInMinutes: 1 })
		).rejects.toMatchObject({ code: 'not_built' });
		await expect(prod.turnstile('t', undefined)).rejects.toMatchObject({ code: 'not_built' });
		const error = await thrown(requestCode(prod, { email: 'a@b.co' }));
		expect(error.code).toBe('not_built');
	});

	it('takes the secrets it is given and finds keys through the KV index', async () => {
		const h = harness();
		const prod = productionServices({ KV: h.kv } as never, {
			codeSecret: 'c',
			turnstileSecret: 't'
		});
		expect(prod.codeSecret).toBe('c');
		await kvKeyIndex(h.kv).put('aaaaaaaaaaaa', {
			keyId: 'k',
			issuerId: 'i',
			orgId: 'o',
			keyHash: 'h'
		});
		expect((await prod.keys.find('aaaaaaaaaaaa'))?.keyId).toBe('k');
	});
});

// #endregion
