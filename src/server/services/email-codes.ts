import { z } from 'zod';
import { normalizeEmail } from '../db/repos/identity';
import { slideWindow, type RateRule } from '../utils/rate-limit';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto';
import type { KvStore } from './sessions';

// #region constants

export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const CODE_SEND_RATE: RateRule = { limit: 5, windowMs: 10 * 60 * 1000 };

const RECORD_TTL_MS = Math.max(CODE_TTL_MS, CODE_SEND_RATE.windowMs);
const MIN_KV_TTL_SECONDS = 60;
const CODE_SPACE = 10 ** CODE_LENGTH;
// the largest multiple of the code space below 2^32, so every code is equally likely
const SAMPLE_LIMIT = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;
const NO_RECORD_HASH = '0'.repeat(64);

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

// #endregion

// #region records

const recordSchema = z.object({
	hash: z.string(),
	expiresAt: z.number(),
	attempts: z.number(),
	sentAt: z.number(),
	sends: z.array(z.number())
});

type CodeRecord = z.infer<typeof recordSchema>;

function parseRecord(raw: string | null): CodeRecord | null {
	if (raw === null) return null;
	try {
		const parsed = recordSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function recordKey(email: string): Promise<string> {
	return `code:${await sha256Hex(email)}`;
}

function ttlSeconds(record: CodeRecord, now: number): number {
	return Math.max(MIN_KV_TTL_SECONDS, Math.ceil((record.sentAt + RECORD_TTL_MS - now) / 1000));
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
	kv: KvStore,
	mail: MailSender,
	secret: string,
	rawEmail: string,
	now: number
): Promise<IssueResult> {
	const email = normalizeEmail(rawEmail);
	const key = await recordKey(email);
	const existing = parseRecord(await kv.get(key));
	if (existing && now - existing.sentAt < CODE_RESEND_COOLDOWN_MS) {
		const wait = CODE_RESEND_COOLDOWN_MS - (now - existing.sentAt);
		return { ok: false, retryAfterSeconds: Math.ceil(wait / 1000) };
	}
	const rate = slideWindow(existing?.sends ?? [], now, CODE_SEND_RATE);
	if (!rate.allowed) return { ok: false, retryAfterSeconds: rate.retryAfterSeconds };

	const code = generateCode();
	const record: CodeRecord = {
		hash: await hashCode(secret, email, code),
		expiresAt: now + CODE_TTL_MS,
		attempts: 0,
		sentAt: now,
		sends: rate.timestamps
	};
	await kv.put(key, JSON.stringify(record), { expirationTtl: ttlSeconds(record, now) });
	try {
		await mail.send(email, {
			kind: 'login-code',
			code,
			expiresInMinutes: CODE_TTL_MS / 60_000
		});
	} catch (error) {
		await kv.delete(key);
		throw error;
	}
	return { ok: true };
}

// a missing, expired, locked or wrong code all return false, so a caller learns nothing more
export async function consumeCode(
	kv: KvStore,
	secret: string,
	rawEmail: string,
	code: string,
	now: number
): Promise<boolean> {
	const email = normalizeEmail(rawEmail);
	const key = await recordKey(email);
	const record = parseRecord(await kv.get(key));
	const candidate = await hashCode(secret, email, code);
	const matches = timingSafeEqual(candidate, record?.hash ?? NO_RECORD_HASH);
	if (!record || record.expiresAt <= now || record.attempts >= CODE_MAX_ATTEMPTS) return false;
	if (!matches) {
		const next = { ...record, attempts: record.attempts + 1 };
		await kv.put(key, JSON.stringify(next), { expirationTtl: ttlSeconds(next, now) });
		return false;
	}
	await kv.delete(key);
	return true;
}

// #endregion
