import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	collegeAttemptStore,
	consumeCode,
	issueCode
} from '../../../src/server/services/email-codes';
import { collegeOnceStore, type OnceStore } from '../../../src/server/services/single-use';
import { SECRET, memoryMail } from '../../unit/server/services/auth-support';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;
let once: OnceStore;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
	once = collegeOnceStore(async () => db);
});

afterAll(() => open.close());

const NOW = 1_800_000_000_000;
const key = () => `test:${crypto.randomUUID()}`;

describe('single-use records on D1', () => {
	it('keeps a value until it is taken, then answers null', async () => {
		const k = key();
		await once.put(k, 'value', NOW + 1000);
		expect(await once.get(k, NOW)).toBe('value');
		expect(await once.get(k, NOW)).toBe('value');
		expect(await once.take(k, NOW)).toBe('value');
		expect(await once.take(k, NOW)).toBeNull();
		expect(await once.get(k, NOW)).toBeNull();
	});

	it('replaces the value and the expiry on a second put', async () => {
		const k = key();
		await once.put(k, 'first', NOW + 1000);
		await once.put(k, 'second', NOW + 5000);
		expect(await once.get(k, NOW + 2000)).toBe('second');
	});

	it('treats a record as gone at its expiry and removes it when taken', async () => {
		const k = key();
		await once.put(k, 'value', NOW + 1000);
		expect(await once.get(k, NOW + 999)).toBe('value');
		expect(await once.get(k, NOW + 1000)).toBeNull();
		expect(await once.take(k, NOW + 1000)).toBeNull();
		const left = await env.DB.prepare('SELECT count(*) AS n FROM single_use WHERE key = ?')
			.bind(k)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});

	it('lets exactly one of twenty parallel takes have the value', async () => {
		const k = key();
		await once.put(k, 'once', NOW + 1000);
		const taken = await Promise.all(Array.from({ length: 20 }, () => once.take(k, NOW)));
		expect(taken.filter((value) => value === 'once')).toHaveLength(1);
		expect(taken.filter((value) => value === null)).toHaveLength(19);
	});

	it('takes only a matching value, and a wrong value leaves the record alone', async () => {
		const k = key();
		await once.put(k, 'right', NOW + 1000);
		expect(await once.takeIf(k, 'wrong', NOW)).toBe(false);
		expect(await once.get(k, NOW)).toBe('right');
		expect(await once.takeIf(k, 'right', NOW + 1000)).toBe(false);
		expect(await once.takeIf(k, 'right', NOW)).toBe(true);
		expect(await once.takeIf(k, 'right', NOW)).toBe(false);
	});

	it('lets exactly one of twenty parallel matching takes win', async () => {
		const k = key();
		await once.put(k, 'right', NOW + 1000);
		const wins = await Promise.all(
			Array.from({ length: 20 }, () => once.takeIf(k, 'right', NOW))
		);
		expect(wins.filter(Boolean)).toHaveLength(1);
	});

	it('sweeps expired records on its shard when another record is written', async () => {
		const stale = key();
		await once.put(stale, 'old', Date.now() - 1000);
		await once.put(key(), 'new', Date.now() + 60_000);
		const left = await env.DB.prepare('SELECT count(*) AS n FROM single_use WHERE key = ?')
			.bind(stale)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});

describe('sign-in codes on D1', () => {
	const email = () => `code-${crypto.randomUUID()}@example.test`;
	const attempts = () => collegeAttemptStore(async () => db);

	it('accepts a code once, however many right guesses arrive together', async () => {
		const address = email();
		const mail = memoryMail();
		await issueCode(once, mail, SECRET, address, NOW);
		const code = mail.lastCode();
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				consumeCode(once, attempts(), SECRET, address, code, NOW)
			)
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await consumeCode(once, attempts(), SECRET, address, code, NOW)).toBe(false);
	});

	it('keeps the code after a wrong guess and refuses it after five', async () => {
		const address = email();
		const mail = memoryMail();
		await issueCode(once, mail, SECRET, address, NOW);
		const code = mail.lastCode();
		const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
		expect(await consumeCode(once, attempts(), SECRET, address, wrong, NOW)).toBe(false);
		expect(await consumeCode(once, attempts(), SECRET, address, code, NOW)).toBe(true);

		const locked = email();
		await issueCode(once, mail, SECRET, locked, NOW);
		const lockedCode = mail.lastCode();
		const wrongLocked = String((Number(lockedCode) + 1) % 1_000_000).padStart(6, '0');
		for (let i = 0; i < 5; i++) {
			await consumeCode(once, attempts(), SECRET, locked, wrongLocked, NOW);
		}
		expect(await consumeCode(once, attempts(), SECRET, locked, lockedCode, NOW)).toBe(false);
	});

	it('stores a keyed hash of the code and no address', async () => {
		const address = email();
		const mail = memoryMail();
		await issueCode(once, mail, SECRET, address, NOW);
		const { results } = await env.DB.prepare('SELECT key, value FROM single_use').all<{
			key: string;
			value: string;
		}>();
		expect(JSON.stringify(results)).not.toContain(address);
		expect(results.every((row) => row.value !== mail.lastCode())).toBe(true);
		const stored = results.filter((row) => row.key.startsWith('code:'));
		expect(stored.length).toBeGreaterThan(0);
		for (const row of stored) expect(row.value).toMatch(/^[0-9a-f]{64}$/);
	});
});
