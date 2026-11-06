import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { sha256Hex } from '../../../src/server/services/crypto';
import {
	CODE_ATTEMPT_RATE,
	CODE_MAX_ATTEMPTS,
	CODE_RESEND_COOLDOWN_MS,
	collegeAttemptStore,
	consumeCode,
	issueCode,
	type AttemptStore
} from '../../../src/server/services/email-codes';
import { collegeOnceStore } from '../../../src/server/services/single-use';
import { SECRET, memoryMail, useClock } from '../../unit/server/services/auth-support';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;
let store: AttemptStore;
let clock: ReturnType<typeof useClock>;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
	store = collegeAttemptStore(async () => db);
});

afterAll(() => open.close());

beforeEach(() => {
	clock = useClock();
});

afterEach(() => clock.stop());

const RULE = { limit: 5, windowMs: 60_000 };
const freshKey = () => `test-${crypto.randomUUID()}`;
const wrongGuess = (code: string, offset: number) =>
	String((Number(code) + offset + 1) % 1_000_000).padStart(6, '0');

async function storedAttempts(key: string): Promise<number | null> {
	const row = await env.DB.prepare('SELECT attempts FROM code_attempts WHERE key = ?')
		.bind(key)
		.first<{ attempts: number }>();
	return row?.attempts ?? null;
}

describe('attempt claims against real D1', () => {
	it('count one at a time up to the limit and then refuse', async () => {
		const key = freshKey();
		const answers: (number | null)[] = [];
		for (let i = 0; i < 7; i++) answers.push(await store.claim(key, clock.now, RULE));
		expect(answers).toEqual([1, 2, 3, 4, 5, null, null]);
		expect(await storedAttempts(key)).toBe(5);
	});

	it('grant exactly the limit to twenty parallel claims, each with its own count', async () => {
		const key = freshKey();
		const answers = await Promise.all(
			Array.from({ length: 20 }, () => store.claim(key, clock.now, RULE))
		);
		const granted = answers.filter((answer): answer is number => answer !== null);
		expect(granted.sort()).toEqual([1, 2, 3, 4, 5]);
		expect(answers.filter((answer) => answer === null)).toHaveLength(15);
		expect(await storedAttempts(key)).toBe(5);
	});

	it('start a new window once the old one has passed, and not a moment before', async () => {
		const key = freshKey();
		for (let i = 0; i < 5; i++) await store.claim(key, clock.now, RULE);
		expect(await store.claim(key, clock.now + RULE.windowMs - 1, RULE)).toBeNull();
		expect(await store.claim(key, clock.now + RULE.windowMs, RULE)).toBe(1);
	});

	it('forget a key on clear, and keep other keys apart', async () => {
		const a = freshKey();
		const b = freshKey();
		for (let i = 0; i < 5; i++) await store.claim(a, clock.now, RULE);
		await store.claim(b, clock.now, RULE);
		await store.clear(a);
		expect(await storedAttempts(a)).toBeNull();
		expect(await store.claim(a, clock.now, RULE)).toBe(1);
		expect(await storedAttempts(b)).toBe(1);
	});
});

describe('consumeCode against real D1 attempts', () => {
	const email = () => `person-${crypto.randomUUID()}@example.test`;

	async function issued(address: string) {
		const once = collegeOnceStore(async () => db);
		const mail = memoryMail();
		await issueCode(once, mail, SECRET, address, clock.now);
		return { once, mail, code: mail.lastCode() };
	}

	it('refuses the right code after five parallel wrong guesses', async () => {
		const address = email();
		const { once, code } = await issued(address);
		const results = await Promise.all(
			Array.from({ length: CODE_MAX_ATTEMPTS }, (_, i) =>
				consumeCode(once, store, SECRET, address, wrongGuess(code, i), clock.now)
			)
		);
		expect(results).toEqual(Array(CODE_MAX_ATTEMPTS).fill(false));
		expect(await consumeCode(once, store, SECRET, address, code, clock.now)).toBe(false);
	});

	it('never counts more than the limit when many guesses race', async () => {
		const address = email();
		const { once, code } = await issued(address);
		await Promise.all(
			Array.from({ length: 30 }, (_, i) =>
				consumeCode(once, store, SECRET, address, wrongGuess(code, i), clock.now)
			)
		);
		expect(await storedAttempts(`code-attempts:${await sha256Hex(address)}`)).toBe(
			CODE_MAX_ATTEMPTS
		);
		expect(await consumeCode(once, store, SECRET, address, code, clock.now)).toBe(false);
	});

	it('keeps the count when a fresh code is issued inside the window', async () => {
		const address = email();
		const { once, mail, code } = await issued(address);
		for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
			await consumeCode(once, store, SECRET, address, wrongGuess(code, i), clock.now);
		}
		clock.advance(CODE_RESEND_COOLDOWN_MS);
		await issueCode(once, mail, SECRET, address, clock.now);
		expect(await consumeCode(once, store, SECRET, address, mail.lastCode(), clock.now)).toBe(
			false
		);
		clock.advance(CODE_ATTEMPT_RATE.windowMs);
		await issueCode(once, mail, SECRET, address, clock.now);
		expect(await consumeCode(once, store, SECRET, address, mail.lastCode(), clock.now)).toBe(
			true
		);
	});

	it('writes no row for an address that has no live code', async () => {
		const address = email();
		const before = await env.DB.prepare('SELECT count(*) AS n FROM code_attempts').first<{
			n: number;
		}>();
		for (let i = 0; i < 3; i++) {
			expect(
				await consumeCode(
					collegeOnceStore(async () => db),
					store,
					SECRET,
					address,
					'123456',
					clock.now
				)
			).toBe(false);
		}
		const after = await env.DB.prepare('SELECT count(*) AS n FROM code_attempts').first<{
			n: number;
		}>();
		expect((after?.n ?? 0) - (before?.n ?? 0)).toBeLessThanOrEqual(1);
	});
});
