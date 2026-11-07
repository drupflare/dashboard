import type { EventHandler } from 'h3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_ROOT, scanRoutes, type RouteEntry } from '../../../scripts/gen-openapi';
import codeRequest from '../../../src/server/api/v1/auth/code/request.post';
import codeVerify from '../../../src/server/api/v1/auth/code/verify.post';
import me from '../../../src/server/api/v1/me/index.get';
import sessionsGet from '../../../src/server/api/v1/me/sessions.get';
import { OAUTH_STATE_COOKIE } from '../../../src/server/integrations/oauth';
import {
	UrlGuardError,
	checkUrl,
	isPublicAddress
} from '../../../src/server/integrations/url-guard';
import { API_KEY_PREFIX, generateApiKey } from '../../../src/server/services/api-keys';
import { LINK_COOKIE } from '../../../src/server/services/identities';
import {
	SESSION_COOKIE_NAME,
	createSession,
	sessionCookieOptions
} from '../../../src/server/services/sessions';
import {
	createPrincipalResolver,
	kvKeyIndex,
	setAuthServices
} from '../../../src/server/utils/auth';
import { PLACEHOLDER_RATES, resetApiDeps } from '../../../src/server/utils/define-api';
import { LIMIT_CLASSES, ROUTE_CLASSES } from '../../../src/server/utils/rate-limit';
import { isSessionOnly, type Action } from '../../../src/shared/permissions';
import { facts, fresh } from '../domain/fixtures';
import { asKey, send as sendRoute, setup, type Reply } from '../server/fixtures/harness';
import { SECRET, harness, useClock, type Harness } from '../server/services/auth-support';

const routePattern = (route: RouteEntry) => route.path.replace(/\{([^}]+)\}/g, ':$1');
const requestPath = (route: RouteEntry) => route.path.replace(/\{([^}]+)\}/g, 'x');

afterEach(() => resetApiDeps());

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('audit writes', () => {
	it('pass the head store at every append, appendBoth and verify call in the server', () => {
		const root = join(process.cwd(), 'src/server');
		const callPattern = /(?<=\b(?:await|return) )(?:append|appendBoth|verify)\(/g;
		const found: string[] = [];
		for (const file of sourceFiles(root)) {
			if (file.endsWith(join('services', 'audit.ts'))) continue;
			const source = readFileSync(file, 'utf8');
			if (!/from '(?:\.\.\/services|\.)\/audit'/.test(source)) continue;
			for (const match of source.matchAll(callPattern)) {
				const rest = source.slice(match.index);
				const call = rest.slice(0, rest.indexOf(');') + 2);
				found.push(file);
				expect(call, `${file}: ${call}`).toContain('heads');
			}
		}
		expect(found.length).toBeGreaterThanOrEqual(3);
	});
});

describe('route table', () => {
	it('scans every route file without a problem', async () => {
		const { routes, problems } = await scanRoutes();
		expect(problems).toEqual([]);
		expect(routes.length).toBeGreaterThan(0);
	});

	it('names the dynamic segment of a path once, so the router can tell routes apart', () => {
		const clashes: string[] = [];
		const walk = (dir: string) => {
			const entries = readdirSync(dir, { withFileTypes: true });
			const dynamic = entries.filter((e) => e.isDirectory() && /^\[.+\]$/.test(e.name));
			if (dynamic.length > 1)
				clashes.push(`${dir}: ${dynamic.map((e) => e.name).join(', ')}`);
			for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name));
		};
		walk(API_ROOT);
		expect(clashes).toEqual([]);
	});

	it('gives every route a rate class that has a rule', async () => {
		const { routes } = await scanRoutes();
		expect(Object.keys(PLACEHOLDER_RATES).sort()).toEqual([...LIMIT_CLASSES].sort());
		for (const route of routes) {
			expect(ROUTE_CLASSES, route.rel).toContain(route.meta.rateClass);
		}
	});

	it('lets only the OAuth hops use GET with a write class', async () => {
		const { routes } = await scanRoutes();
		const odd = routes
			.filter((route) => route.method === 'get' && route.meta.rateClass !== 'read')
			.map((route) => route.rel)
			.sort();
		expect(odd).toEqual([
			'v1/auth/oauth/[provider]/callback.get.ts',
			'v1/auth/oauth/[provider]/start.get.ts',
			'v1/me/identities/connect/[provider]/callback.get.ts'
		]);
	});

	it('puts every state-changing method on a route that is not read class', async () => {
		const { routes } = await scanRoutes();
		for (const route of routes.filter((entry) => entry.method !== 'get')) {
			expect(route.meta.rateClass, route.rel).not.toBe('read');
		}
	});

	it('refuses an API key on every session-only route before anything loads', async () => {
		const { routes } = await scanRoutes();
		const sessionOnly = routes.filter(
			(route) => route.meta.scope !== 'public' && isSessionOnly(route.meta.action as Action)
		);
		expect(sessionOnly.length).toBeGreaterThan(0);
		for (const route of sessionOnly) {
			const { loads, audits } = setup();
			const handler = ((await import(join(API_ROOT, route.rel))) as { default: never })
				.default;
			const reply = await sendRoute(handler, routePattern(route), {
				method: route.method,
				path: requestPath(route),
				headers: { ...asKey, 'idempotency-key': 'key-12345678' }
			});
			expect(reply.status, `${route.method} ${route.path}`).toBe(403);
			expect(loads, route.rel).toEqual([]);
			expect(audits, route.rel).toEqual([]);
		}
	});
});

describe('cookies', () => {
	it('uses the __Host- prefix on every cookie the server sets', () => {
		for (const name of [SESSION_COOKIE_NAME, OAUTH_STATE_COOKIE, LINK_COOKIE]) {
			expect(name.startsWith('__Host-')).toBe(true);
		}
	});

	it('sets the session cookie secure, http-only, lax, rooted and host-only', async () => {
		const clock = useClock();
		try {
			const { session } = await createSession(harness().kv, { userId: 'user-1' });
			const options = sessionCookieOptions(session, clock.now);
			expect(options).toMatchObject({
				httpOnly: true,
				secure: true,
				sameSite: 'lax',
				path: '/'
			});
			expect(options).not.toHaveProperty('domain');
		} finally {
			clock.stop();
		}
	});
});

describe('secrets stay out of replies, cookies, audit rows and storage', () => {
	let clock: ReturnType<typeof useClock>;
	let h: Harness;

	beforeEach(() => {
		clock = useClock();
		h = harness();
		setAuthServices({ ...h, keys: kvKeyIndex(h.kv) });
		setup({
			deps: { resolvePrincipal: createPrincipalResolver() },
			facts: (input) =>
				facts({
					...fresh,
					...(input.principal.kind === 'key'
						? { key: { id: input.principal.keyId, scopes: ['account.read'] } }
						: {})
				})
		});
	});

	afterEach(() => {
		clock.stop();
		setAuthServices(null);
	});

	const call = (handler: EventHandler, path: string, req: Parameters<typeof sendRoute>[2]) =>
		sendRoute(handler, path, req);

	it('keeps the code, token, key secret and server secret out of every reply', async () => {
		const replies: Reply[] = [];
		const asked = await call(codeRequest, '/api/v1/auth/code/request', {
			method: 'POST',
			path: '/api/v1/auth/code/request',
			json: { email: 'ada@example.com', turnstileToken: 'tok' }
		});
		replies.push(asked);
		const code = h.mail.lastCode();
		const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
		replies.push(
			await call(codeVerify, '/api/v1/auth/code/verify', {
				method: 'POST',
				path: '/api/v1/auth/code/verify',
				json: { email: 'ada@example.com', code: wrong }
			})
		);
		const verified = await call(codeVerify, '/api/v1/auth/code/verify', {
			method: 'POST',
			path: '/api/v1/auth/code/verify',
			json: { email: 'ada@example.com', code }
		});
		replies.push(verified);
		const cookie = verified.headers
			.getSetCookie()
			.find((line) => line.startsWith(`${SESSION_COOKIE_NAME}=`)) as string;
		const token = cookie.slice(SESSION_COOKIE_NAME.length + 1).split(';')[0] as string;
		const userId = (verified.json as { user: { id: string } }).user.id;

		const key = await generateApiKey({
			scopes: ['account.read'],
			expiry: '30d',
			now: clock.now
		});
		await kvKeyIndex(h.kv).put(key.data.lookupId, {
			keyId: 'key-1',
			issuerId: userId,
			orgId: 'org-1',
			keyHash: key.data.keyHash,
			expiresAt: key.data.expiresAt
		});
		const secret = key.token.slice(key.token.indexOf('_', API_KEY_PREFIX.length) + 1);
		const asSession = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
		const asApiKey = { authorization: `Bearer ${key.token}` };
		const flipped = key.token.endsWith('A') ? 'B' : 'A';
		const tampered = { authorization: `Bearer ${key.token.slice(0, -1)}${flipped}` };
		replies.push(await call(me, '/api/v1/me', { path: '/api/v1/me', headers: asSession }));
		replies.push(await call(me, '/api/v1/me', { path: '/api/v1/me', headers: asApiKey }));
		replies.push(await call(me, '/api/v1/me', { path: '/api/v1/me', headers: tampered }));
		replies.push(
			await call(me, '/api/v1/me', {
				path: '/api/v1/me',
				headers: { cookie: `${SESSION_COOKIE_NAME}=${'A'.repeat(43)}` }
			})
		);
		replies.push(
			await call(sessionsGet, '/api/v1/me/sessions', {
				path: '/api/v1/me/sessions',
				headers: asApiKey
			})
		);
		replies.push(
			await call(codeRequest, '/api/v1/auth/code/request', {
				method: 'POST',
				path: '/api/v1/auth/code/request',
				json: { email: 'not-an-address' }
			})
		);

		const statuses = replies.map((reply) => reply.status);
		expect(statuses).toEqual([202, 401, 200, 200, 200, 401, 401, 403, 400]);

		const secrets = [code, token, key.token, secret, SECRET];
		for (const reply of replies) {
			const headers = [...reply.headers].filter(([name]) => name !== 'set-cookie');
			const seen = JSON.stringify({ text: reply.text, headers });
			for (const value of secrets) expect(seen).not.toContain(value);
		}
		const withCookie = replies.filter((reply) => reply.headers.getSetCookie().length > 0);
		expect(withCookie).toEqual([verified]);
		const stored = JSON.stringify([h.directory.audits, h.directory.users, h.directory.orgs]);
		for (const value of secrets) expect(stored).not.toContain(value);
		expect(Object.keys(h.kv.dump()).join('\n')).not.toContain(token);
	});

	it('sets only __Host- cookies, each secure, http-only, rooted and without a domain', async () => {
		const replies: Reply[] = [];
		await call(codeRequest, '/api/v1/auth/code/request', {
			method: 'POST',
			path: '/api/v1/auth/code/request',
			json: { email: 'ada@example.com', turnstileToken: 'tok' }
		});
		replies.push(
			await call(codeVerify, '/api/v1/auth/code/verify', {
				method: 'POST',
				path: '/api/v1/auth/code/verify',
				json: { email: 'ada@example.com', code: h.mail.lastCode() }
			})
		);
		const lines = replies.flatMap((reply) => reply.headers.getSetCookie());
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line.startsWith('__Host-'), line).toBe(true);
			expect(line).toMatch(/;\s*Secure/i);
			expect(line).toMatch(/;\s*HttpOnly/i);
			expect(line).toMatch(/;\s*Path=\//i);
			expect(line).not.toMatch(/;\s*Domain=/i);
		}
	});
});

describe('url guard', () => {
	const PRIVATE_V4 = [
		[127, 0, 0, 1],
		[10, 0, 0, 1],
		[172, 16, 0, 1],
		[192, 168, 1, 1],
		[169, 254, 169, 254],
		[100, 64, 0, 1]
	] as const;

	const encodings = ([a, b, c, d]: readonly [number, number, number, number]) => {
		const whole = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
		return [
			`${a}.${b}.${c}.${d}`,
			String(whole),
			`0x${whole.toString(16)}`,
			[a, b, c, d].map((part) => `0x${part.toString(16)}`).join('.'),
			[a, b, c, d].map((part) => `0${part.toString(8)}`).join('.')
		];
	};

	it('rejects every private IPv4 address in every spelling the URL parser folds together', () => {
		for (const octets of PRIVATE_V4) {
			for (const host of encodings(octets)) {
				for (const scheme of ['http', 'https']) {
					const thrown = (() => {
						try {
							checkUrl(`${scheme}://${host}/`);
							return null;
						} catch (error) {
							return error;
						}
					})();
					expect(thrown, `${scheme}://${host}/`).toBeInstanceOf(UrlGuardError);
				}
			}
		}
	});

	it('rejects the same addresses when a resolver returns them, including IPv4-mapped IPv6', () => {
		for (const [a, b, c, d] of PRIVATE_V4) {
			expect(isPublicAddress(`${a}.${b}.${c}.${d}`)).toBe(false);
			expect(isPublicAddress(`::ffff:${a}.${b}.${c}.${d}`)).toBe(false);
			const hi = ((a << 8) | b).toString(16);
			const lo = ((c << 8) | d).toString(16);
			expect(isPublicAddress(`::ffff:${hi}:${lo}`)).toBe(false);
		}
	});
});
