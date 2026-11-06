import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { claimAttempt, clearAttempts } from '../db/repos/code-attempts';
import { normalizeEmail } from '../db/repos/identity';
import { slideWindow, type RateRule } from '../utils/rate-limit';
import { hmacSha256Hex, sha256Hex } from './crypto';
import type { OnceStore } from './single-use';

// #region constants

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const CODE_SEND_RATE: RateRule = { limit: 5, windowMs: 10 * 60 * 1000 };
// guesses per address, longer than a code lives so a fresh code does not reset the count
export const CODE_ATTEMPT_RATE: RateRule = {
	limit: CODE_MAX_ATTEMPTS,
	windowMs: 15 * 60 * 1000
};

const SENDS_TTL_MS = Math.max(CODE_TTL_MS, CODE_SEND_RATE.windowMs);
const CODE_SPACE = 10 ** CODE_LENGTH;
// the largest multiple of the code space below 2^32, so every code is equally likely
const SAMPLE_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;
const NO_RECORD_ATTEMPTS = 'code-attempts:none';

// #endregion

// #region attempts

// claim counts one guess and returns the new count, or null once the allowance is spent; an
// implementation must make the check and the count one atomic step
export interface AttemptStore {
	claim(key: string, now: number, rule: RateRule): Promise<number | null>;
	clear(key: string): Promise<void>;
}

export function collegeAttemptStore(getDb: () => Promise<CollegeDBClient>): AttemptStore {
	return {
		async claim(key, now, rule) {
			return claimAttempt(await getDb(), key, now, rule);
		},
		async clear(key) {
			await clearAttempts(await getDb(), key);
		}
	};
}

// #endregion

// #region mail

export interface MailTemplate {
	kind: 'login-code';
	code: string;
	expiresInMinutes: number;
}

export interface MailSender {
	send(to: string, template: MailTemplate): Promise<void>;
}

// the development sender; it prints the code, so nothing selects it where logs are shared
export function consoleMailSender(write: (line: string) => void = console.info): MailSender {
	return {
		async send(to, template) {
			write(
				`[dev mail] ${template.kind} to ${to}: ${template.code} (${template.expiresInMinutes} min)`
			);
		}
	};
}

// #endregion

// #region records

// the hash is the single-use row's value; the send history is its own row
const sendsSchema = z.object({ sentAt: z.number(), sends: z.array(z.number()) });

type SendHistory = z.infer<typeof sendsSchema>;

function parseSends(raw: string | null): SendHistory | null {
	if (raw === null) return null;
	try {
		const parsed = sendsSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function codeKey(email: string): Promise<string> {
	return `code:${await sha256Hex(email)}`;
}

async function sendsKey(email: string): Promise<string> {
	return `code-sends:${await sha256Hex(email)}`;
}

async function attemptKey(email: string): Promise<string> {
	return `code-attempts:${await sha256Hex(email)}`;
}

// the secret keys the hash, so a copy of the store cannot be searched for the million codes
function hashCode(secret: string, email: string, code: string): Promise<string> {
	return hmacSha256Hex(secret, `login-code:${email}:${code}`);
}

export function generateCode(): string {
	const sample = new Uint32Array(1);
	for (;;) {
		crypto.getRandomValues(sample);
		const value = sample[0]!;
		if (value < SAMPLE_LIMIT) return String(value % CODE_SPACE).padStart(CODE_LENGTH, '0');
	}
}

// #endregion

// #region issue and consume

export type IssueResult = { ok: true } | { ok: false; retryAfterSeconds: number };

// the cooldown and the send rate hold for every email, known or not, so they reveal nothing
export async function issueCode(
	once: OnceStore,
	mail: MailSender,
	secret: string,
	rawEmail: string,
	now: number
): Promise<IssueResult> {
	const email = normalizeEmail(rawEmail);
	const [key, historyKey] = await Promise.all([codeKey(email), sendsKey(email)]);
	const existing = parseSends(await once.get(historyKey, now));
	if (existing && now - existing.sentAt < CODE_RESEND_COOLDOWN_MS) {
		const wait = CODE_RESEND_COOLDOWN_MS - (now - existing.sentAt);
		return { ok: false, retryAfterSeconds: Math.ceil(wait / 1000) };
	}
	const rate = slideWindow(existing?.sends ?? [], now, CODE_SEND_RATE);
	if (!rate.allowed) return { ok: false, retryAfterSeconds: rate.retryAfterSeconds };

	const code = generateCode();
	await once.put(key, await hashCode(secret, email, code), now + CODE_TTL_MS);
	await once.put(
		historyKey,
		JSON.stringify({ sentAt: now, sends: rate.timestamps } satisfies SendHistory),
		now + SENDS_TTL_MS
	);
	try {
		await mail.send(email, {
			kind: 'login-code',
			code,
			expiresInMinutes: CODE_TTL_MS / 60_000
		});
	} catch (error) {
		await Promise.all([once.take(key, now), once.take(historyKey, now)]);
		throw error;
	}
	return { ok: true };
}

// a missing, expired, locked or wrong code all return false, so a caller learns nothing more.
// Every guess claims an attempt first, and the code is taken by one conditional delete that
// matches on the hash, so a wrong guess leaves it and two right guesses cannot both win
export async function consumeCode(
	once: OnceStore,
	attempts: AttemptStore,
	secret: string,
	rawEmail: string,
	code: string,
	now: number
): Promise<boolean> {
	const email = normalizeEmail(rawEmail);
	const key = await codeKey(email);
	const candidate = await hashCode(secret, email, code);
	const live = (await once.get(key, now)) !== null;
	// no live code: claim a shared slot so the work matches and no row is made per address
	const slot = live ? await attemptKey(email) : NO_RECORD_ATTEMPTS;
	const claimed = await attempts.claim(slot, now, CODE_ATTEMPT_RATE);
	if (claimed === null) return false;
	const taken = await once.takeIf(key, candidate, now);
	if (!live || !taken) return false;
	await attempts.clear(slot);
	return true;
}

// #endregion
