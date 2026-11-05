import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cryptoModule from '../../../../src/server/services/crypto';
import {
	CODE_LENGTH,
	CODE_MAX_ATTEMPTS,
	CODE_RESEND_COOLDOWN_MS,
	CODE_SEND_RATE,
	CODE_TTL_MS,
	consumeCode,
	generateCode,
	issueCode
} from '../../../../src/server/services/email-codes';
import { SECRET, memoryKv, memoryMail, useClock } from './auth-support';

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
	const kv = memoryKv();
	const mail = memoryMail();
	const issue = (email = EMAIL) => issueCode(kv, mail, SECRET, email, clock.now);
	const consume = (code: string, email = EMAIL, secret = SECRET) =>
		consumeCode(kv, secret, email, code, clock.now);
	return { kv, mail, issue, consume };
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
		const { kv, mail, issue } = await setup();
		expect(await issue()).toEqual({ ok: true });
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]!.to).toBe('ada@example.com');
		expect(mail.sent[0]!.template).toMatchObject({
			kind: 'login-code',
			expiresInMinutes: CODE_TTL_MS / 60_000
		});
		const code = mail.lastCode();
		expect(code).toMatch(/^\d{6}$/);
		const everything = JSON.stringify({ keys: kv.keys(), values: kv.dump() });
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
		const { kv, mail, issue } = await setup();
		mail.failNext();
		await expect(issue()).rejects.toThrow('mail is down');
		expect(kv.keys()).toEqual([]);
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

	it('a fresh code clears the lock', async () => {
		const { mail, issue, consume } = await setup();
		await issue();
		const wrong = mail.lastCode() === '000000' ? '000001' : '000000';
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) await consume(wrong);
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await issue();
		expect(await consume(mail.lastCode())).toBe(true);
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

	it('compares hashes in constant time, with or without a stored record', async () => {
		const spy = vi.spyOn(cryptoModule, 'timingSafeEqual');
		const { mail, issue, consume } = await setup();
		await consume('123456');
		expect(spy).toHaveBeenCalledTimes(1);
		await issue();
		await consume(mail.lastCode());
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
