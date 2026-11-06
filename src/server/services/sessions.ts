import { z } from 'zod';
import { newId } from '../../shared/utils/ids';
import { nowUtc } from '../../shared/utils/time';
import { randomToken, sha256Hex } from './crypto';

// the slice of a workers kv namespace the auth services use; a map-backed fake fits it in tests
export interface KvStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

// #region constants

const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = '__Host-drupflare_session';
export const SESSION_IDLE_MS = 14 * DAY_MS;
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;
export const SESSION_TOUCH_MS = 10 * 60 * 1000;
export const MAX_SESSIONS_PER_USER = 5;

const MIN_KV_TTL_SECONDS = 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// #endregion

// #region records

const sessionSchema = z.object({
	id: z.string(),
	userId: z.string(),
	createdAt: z.number(),
	lastSeenAt: z.number(),
	stepUpAt: z.number().optional(),
	device: z.string(),
	ip: z.string().nullable()
});

export type SessionRecord = z.infer<typeof sessionSchema>;

const reverseSchema = z.object({ hash: z.string(), createdAt: z.number() });

interface Entry {
	id: string;
	hash: string;
	createdAt: number;
}

export interface IssuedSession {
	token: string;
	session: SessionRecord;
}

function parseJson<T extends z.ZodType>(schema: T, raw: string | null): z.infer<T> | null {
	if (raw === null) return null;
	try {
		const parsed = schema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

const tokenKey = (hash: string) => `session:token:${hash}`;
const userPrefix = (userId: string) => `session:user:${userId}:`;
const userKey = (userId: string, id: string) => `${userPrefix(userId)}${id}`;

const alive = (session: SessionRecord, now: number) =>
	now < session.createdAt + SESSION_ABSOLUTE_MS && now < session.lastSeenAt + SESSION_IDLE_MS;

function ttlSeconds(session: SessionRecord, now: number): number {
	const end = Math.min(
		session.lastSeenAt + SESSION_IDLE_MS,
		session.createdAt + SESSION_ABSOLUTE_MS
	);
	return Math.max(MIN_KV_TTL_SECONDS, Math.ceil((end - now) / 1000));
}

export function hashSessionToken(token: string): Promise<string> {
	return sha256Hex(token);
}

// #endregion

// #region device label

const BROWSERS: readonly [RegExp, string][] = [
	[/Edg\//, 'Edge'],
	[/OPR\/|Opera/, 'Opera'],
	[/Firefox\/|FxiOS\//, 'Firefox'],
	[/Chrome\/|CriOS\//, 'Chrome'],
	[/Safari\//, 'Safari']
];

const SYSTEMS: readonly [RegExp, string][] = [
	[/iPhone|iPad|iPod/, 'iOS'],
	[/Android/, 'Android'],
	[/Windows/, 'Windows'],
	[/Mac OS X|Macintosh/, 'macOS'],
	[/CrOS/, 'ChromeOS'],
	[/Linux/, 'Linux']
];

// a coarse label: no version numbers and nothing that fingerprints a device
export function deviceLabel(userAgent: string | null | undefined): string {
	if (!userAgent) return 'Unknown device';
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
	const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	if (!browser && !system) return 'Unknown device';
	return `${browser ?? 'Unknown browser'} on ${system ?? 'unknown system'}`;
}

// keeps the network and drops the host: a /24 for ipv4 and a /64 for ipv6
export function truncateIp(ip: string | null | undefined): string | null {
	if (!ip) return null;
	const mapped = /^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip);
	if (mapped?.[1]) return `${mapped[1]}.0/24`;
	if (!ip.includes(':') || !/^[0-9a-f:]+$/i.test(ip)) return null;
	const [head = '', tail] = ip.split('::');
	const front = head === '' ? [] : head.split(':');
	const back = tail === undefined || tail === '' ? [] : tail.split(':');
	const fill = tail === undefined ? 0 : Math.max(0, 8 - front.length - back.length);
	const groups = [...front, ...Array<string>(fill).fill('0'), ...back];
	if (groups.length !== 8) return null;
	return `${groups.slice(0, 4).join(':').toLowerCase()}::/64`;
}

// #endregion

// #region storage

async function store(
	kv: KvStore,
	hash: string,
	session: SessionRecord,
	now: number
): Promise<void> {
	const options = { expirationTtl: ttlSeconds(session, now) };
	const reverse = JSON.stringify({ hash, createdAt: session.createdAt });
	await Promise.all([
		kv.put(tokenKey(hash), JSON.stringify(session), options),
		kv.put(userKey(session.userId, session.id), reverse, options)
	]);
}

async function drop(kv: KvStore, userId: string, id: string, hash: string): Promise<void> {
	await Promise.all([kv.delete(tokenKey(hash)), kv.delete(userKey(userId, id))]);
}

async function entriesOf(kv: KvStore, userId: string): Promise<Entry[]> {
	const prefix = userPrefix(userId);
	const { keys } = await kv.list({ prefix });
	const found = await Promise.all(
		keys.map(async ({ name }): Promise<Entry | null> => {
			const entry = parseJson(reverseSchema, await kv.get(name));
			return entry ? { id: name.slice(prefix.length), ...entry } : null;
		})
	);
	return found.filter((entry): entry is Entry => entry !== null);
}

// #endregion

// #region lifecycle

export async function createSession(
	kv: KvStore,
	input: {
		userId: string;
		userAgent?: string | null;
		ip?: string | null;
		stepUpAt?: number;
	}
): Promise<IssuedSession> {
	const now = nowUtc().toMillis();
	const existing = (await entriesOf(kv, input.userId)).sort((a, b) => a.createdAt - b.createdAt);
	const excess = existing.length - (MAX_SESSIONS_PER_USER - 1);
	if (excess > 0) {
		await Promise.all(
			existing.slice(0, excess).map((entry) => drop(kv, input.userId, entry.id, entry.hash))
		);
	}
	const token = randomToken();
	const session: SessionRecord = {
		id: newId('ses'),
		userId: input.userId,
		createdAt: now,
		lastSeenAt: now,
		device: deviceLabel(input.userAgent),
		ip: truncateIp(input.ip)
	};
	if (input.stepUpAt !== undefined) session.stepUpAt = input.stepUpAt;
	await store(kv, await hashSessionToken(token), session, now);
	return { token, session };
}

// slides the idle window, but writes at most once per touch interval. A touch must not bring back
// a session that a revoke ended while it ran: the token record is written first, then the reverse
// record is checked, and a missing one means a revoke got in, so the token record is deleted again
export async function getSession(kv: KvStore, token: string): Promise<SessionRecord | null> {
	if (!TOKEN_PATTERN.test(token)) return null;
	const hash = await hashSessionToken(token);
	const session = parseJson(sessionSchema, await kv.get(tokenKey(hash)));
	if (!session) return null;
	const now = nowUtc().toMillis();
	if (!alive(session, now)) {
		await drop(kv, session.userId, session.id, hash);
		return null;
	}
	if (now - session.lastSeenAt < SESSION_TOUCH_MS) return session;
	const touched = { ...session, lastSeenAt: now };
	const options = { expirationTtl: ttlSeconds(touched, now) };
	await kv.put(tokenKey(hash), JSON.stringify(touched), options);
	const reverse = parseJson(reverseSchema, await kv.get(userKey(session.userId, session.id)));
	if (!reverse) {
		await kv.delete(tokenKey(hash));
		return null;
	}
	await kv.put(userKey(session.userId, session.id), JSON.stringify(reverse), options);
	return touched;
}

export async function listSessions(kv: KvStore, userId: string): Promise<SessionRecord[]> {
	const now = nowUtc().toMillis();
	const found = await Promise.all(
		(await entriesOf(kv, userId)).map(async (entry) => {
			const session = parseJson(sessionSchema, await kv.get(tokenKey(entry.hash)));
			if (session && alive(session, now)) return session;
			await drop(kv, userId, entry.id, entry.hash);
			return null;
		})
	);
	return found
		.filter((session): session is SessionRecord => session !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeSession(kv: KvStore, userId: string, id: string): Promise<boolean> {
	const entry = parseJson(reverseSchema, await kv.get(userKey(userId, id)));
	if (!entry) return false;
	await drop(kv, userId, id, entry.hash);
	return true;
}

export async function revokeSessionByToken(kv: KvStore, token: string): Promise<boolean> {
	if (!TOKEN_PATTERN.test(token)) return false;
	const hash = await hashSessionToken(token);
	const session = parseJson(sessionSchema, await kv.get(tokenKey(hash)));
	if (!session) return false;
	await drop(kv, session.userId, session.id, hash);
	return true;
}

// signs a person out everywhere, or everywhere but one session; returns how many it ended
export async function revokeAllSessions(
	kv: KvStore,
	userId: string,
	exceptId?: string
): Promise<number> {
	const doomed = (await entriesOf(kv, userId)).filter((entry) => entry.id !== exceptId);
	await Promise.all(doomed.map((entry) => drop(kv, userId, entry.id, entry.hash)));
	return doomed.length;
}

// a privilege change swaps the token and the id; the old pair stops working and the age is kept
export async function rotateSession(
	kv: KvStore,
	userId: string,
	id: string,
	patch: { stepUpAt?: number } = {}
): Promise<IssuedSession | null> {
	const entry = parseJson(reverseSchema, await kv.get(userKey(userId, id)));
	if (!entry) return null;
	const current = parseJson(sessionSchema, await kv.get(tokenKey(entry.hash)));
	const now = nowUtc().toMillis();
	if (!current || !alive(current, now)) {
		await drop(kv, userId, id, entry.hash);
		return null;
	}
	const token = randomToken();
	const session: SessionRecord = { ...current, id: newId('ses'), lastSeenAt: now, ...patch };
	await store(kv, await hashSessionToken(token), session, now);
	await drop(kv, userId, id, entry.hash);
	return { token, session };
}

// #endregion

// #region cookie

// the __host- prefix needs secure, path=/ and no domain
export function sessionCookieOptions(session: SessionRecord, now = nowUtc().toMillis()) {
	const remaining = session.createdAt + SESSION_ABSOLUTE_MS - now;
	return {
		httpOnly: true,
		secure: true,
		sameSite: 'lax' as const,
		path: '/',
		maxAge: Math.max(0, Math.floor(remaining / 1000))
	};
}

// #endregion
