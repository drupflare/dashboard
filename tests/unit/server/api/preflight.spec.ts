import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import preflight from '../../../../src/server/api/v1/preflight.post';
import {
	PREFLIGHT_LIMITS,
	resetPreflightServices,
	runPreflight,
	setPreflightServices
} from '../../../../src/server/services/preflight';
import {
	memoryLimiter,
	PLACEHOLDER_RATES,
	resetApiDeps
} from '../../../../src/server/utils/define-api';
import { PREFLIGHT_FAILURES, PREFLIGHT_REFUSALS } from '../../../../src/shared/preflight';
import { send as sendRequest, setup } from '../fixtures/harness';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

const PUBLIC = ['93.184.216.34'];
const calls: Array<{ url: string; init: RequestInit }> = [];
let resolved: Record<string, string[]> = {};

function install(routes: Record<string, Route>, now: () => number = Date.now) {
	setPreflightServices({
		fetch: async (url, init) => {
			calls.push({ url, init });
			const route = routes[url];
			if (!route) throw new Error(`no route for ${url}`);
			return route(url, init);
		},
		resolve: async (host) => resolved[host] ?? PUBLIC,
		now
	});
}

const html = (body: string, headers: Record<string, string> = {}, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
const redirect = (location: string, status = 301) =>
	new Response(null, { status, headers: { location } });
const text = (body: string, status = 200) =>
	new Response(body, { status, headers: { 'content-type': 'text/plain' } });

const D11 = html(
	'<head><meta name="generator" content="Drupal 11 (https://www.drupal.org)"></head>',
	{
		'x-generator': 'Drupal 11 (https://www.drupal.org)'
	}
);
const PLAIN = '<html><head><title>Home</title></head></html>';

const ROUTE = '/api/v1/preflight';
const post = (json: unknown, headers: Record<string, string> = {}) =>
	sendRequest(preflight, ROUTE, { method: 'POST', path: ROUTE, json, headers });

type Result = {
	url: string;
	reachable: boolean;
	cms: string;
	version: string | null;
	verdict: string;
	hosting: string | null;
	signals: Array<{ kind: string; detail: string }>;
	notes: string[];
};

beforeEach(() => {
	calls.length = 0;
	resolved = {};
	setup();
});

afterEach(() => {
	resetPreflightServices();
	resetApiDeps();
	vi.useRealTimers();
});

describe('POST /api/v1/preflight: a read', () => {
	it('reads a Drupal 11 home page and its changelog, and says what was seen', async () => {
		install({
			'https://example.edu/': () => D11.clone(),
			'https://example.edu/core/CHANGELOG.txt': () => text('Drupal 11.0.1, 2024-08-02\n---\n')
		});
		const reply = await post({ url: 'https://example.edu/' });
		expect(reply.status).toBe(200);
		const body = reply.json as Result;
		expect(body).toMatchObject({
			url: 'https://example.edu/',
			reachable: true,
			cms: 'drupal',
			version: '11.0.1',
			verdict: 'candidate',
			hosting: null
		});
		expect(body.signals.map((s) => s.kind)).toEqual(
			expect.arrayContaining(['header', 'markup', 'file'])
		);
		expect(JSON.stringify(body).toLowerCase()).not.toContain('compatible');
		expect(calls.map((c) => c.url)).toEqual([
			'https://example.edu/',
			'https://example.edu/core/CHANGELOG.txt'
		]);
	});

	it('sends a User-Agent that names Drupflare and an Accept header, and nothing from the caller', async () => {
		install({ 'https://example.edu/': () => html(PLAIN) });
		await post(
			{ url: 'https://example.edu/' },
			{ cookie: 'session=token-a', authorization: 'Bearer dfk_key1', 'x-trace': '1' }
		);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			const headers = new Headers(call.init.headers);
			expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent']);
			expect(headers.get('user-agent')).toBe(
				'Drupflare-Preflight/1 (+https://app.drupflare.com/migrate/preflight; support@drupflare.com)'
			);
			expect(call.init.redirect).toBe('manual');
		}
	});

	it('asks for the three follow-up files in order when the home page names nothing', async () => {
		install({
			'https://example.edu/': () => html(PLAIN),
			'https://example.edu/core/CHANGELOG.txt': () => text('nope', 404),
			'https://example.edu/CHANGELOG.txt': () => text('nope', 404),
			'https://example.edu/robots.txt': () =>
				text('User-agent: *\nDisallow: /core/\nDisallow: /profiles/\n')
		});
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
			'/',
			'/core/CHANGELOG.txt',
			'/CHANGELOG.txt',
			'/robots.txt'
		]);
		expect(body).toMatchObject({ cms: 'unknown', verdict: 'cannot tell' });
		expect(body.signals.map((s) => s.kind)).toContain('robots');
	});

	it('reads a changelog that is far larger than the cap from its first bytes', async () => {
		install({
			'https://example.edu/': () => html(PLAIN),
			'https://example.edu/core/CHANGELOG.txt': () =>
				text(`Drupal 10.3.1, 2024-07-17\n${'x'.repeat(500_000)}`)
		});
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body).toMatchObject({ version: '10.3.1', verdict: 'needs upgrade' });
	});

	it('ignores a follow-up that redirects, and one that fails', async () => {
		install({
			'https://example.edu/': () => html(PLAIN),
			'https://example.edu/core/CHANGELOG.txt': () => redirect('/login'),
			'https://example.edu/CHANGELOG.txt': () => {
				throw new Error('reset');
			},
			'https://example.edu/robots.txt': () => text('User-agent: *\n')
		});
		const reply = await post({ url: 'https://example.edu/' });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ verdict: 'cannot tell', reachable: true });
	});

	it('does not ask for more files when the site blocks the request or runs WordPress', async () => {
		install({
			'https://blocked.example/': () => html('', { 'cf-mitigated': 'challenge' }, 403),
			'https://wp.example/': () => html('<meta name="generator" content="WordPress 6.5">')
		});
		const blocked = (await post({ url: 'https://blocked.example/' })).json as Result;
		const wp = (await post({ url: 'https://wp.example/' })).json as Result;
		expect(blocked.notes[0]).toContain('refused the request');
		expect(wp).toMatchObject({ cms: 'wordpress', verdict: 'not yet supported' });
		expect(calls).toHaveLength(2);
	});

	it('skips the follow-ups when the time budget is spent', async () => {
		let tick = 0;
		install({ 'https://example.edu/': () => html(PLAIN) }, () => (tick += 14_900));
		const reply = await post({ url: 'https://example.edu/' });
		expect(reply.status).toBe(200);
		expect(calls).toHaveLength(1);
	});

	it('still reads the follow-ups after a home page at the size cap, inside the total budget', async () => {
		const page = `${PLAIN}${' '.repeat(PREFLIGHT_LIMITS.homeBytes - PLAIN.length)}`;
		expect(page.length).toBe(PREFLIGHT_LIMITS.homeBytes);
		install({
			'https://example.edu/': () => html(page),
			'https://example.edu/core/CHANGELOG.txt': () => text('x', 404),
			'https://example.edu/CHANGELOG.txt': () => text('x', 404),
			'https://example.edu/robots.txt': () => text('x', 404)
		});
		await post({ url: 'https://example.edu/' });
		expect(calls).toHaveLength(4);
		expect(PREFLIGHT_LIMITS.homeBytes + 3 * PREFLIGHT_LIMITS.followBytes).toBeLessThanOrEqual(
			PREFLIGHT_LIMITS.totalBytes
		);
	});
});

describe('POST /api/v1/preflight: redirects', () => {
	it('follows a move to the www name and says so', async () => {
		install({
			'http://example.edu/': () => redirect('https://www.example.edu/'),
			'https://www.example.edu/': () => D11.clone(),
			'https://www.example.edu/core/CHANGELOG.txt': () => text('', 404)
		});
		const body = (await post({ url: 'http://example.edu/' })).json as Result;
		expect(body.url).toBe('https://www.example.edu/');
		expect(body.signals).toContainEqual({
			kind: 'redirect',
			detail: 'The address redirects to https://www.example.edu/.'
		});
	});

	it('stops at a redirect to another domain, records it and reads nothing else', async () => {
		install({
			'https://example.edu/': () =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://other.example/', 'x-generator': 'Drupal 11 (x)' }
				})
		});
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body.reachable).toBe(true);
		expect(body.signals).toContainEqual({
			kind: 'redirect',
			detail: 'The address redirects to other.example, a different domain. The check stopped there.'
		});
		expect(calls).toHaveLength(1);
	});

	it('reports too many redirects as a failure', async () => {
		const hop =
			(n: number): Route =>
			() =>
				redirect(`/${n + 1}`);
		install({
			'https://example.edu/': hop(0),
			'https://example.edu/1': hop(1),
			'https://example.edu/2': hop(2),
			'https://example.edu/3': hop(3)
		});
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body).toMatchObject({
			reachable: false,
			notes: [PREFLIGHT_FAILURES.redirect_limit]
		});
	});

	it('reports a redirect to a port the check will not read as a failure', async () => {
		install({ 'https://example.edu/': () => redirect('https://example.edu:8443/') });
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body).toMatchObject({
			reachable: false,
			notes: [PREFLIGHT_FAILURES.redirect_refused]
		});
	});

	it('reports a same-site redirect that lands on a private address as a failure', async () => {
		resolved = { 'www.example.edu': ['10.0.0.4'] };
		install({ 'https://example.edu/': () => redirect('https://www.example.edu/') });
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body.notes).toEqual([PREFLIGHT_FAILURES.redirect_refused]);
	});
});

describe('POST /api/v1/preflight: refusals and failures', () => {
	it.each([
		['not a url', 'invalid_url'],
		['http://user:pw@example.edu/', 'invalid_url'],
		['ftp://example.edu/', 'protocol'],
		['https://example.edu:8443/', 'port'],
		['http://127.0.0.1/', 'ip_literal'],
		['http://[::1]/', 'ip_literal'],
		['http://localhost/', 'non_public_address'],
		['http://db.internal/', 'non_public_address']
	])('refuses %s before any request', async (url, reason) => {
		install({});
		const reply = await post({ url });
		expect(reply.status).toBe(422);
		const error = reply.json as { code: string; message: string; details: { reason: string } };
		expect(error.details.reason).toBe(reason);
		expect(error.message).toBe(PREFLIGHT_REFUSALS[reason as keyof typeof PREFLIGHT_REFUSALS]);
		expect(error.message).not.toMatch(/_|guard|resolve/i);
		expect(calls).toHaveLength(0);
	});

	it('refuses a name that resolves to a private address', async () => {
		resolved = { 'sneaky.example': ['192.168.1.5'] };
		install({});
		const reply = await post({ url: 'https://sneaky.example/' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'non_public_address' } });
		expect(calls).toHaveLength(0);
	});

	it('answers a name that does not resolve with an unreachable result', async () => {
		resolved = { 'nothing.example': [] };
		install({});
		const reply = await post({ url: 'https://nothing.example/' });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			reachable: false,
			cms: 'unknown',
			verdict: 'cannot tell',
			signals: [],
			notes: [PREFLIGHT_FAILURES.unresolvable]
		});
	});

	it('answers a page above the size cap with an unreachable result', async () => {
		install({
			'https://example.edu/': () => html('x'.repeat(PREFLIGHT_LIMITS.homeBytes + 1))
		});
		const body = (await post({ url: 'https://example.edu/' })).json as Result;
		expect(body).toMatchObject({ reachable: false, notes: [PREFLIGHT_FAILURES.too_large] });
	});

	it('answers a site that never replies with an unreachable result once the time is up', async () => {
		vi.useFakeTimers();
		install({ 'https://example.edu/': () => new Response(new ReadableStream({ start() {} })) });
		const pending = post({ url: 'https://example.edu/' });
		await vi.advanceTimersByTimeAsync(PREFLIGHT_LIMITS.homeMs + 100);
		const reply = await pending;
		expect(reply.json).toMatchObject({ reachable: false, notes: [PREFLIGHT_FAILURES.timeout] });
	});

	it('rethrows an error that is not a guard error', async () => {
		install({
			'https://example.edu/': () => {
				throw new Error('boom');
			}
		});
		await expect(
			runPreflight({ ...installedServices(), now: Date.now }, 'https://example.edu/')
		).rejects.toThrow();
	});

	it('takes only a strict body with a url', async () => {
		install({});
		expect((await post({ url: 'https://example.edu/', extra: 1 })).status).toBe(400);
		expect((await post({})).status).toBe(400);
		expect((await post({ url: '' })).status).toBe(400);
		const raw = await sendRequest(preflight, ROUTE, {
			method: 'POST',
			path: ROUTE,
			raw: 'url=x',
			headers: { 'content-type': 'text/plain' }
		});
		expect(raw.status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

function installedServices() {
	return {
		fetch: async () => {
			throw new Error('boom');
		},
		resolve: async () => PUBLIC,
		now: Date.now,
		contactUrl: 'https://app.drupflare.com/migrate/preflight'
	};
}

describe('POST /api/v1/preflight: rate limits', () => {
	const allowed = {
		allowed: true,
		limit: 10,
		remaining: 9,
		resetSeconds: 600,
		retryAfterSeconds: 0,
		timestamps: []
	};
	const denied = { ...allowed, allowed: false, remaining: 0, retryAfterSeconds: 30 };

	it('counts a caller on its own address, then on the shared ceiling', async () => {
		const { limits } = setup();
		install({ 'https://example.edu/': () => html(PLAIN) });
		await post({ url: 'https://example.edu/' }, { 'cf-connecting-ip': '198.51.100.4' });
		expect(limits).toEqual([
			{ routeClass: 'preflight', key: 'ip:198.51.100.4' },
			{ routeClass: 'preflight-global', key: 'all' }
		]);
	});

	it('refuses with 429 and fetches nothing when the caller is over its limit', async () => {
		setup({ allow: (key) => (key.startsWith('ip:') ? denied : null) });
		install({ 'https://example.edu/': () => html(PLAIN) });
		const reply = await post({ url: 'https://example.edu/' });
		expect(reply.status).toBe(429);
		expect(reply.headers.get('retry-after')).toBe('30');
		expect(calls).toHaveLength(0);
	});

	it('refuses with 429 and fetches nothing when the shared ceiling is spent', async () => {
		setup({ allow: (key) => (key === 'all' ? denied : null) });
		install({ 'https://example.edu/': () => html(PLAIN) });
		const reply = await post({ url: 'https://example.edu/' });
		expect(reply.status).toBe(429);
		expect(calls).toHaveLength(0);
	});

	it('stops the eleventh request from one address with the in-memory limiter', async () => {
		setup({ deps: { limit: memoryLimiter(PLACEHOLDER_RATES) } });
		install({ 'https://example.edu/': () => html(PLAIN) });
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) {
			const reply = await post(
				{ url: 'https://example.edu/' },
				{ 'cf-connecting-ip': '192.0.2.77' }
			);
			statuses.push(reply.status);
		}
		expect(statuses).toEqual([...Array(10).fill(200), 429]);
	});

	it('stops a crowd from many addresses at the shared ceiling', async () => {
		const rates = { ...PLACEHOLDER_RATES, 'preflight-global': { limit: 3, windowMs: 60_000 } };
		setup({ deps: { limit: memoryLimiter(rates) } });
		install({ 'https://example.edu/': () => html(PLAIN) });
		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const reply = await post(
				{ url: 'https://example.edu/' },
				{ 'cf-connecting-ip': `192.0.2.${i + 1}` }
			);
			statuses.push(reply.status);
		}
		expect(statuses).toEqual([200, 200, 200, 429, 429]);
	});
});
