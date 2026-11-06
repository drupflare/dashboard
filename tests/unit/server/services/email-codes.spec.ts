import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CODE_ATTEMPT_RATE,
	CODE_LENGTH,
	CODE_MAX_ATTEMPTS,
	CODE_RESEND_COOLDOWN_MS,
	CODE_SEND_RATE,
	CODE_TTL_MS,
	collegeAttemptStore,
	consumeCode,
	generateCode,
	issueCode
} from '../../../../src/server/services/email-codes';
import { SECRET, memoryAttempts, memoryMail, memoryOnce, useClock } from './auth-support';

let clock: ReturnType<typeof useClock>;
beforeEach(() => {
	clock = useClock();
});
afterEach(() => {
	clock.stop();
	vi.restoreAllMocks();
});

const EMAIL = 'Ada@Example.com';

async function setup() {
	const once = memoryOnce();
	const mail = memoryMail();
	const attempts = memoryAttempts();
	const issue = (email = EMAIL) => issueCode(once, mail, SECRET, email, clock.now);
	const consume = (code: string, email = EMAIL, secret = SECRET) =>
		consumeCode(once, attempts, secret, email, code, clock.now);
	return { once, mail, attempts, issue, consume };
}

describe('generateCode', () => {
	it('makes six digits, zero padded', () => {
		for (let i = 0; i < 500; i++) expect(generateCode()).toMatch(/^\d{6}$/);
		expect(CODE_LENGTH).toBe(6);
	});

	it('pads a small sample with leading zeros', () => {
		vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
			array[0] = 5;
			return array;
		}) as never);
		expect(generateCode()).toBe('000005');
	});

	it('rejects samples above the largest whole multiple of the code space', () => {
		const samples = [4_294_967_295, 4_294_000_000, 1_234_567];
		vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
			array[0] = samples.shift()!;
			return array;
		}) as never);
		expect(generateCode()).toBe('234567');
		expect(samples).toEqual([]);
	});
});

describe('issueCode', () => {
	it('sends the code to the normalised address and stores only a keyed hash', async () => {
		const { once, mail, issue } = await setup();
		expect(await issue()).toEqual({ ok: true });
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]!.to).toBe('ada@example.com');
		expect(mail.sent[0]!.template).toMatchObject({
			kind: 'login-code',
			expiresInMinutes: CODE_TTL_MS / 60_000
		});
		const code = mail.lastCode();
		expect(code).toMatch(/^\d{6}$/);
		const everything = JSON.stringify({ keys: once.keys(), values: once.dump() });
		expect(everything).not.toContain(`"${code}"`);
		expect(everything).not.toMatch(new RegExp(`:${code}\\b`));
		expect(everything).not.toContain('ada@example.com');
	});

	it('blocks a resend inside the cooldown and allows it after', async () => {
		const { mail, issue } = await setup();
		await issue();
		clock.advance(CODE_RESEND_COOLDOWN_MS - 1000);
		expect(await issue()).toEqual({ ok: false, retryAfterSeconds: 1 });
		expect(mail.sent).toHaveLength(1);
		clock.advance(1000);
		expect(await issue()).toEqual({ ok: true });
		expect(mail.sent).toHaveLength(2);
	});

	it('caps sends per address per window and frees a slot as the window slides', async () => {
		const { mail, issue } = await setup();
		const gap = CODE_RESEND_COOLDOWN_MS;
		for (let i = 0; i < CODE_SEND_RATE.limit; i++) {
			expect(await issue()).toEqual({ ok: true });
			clock.advance(gap);
		}
		const blocked = await issue();
		expect(blocked.ok).toBe(false);
		expect(mail.sent).toHaveLength(CODE_SEND_RATE.limit);
		if (!blocked.ok) {
			clock.advance(blocked.retryAfterSeconds * 1000);
			expect(await issue()).toEqual({ ok: true });
		}
	});

	it('limits one address and leaves another alone', async () => {
		const { issue } = await setup();
		await issue('a@example.com');
		expect((await issue('a@example.com')).ok).toBe(false);
		expect((await issue('b@example.com')).ok).toBe(true);
	});

	it('applies the same cooldown to every address, whether or not it has an account', async () => {
		const { issue } = await setup();
		await issue('known@example.com');
		await issue('unknown@example.com');
		expect(await issue('known@example.com')).toEqual(await issue('unknown@example.com'));
	});

	it('replaces the old code with the new one', async () => {
		const samples = [111_111, 222_222];
		vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
			array[0] = samples.shift()!;
			return array;
		}) as never);
		const { mail, issue, consume } = await setup();
		await issue();
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await issue();
		expect(mail.sent.map((m) => m.template.code)).toEqual(['111111', '222222']);
		expect(await consume('111111')).toBe(false);
		expect(await consume('222222')).toBe(true);
	});

	it('drops the record and rethrows when the mail fails, so a retry is not blocked', async () => {
		const { once, mail, issue } = await setup();
		mail.failNext();
		await expect(issue()).rejects.toThrow('mail is down');
		expect(once.keys()).toEqual([]);
		expect(await issue()).toEqual({ ok: true });
	});
});

describe('consumeCode', () => {
	it('accepts the code once', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const code = mail.lastCode();
		expect(await consume(code)).toBe(true);
		expect(await consume(code)).toBe(false);
	});

	it('ignores case and spacing in the address', async () => {
		const { mail, issue, consume } = await setup();
		await issue('ada@example.com');
		expect(await consume(mail.lastCode(), '  ADA@example.com ')).toBe(true);
	});

	it('works up to the ttl and not at it', async () => {
		const first = await setup();
		await first.issue();
		clock.advance(CODE_TTL_MS - 1);
		expect(await first.consume(first.mail.lastCode())).toBe(true);
		const second = await setup();
		await second.issue();
		clock.advance(CODE_TTL_MS);
		expect(await second.consume(second.mail.lastCode())).toBe(false);
	});

	it('locks after the allowed wrong attempts, even for the right code', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const code = mail.lastCode();
		const wrong = code === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) expect(await consume(wrong)).toBe(false);
		expect(await consume(code)).toBe(false);
	});

	it('lets the right code through before the lock, and a wrong try does not burn it', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const code = mail.lastCode();
		const wrong = code === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i++) expect(await consume(wrong)).toBe(false);
		expect(await consume(code)).toBe(true);
	});

	it('keeps the lock when a fresh code is issued inside the attempt window', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const wrong = mail.lastCode() === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await consume(wrong);
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await issue();
		expect(await consume(mail.lastCode())).toBe(false);
	});

	it('frees the address once the attempt window has passed', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const wrong = mail.lastCode() === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await consume(wrong);
		clock.advance(CODE_ATTEMPT_RATE.windowMs);
		await issue();
		expect(await consume(mail.lastCode())).toBe(true);
	});

	it('outlasts the life of a code, so waiting for expiry does not reset the count', () => {
		expect(CODE_ATTEMPT_RATE.windowMs).toBeGreaterThan(CODE_TTL_MS);
		expect(CODE_ATTEMPT_RATE.limit).toBe(CODE_MAX_ATTEMPTS);
	});

	it('clears the count after a right code, so the next sign-in starts fresh', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const wrong = mail.lastCode() === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i++) await consume(wrong);
		expect(await consume(mail.lastCode())).toBe(true);
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await issue();
		for (let i = 0; i < CODE_MAX_ATTEMPTS - 1; i++) await consume(wrong);
		expect(await consume(mail.lastCode())).toBe(true);
	});

	it('counts one address apart from another', async () => {
		const { mail, issue, consume } = await setup();
		await issue('a@example.com');
		const a = mail.lastCode();
		await issue('b@example.com');
		const b = mail.lastCode();
		const wrong = a === '000000' || b === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await consume(wrong, 'a@example.com');
		expect(await consume(a, 'a@example.com')).toBe(false);
		expect(await consume(b, 'b@example.com')).toBe(true);
	});

	it('claims no per-address row for a guess with no live code', async () => {
		const { attempts, consume } = await setup();
		await consume('123456');
		await consume('123456', 'other@example.com');
		expect(attempts.granted).toHaveLength(2);
		expect(new Set(attempts.granted.map((entry) => entry.key)).size).toBe(1);
	});

	it('answers false the same way for no code, a wrong code, an expired code and another address', async () => {
		const { mail, issue, consume } = await setup();
		expect(await consume('123456')).toBe(false);
		await issue();
		const code = mail.lastCode();
		const wrong = code === '123456' ? '654321' : '123456';
		expect(await consume(wrong)).toBe(false);
		expect(await consume(code, 'someone@else.com')).toBe(false);
		clock.advance(CODE_TTL_MS + 1);
		expect(await consume(code)).toBe(false);
	});

	it('does not accept a code made under another secret', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		expect(await consume(mail.lastCode(), EMAIL, 'another-secret')).toBe(false);
	});

	it('does the same store work with or without a stored code', async () => {
		const { once, mail, issue, consume } = await setup();
		const calls = { get: vi.spyOn(once, 'get'), takeIf: vi.spyOn(once, 'takeIf') };
		await consume('123456');
		const without = {
			get: calls.get.mock.calls.length,
			takeIf: calls.takeIf.mock.calls.length
		};
		await issue();
		calls.get.mockClear();
		calls.takeIf.mockClear();
		await consume(mail.lastCode());
		expect(without).toEqual({ get: 1, takeIf: 1 });
		expect({
			get: calls.get.mock.calls.length,
			takeIf: calls.takeIf.mock.calls.length
		}).toEqual(without);
	});

	it('lets exactly one of several parallel right guesses take the code', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const code = mail.lastCode();
		const results = await Promise.all(Array.from({ length: 6 }, () => consume(code)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});

	it('leaves a code in place after a wrong guess, so the right one still works', async () => {
		const { once, mail, issue, consume } = await setup();
		await issue();
		const before = once.keys().length;
		const wrong = String((Number(mail.lastCode()) + 1) % 1_000_000).padStart(6, '0');
		expect(await consume(wrong)).toBe(false);
		expect(once.keys()).toHaveLength(before);
		expect(await consume(mail.lastCode())).toBe(true);
	});
});

describe('collegeAttemptStore', () => {
	it('sends the claim and the clear to the database under the same key', async () => {
		const calls: { method: string; key: string; sql: string; params: unknown[] }[] = [];
		const db = {
			async first(key: string, sql: string, params: unknown[]) {
				calls.push({ method: 'first', key, sql, params });
				return { attempts: 3 };
			},
			async run(key: string, sql: string, params: unknown[]) {
				calls.push({ method: 'run', key, sql, params });
			}
		} as unknown as CollegeDBClient;
		const store = collegeAttemptStore(async () => db);
		expect(await store.claim('k1', 1_000_000, { limit: 5, windowMs: 1000 })).toBe(3);
		await store.clear('k1');
		expect(calls.map((call) => [call.method, call.key])).toEqual([
			['first', 'k1'],
			['run', 'k1']
		]);
		expect(calls[0]!.sql).toMatch(/RETURNING attempts/);
		expect(calls[0]!.params).toEqual([
			'k1',
			1_000_000,
			999_000,
			999_000,
			1_000_000,
			999_000,
			5
		]);
	});

	it('reads a refused claim as null', async () => {
		const db = { first: async () => null } as unknown as CollegeDBClient;
		const store = collegeAttemptStore(async () => db);
		expect(await store.claim('k1', 1, { limit: 5, windowMs: 1000 })).toBeNull();
	});
});
