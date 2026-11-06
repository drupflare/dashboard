import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	MAX_SESSIONS_PER_USER,
	SESSION_ABSOLUTE_MS,
	SESSION_COOKIE_NAME,
	SESSION_IDLE_MS,
	SESSION_TOUCH_MS,
	createSession,
	deviceLabel,
	getSession,
	hashSessionToken,
	listSessions,
	revokeAllSessions,
	revokeSession,
	revokeSessionByToken,
	rotateSession,
	sessionCookieOptions,
	truncateIp
} from '../../../../src/server/services/sessions';
import { T0, memoryKv, useClock, type MemoryKv } from './auth-support';

let clock: ReturnType<typeof useClock>;
beforeEach(() => {
	clock = useClock();
});
afterEach(() => clock.stop());

const CHROME_MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// every forward record has a reverse key that points back, and every reverse key a forward record
async function expectConsistent(kv: MemoryKv): Promise<void> {
	const dump = kv.dump();
	const forward = Object.entries(dump).filter(([key]) => key.startsWith('session:token:'));
	const reverse = Object.entries(dump).filter(([key]) => key.startsWith('session:user:'));
	expect(forward.length).toBe(reverse.length);
	for (const [key, value] of forward) {
		const session = JSON.parse(value) as { id: string; userId: string };
		const back = dump[`session:user:${session.userId}:${session.id}`];
		expect(back, `reverse key for ${key}`).toBeDefined();
		expect((JSON.parse(back as string) as { hash: string }).hash).toBe(
			key.slice('session:token:'.length)
		);
	}
	for (const [key, value] of reverse) {
		const { hash } = JSON.parse(value) as { hash: string };
		const record = dump[`session:token:${hash}`];
		expect(record, `forward record for ${key}`).toBeDefined();
		const session = JSON.parse(record as string) as { id: string; userId: string };
		expect(key).toBe(`session:user:${session.userId}:${session.id}`);
	}
}

describe('createSession', () => {
	it('stores only a hash of the token, never the token', async () => {
		const kv = memoryKv();
		const { token, session } = await createSession(kv, { userId: 'u1' });
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const everything = JSON.stringify({ keys: kv.keys(), values: kv.dump() });
		expect(everything).not.toContain(token);
		expect(kv.keys()).toContain(`session:token:${await hashSessionToken(token)}`);
		expect(JSON.stringify(session)).not.toContain(token);
	});

	it('makes a different token every time', async () => {
		const kv = memoryKv();
		const tokens = new Set<string>();
		for (let i = 0; i < 4; i++) tokens.add((await createSession(kv, { userId: 'u1' })).token);
		expect(tokens.size).toBe(4);
	});

	it('records a coarse device label and a truncated address, never the raw ones', async () => {
		const kv = memoryKv();
		const { session } = await createSession(kv, {
			userId: 'u1',
			userAgent: CHROME_MAC,
			ip: '203.0.113.77'
		});
		expect(session.device).toBe('Chrome on macOS');
		expect(session.ip).toBe('203.0.113.0/24');
		const everything = JSON.stringify(kv.dump());
		expect(everything).not.toContain('203.0.113.77');
		expect(everything).not.toContain('537.36');
	});

	it('evicts the oldest session at the cap and keeps both indexes consistent', async () => {
		const kv = memoryKv();
		const issued = [];
		for (let i = 0; i < MAX_SESSIONS_PER_USER + 2; i++) {
			issued.push(await createSession(kv, { userId: 'u1' }));
			clock.advance(1000);
			await expectConsistent(kv);
		}
		const live = await listSessions(kv, 'u1');
		expect(live).toHaveLength(MAX_SESSIONS_PER_USER);
		expect(live.map((s) => s.id)).toEqual(
			issued
				.slice(2)
				.reverse()
				.map((i) => i.session.id)
		);
		expect(await getSession(kv, issued[0]!.token)).toBeNull();
		expect(await getSession(kv, issued[1]!.token)).toBeNull();
		expect(await getSession(kv, issued[2]!.token)).not.toBeNull();
	});

	it('counts the cap per user', async () => {
		const kv = memoryKv();
		for (let i = 0; i < MAX_SESSIONS_PER_USER; i++) {
			await createSession(kv, { userId: 'u1' });
			clock.advance(1000);
		}
		await createSession(kv, { userId: 'u2' });
		expect(await listSessions(kv, 'u1')).toHaveLength(MAX_SESSIONS_PER_USER);
		expect(await listSessions(kv, 'u2')).toHaveLength(1);
	});
});

describe('getSession', () => {
	it('resolves a live token and nothing else', async () => {
		const kv = memoryKv();
		const { token, session } = await createSession(kv, { userId: 'u1' });
		expect((await getSession(kv, token))?.id).toBe(session.id);
		expect(await getSession(kv, 'x'.repeat(43))).toBeNull();
		expect(await getSession(kv, 'not a token')).toBeNull();
		expect(await getSession(kv, '')).toBeNull();
	});

	it('slides the idle window when the session is used', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'u1' });
		const day = 24 * 60 * 60 * 1000;
		for (const step of [10, 10, 9]) {
			clock.advance(step * day);
			expect((await getSession(kv, token))?.lastSeenAt).toBe(clock.now);
		}
		expect(clock.now - T0).toBeGreaterThan(SESSION_IDLE_MS * 2);
		await expectConsistent(kv);
	});

	it('expires after the idle lifetime with no use', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'u1' });
		clock.advance(SESSION_IDLE_MS - 1000);
		expect(await getSession(kv, token)).not.toBeNull();
		clock.advance(SESSION_IDLE_MS);
		expect(await getSession(kv, token)).toBeNull();
		await expectConsistent(kv);
	});

	it('expires at the absolute lifetime however often it is used', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'u1' });
		const day = 24 * 60 * 60 * 1000;
		const start = clock.now;
		let last = true;
		while (clock.now - start < SESSION_ABSOLUTE_MS + 2 * day) {
			clock.advance(day);
			last = (await getSession(kv, token)) !== null;
			expect(last).toBe(clock.now - start < SESSION_ABSOLUTE_MS);
		}
		expect(last).toBe(false);
		await expectConsistent(kv);
	});

	it('writes at most once per touch interval', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'u1' });
		const before = kv.puts.length;
		clock.advance(SESSION_TOUCH_MS - 1);
		await getSession(kv, token);
		await getSession(kv, token);
		expect(kv.puts.length).toBe(before);
		clock.advance(2);
		const touched = await getSession(kv, token);
		expect(kv.puts.length).toBe(before + 2);
		expect(touched?.lastSeenAt).toBe(clock.now);
		await expectConsistent(kv);
	});

	it('never asks KV for a ttl under the 60 second floor', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'u1' });
		clock.advance(SESSION_ABSOLUTE_MS - 5000);
		await getSession(kv, token);
		for (const put of kv.puts) expect(put.ttl).toBeGreaterThanOrEqual(60);
	});
});

describe('revoke', () => {
	it('revokes one session by id and leaves the rest', async () => {
		const kv = memoryKv();
		const a = await createSession(kv, { userId: 'u1' });
		clock.advance(1000);
		const b = await createSession(kv, { userId: 'u1' });
		expect(await revokeSession(kv, 'u1', a.session.id)).toBe(true);
		expect(await getSession(kv, a.token)).toBeNull();
		expect(await getSession(kv, b.token)).not.toBeNull();
		expect(await revokeSession(kv, 'u1', a.session.id)).toBe(false);
		await expectConsistent(kv);
	});

	it('does not let one user revoke another user session by id', async () => {
		const kv = memoryKv();
		const a = await createSession(kv, { userId: 'u1' });
		expect(await revokeSession(kv, 'u2', a.session.id)).toBe(false);
		expect(await getSession(kv, a.token)).not.toBeNull();
	});

	it('revokes by token', async () => {
		const kv = memoryKv();
		const a = await createSession(kv, { userId: 'u1' });
		expect(await revokeSessionByToken(kv, a.token)).toBe(true);
		expect(await getSession(kv, a.token)).toBeNull();
		expect(await revokeSessionByToken(kv, a.token)).toBe(false);
		expect(await revokeSessionByToken(kv, 'garbage')).toBe(false);
		expect(kv.keys()).toEqual([]);
	});

	it('revokes all but the current session', async () => {
		const kv = memoryKv();
		const sessions = [];
		for (let i = 0; i < 3; i++) {
			sessions.push(await createSession(kv, { userId: 'u1' }));
			clock.advance(1000);
		}
		const other = await createSession(kv, { userId: 'u2' });
		expect(await revokeAllSessions(kv, 'u1', sessions[1]!.session.id)).toBe(2);
		expect(await getSession(kv, sessions[1]!.token)).not.toBeNull();
		expect(await getSession(kv, sessions[0]!.token)).toBeNull();
		expect(await getSession(kv, sessions[2]!.token)).toBeNull();
		expect(await getSession(kv, other.token)).not.toBeNull();
		await expectConsistent(kv);
	});

	it('revokes everything when no session is excepted', async () => {
		const kv = memoryKv();
		await createSession(kv, { userId: 'u1' });
		clock.advance(1000);
		await createSession(kv, { userId: 'u1' });
		expect(await revokeAllSessions(kv, 'u1')).toBe(2);
		expect(kv.keys()).toEqual([]);
	});
});

describe('rotateSession', () => {
	it('swaps the token and the id and ends the old pair', async () => {
		const kv = memoryKv();
		const old = await createSession(kv, { userId: 'u1', userAgent: CHROME_MAC });
		clock.advance(60_000);
		const next = await rotateSession(kv, 'u1', old.session.id, { stepUpAt: clock.now });
		expect(next).not.toBeNull();
		expect(next!.token).not.toBe(old.token);
		expect(next!.session.id).not.toBe(old.session.id);
		expect(await getSession(kv, old.token)).toBeNull();
		expect((await getSession(kv, next!.token))?.stepUpAt).toBe(clock.now);
		expect(await revokeSession(kv, 'u1', old.session.id)).toBe(false);
		expect(await listSessions(kv, 'u1')).toHaveLength(1);
		await expectConsistent(kv);
	});

	it('keeps the session age, so rotation cannot extend the absolute lifetime', async () => {
		const kv = memoryKv();
		const old = await createSession(kv, { userId: 'u1' });
		const day = 24 * 60 * 60 * 1000;
		for (let i = 0; i < 2; i++) {
			clock.advance(10 * day);
			await getSession(kv, old.token);
		}
		clock.advance(10 * day - 1000);
		const next = await rotateSession(kv, 'u1', old.session.id);
		expect(next!.session.createdAt).toBe(old.session.createdAt);
		expect(next!.session.device).toBe(old.session.device);
		clock.advance(2000);
		expect(await getSession(kv, next!.token)).toBeNull();
	});

	it('returns null for a session that is gone, and stores nothing', async () => {
		const kv = memoryKv();
		const old = await createSession(kv, { userId: 'u1' });
		await revokeSession(kv, 'u1', old.session.id);
		expect(await rotateSession(kv, 'u1', old.session.id)).toBeNull();
		expect(await rotateSession(kv, 'u2', 'ses_missing')).toBeNull();
		expect(kv.keys()).toEqual([]);
	});

	it('returns null for an expired session', async () => {
		const kv = memoryKv();
		const old = await createSession(kv, { userId: 'u1' });
		clock.advance(SESSION_IDLE_MS + 1000);
		expect(await rotateSession(kv, 'u1', old.session.id)).toBeNull();
	});
});

describe('listSessions', () => {
	it('lists newest first and drops stale reverse entries', async () => {
		const kv = memoryKv();
		const a = await createSession(kv, { userId: 'u1' });
		clock.advance(1000);
		const b = await createSession(kv, { userId: 'u1' });
		const hash = await hashSessionToken(a.token);
		await kv.delete(`session:token:${hash}`);
		expect((await listSessions(kv, 'u1')).map((s) => s.id)).toEqual([b.session.id]);
		await expectConsistent(kv);
	});
});

describe('touch', () => {
	it('refreshes both records with the new idle window and keeps them consistent', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'user-1' });
		clock.advance(SESSION_TOUCH_MS + 1000);
		const touched = await getSession(kv, token);
		expect(touched?.lastSeenAt).toBe(clock.now);
		await expectConsistent(kv);
		const ttls = kv.puts.slice(-2).map((put) => put.ttl);
		expect(ttls[0]).toBe(ttls[1]);
		expect(ttls[0]).toBe(Math.ceil(SESSION_IDLE_MS / 1000));
	});

	it('leaves no record behind when a revoke removed the reverse record mid-touch', async () => {
		const kv = memoryKv();
		const { token, session } = await createSession(kv, { userId: 'user-1' });
		clock.advance(SESSION_TOUCH_MS + 1000);
		const racing: MemoryKv = {
			...kv,
			async get(key) {
				const value = await kv.get(key);
				if (key.startsWith('session:token:')) await revokeSession(kv, 'user-1', session.id);
				return value;
			}
		};
		expect(await getSession(racing, token)).toBeNull();
		expect(kv.keys()).toEqual([]);
	});

	it('writes nothing for a read inside the touch interval', async () => {
		const kv = memoryKv();
		const { token } = await createSession(kv, { userId: 'user-1' });
		const writes = kv.puts.length;
		clock.advance(SESSION_TOUCH_MS - 1);
		await getSession(kv, token);
		expect(kv.puts).toHaveLength(writes);
	});
});

describe('device label and address', () => {
	it.each([
		[CHROME_MAC, 'Chrome on macOS'],
		[
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
			'Safari on iOS'
		],
		[
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
			'Edge on Windows'
		],
		[
			'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
			'Chrome on Android'
		],
		[
			'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
			'Firefox on Linux'
		],
		['curl/8.4.0', 'Unknown device'],
		['', 'Unknown device'],
		[undefined, 'Unknown device'],
		[null, 'Unknown device']
	])('labels %s as %s', (userAgent, label) => {
		expect(deviceLabel(userAgent)).toBe(label);
	});

	it.each([
		['203.0.113.77', '203.0.113.0/24'],
		['::ffff:198.51.100.9', '198.51.100.0/24'],
		['2001:db8:85a3:8d3:1319:8a2e:370:7344', '2001:db8:85a3:8d3::/64'],
		['2001:db8::1', '2001:db8:0:0::/64'],
		['::1', '0:0:0:0::/64'],
		['not an ip', null],
		['1.2.3', null],
		['', null],
		[undefined, null]
	])('truncates %s to %s', (ip, truncated) => {
		expect(truncateIp(ip)).toBe(truncated);
	});
});

describe('cookie', () => {
	it('is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain', async () => {
		expect(SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
		const { session } = await createSession(memoryKv(), { userId: 'u1' });
		const options = sessionCookieOptions(session);
		expect(options).toEqual({
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			path: '/',
			maxAge: SESSION_ABSOLUTE_MS / 1000
		});
		expect(options).not.toHaveProperty('domain');
	});

	it('shrinks the max age as the session ages and never goes negative', async () => {
		const { session } = await createSession(memoryKv(), { userId: 'u1' });
		expect(sessionCookieOptions(session, session.createdAt + 1000_000).maxAge).toBe(
			SESSION_ABSOLUTE_MS / 1000 - 1000
		);
		expect(
			sessionCookieOptions(session, session.createdAt + SESSION_ABSOLUTE_MS * 2).maxAge
		).toBe(0);
	});
});
