import { describe, expect, it } from 'vitest';
import {
	type FetchLike,
	type UrlGuardCode,
	UrlGuardError,
	checkUrl,
	dohResolve,
	guardedFetch,
	isPublicAddress
} from '../../../../src/server/integrations/url-guard';
import { thrownBy } from '../utils/support';

const codeOf = (fn: () => unknown): unknown => {
	const error = thrownBy(fn);
	if (!(error instanceof UrlGuardError)) return error;
	return error.code;
};

const accepted = [
	'https://example.com/',
	'http://example.com/',
	'HTTPS://example.com/',
	'https://example.com:443/',
	'http://example.com:80/',
	'http://example.com',
	'https://www.example.co.uk/path/to/page?q=1#top',
	'https://EXAMPLE.com/',
	'https://example.com./',
	'https://xn--bcher-kva.example/',
	'https://college.example.edu/catalog',
	'https://a-b.c-d.example.org/',
	'http://example.com/a%20b',
	'https://example.com/?next=https://other.example/',
	'https://1example.com/',
	'https://sub.sub.example.com/',
	'https://example.museum/',
	'https://example.com?x',
	'https://example.org/0x7f'
];

const rejected: Array<[string, UrlGuardCode]> = [
	['ftp://example.com/', 'protocol'],
	['file:///etc/passwd', 'protocol'],
	['gopher://example.com/', 'protocol'],
	['javascript:alert(1)', 'protocol'],
	['data:text/plain,hi', 'protocol'],
	['wss://example.com/', 'protocol'],
	['http://user:pass@a.example/', 'credentials'],
	['https://user@example.com/', 'credentials'],
	['https://:pass@example.com/', 'credentials'],
	['http://example.com:8080/', 'port'],
	['https://example.com:8443/', 'port'],
	['https://example.com:80/', 'port'],
	['http://example.com:443/', 'port'],
	['http://example.com:22/', 'port'],
	['https://example.com:0/', 'port'],
	['http://example.com:3000/', 'port'],
	['http://127.0.0.1/', 'ip_literal'],
	['http://8.8.8.8/', 'ip_literal'],
	['http://0x7f.1/', 'ip_literal'],
	['http://2130706433/', 'ip_literal'],
	['http://0177.0.0.1/', 'ip_literal'],
	['http://0x7f000001/', 'ip_literal'],
	['http://[::1]/', 'ip_literal'],
	['http://[::ffff:127.0.0.1]/', 'ip_literal'],
	['https://[2001:db8::1]/', 'ip_literal'],
	['http://[2606:4700:4700::1111]/', 'ip_literal'],
	['http://169.254.169.254/latest/meta-data/', 'ip_literal'],
	['http://10.0.0.1/', 'ip_literal'],
	['http://192.168.1.1:80/', 'ip_literal'],
	['http://localhost/', 'hostname'],
	['https://localhost:443/', 'hostname'],
	['http://LOCALHOST/', 'hostname'],
	['http://foo.localhost/', 'hostname'],
	['http://intranet/', 'hostname'],
	['http://printer.local/', 'hostname'],
	['http://db.internal/', 'hostname'],
	['http://api.internal./', 'hostname'],
	['https://metadata.google.internal/', 'hostname'],
	['http://router.localdomain/', 'hostname'],
	['', 'invalid_url'],
	['not a url', 'invalid_url'],
	['https://', 'invalid_url'],
	['http://exa mple.com/', 'invalid_url'],
	['http://999.999.999.999/', 'invalid_url']
];

describe('checkUrl accepts public http and https URLs', () => {
	it.each(accepted)('accepts %s', (input) => {
		expect(checkUrl(input).protocol).toMatch(/^https?:$/);
	});
});

describe('checkUrl rejects the rest with a typed code', () => {
	it.each(rejected)('rejects %s as %s', (input, code) => {
		expect(codeOf(() => checkUrl(input))).toBe(code);
	});
});

describe('isPublicAddress', () => {
	it.each([
		'8.8.8.8',
		'1.1.1.1',
		'93.184.216.34',
		'11.0.0.1',
		'100.63.255.255',
		'172.15.255.255',
		'172.32.0.1',
		'198.17.255.255',
		'2606:4700:4700::1111',
		'2001:4860:4860::8888',
		'::ffff:8.8.8.8'
	])('accepts %s', (ip) => {
		expect(isPublicAddress(ip)).toBe(true);
	});

	it.each([
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'100.127.255.255',
		'127.0.0.1',
		'127.255.255.255',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.0.0.1',
		'192.0.2.1',
		'192.88.99.1',
		'192.168.1.1',
		'198.18.0.1',
		'198.51.100.7',
		'203.0.113.9',
		'224.0.0.1',
		'239.255.255.255',
		'240.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'::ffff:169.254.169.254',
		'::ffff:100.64.0.1',
		'::ffff:192.168.0.1',
		'::ffff:224.0.0.1',
		'::ffff:0.0.0.0',
		'::ffff:7f00:1',
		'::127.0.0.1',
		'fc00::1',
		'fd12:3456::1',
		'fe80::1',
		'fec0::1',
		'ff02::1',
		'2001:db8::1',
		'2002:c0a8:101::1',
		'2001::1',
		'64:ff9b::8.8.8.8',
		'3fff::1'
	])('rejects %s', (ip) => {
		expect(isPublicAddress(ip)).toBe(false);
	});

	it.each(['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '256.1.1.1', ':::', 'fe80::1::2', '1.2.3.4.'])(
		'rejects the malformed %s',
		(ip) => {
			expect(isPublicAddress(ip)).toBe(false);
		}
	);
});

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, init });
		const route = routes[url];
		if (!route) throw new Error(`no route for ${url}`);
		return route(url, init);
	};
	return { fetch, calls };
}

function resolverFor(answers: Record<string, string[]>) {
	return async (hostname: string) => answers[hostname] ?? [];
}

const PUBLIC = ['93.184.216.34'];
const deps = (
	answers: Record<string, string[]>,
	routes: Record<string, Route>
): {
	fetch: FetchLike;
	resolve: (hostname: string) => Promise<string[]>;
	calls: Array<{ url: string; init: RequestInit }>;
} => {
	const fake = fakeFetch(routes);
	return { fetch: fake.fetch, resolve: resolverFor(answers), calls: fake.calls };
};
const limits = { maxRedirects: 3, maxBytes: 1024, timeoutMs: 200 };

describe('guardedFetch', () => {
	it('returns the body of a public response', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{ 'https://example.com/': () => new Response('hello') }
		);
		const result = await guardedFetch('https://example.com/', { fetch, resolve }, limits);
		expect(result.status).toBe(200);
		expect(new TextDecoder().decode(result.body)).toBe('hello');
	});

	it('rejects before any request when the URL fails checkUrl', async () => {
		const { fetch, resolve, calls } = deps({}, {});
		expect(
			await guardedFetch('http://localhost/', { fetch, resolve }, limits).catch((e) => e.code)
		).toBe('hostname');
		expect(calls).toHaveLength(0);
	});

	it('rejects when any resolved address is not public', async () => {
		const { fetch, resolve, calls } = deps(
			{ 'mixed.example': ['93.184.216.34', '10.0.0.5'] },
			{}
		);
		expect(
			await guardedFetch('https://mixed.example/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('non_public_address');
		expect(calls).toHaveLength(0);
	});

	it('rejects a public name that resolves only to a private address', async () => {
		const { fetch, resolve, calls } = deps({ 'rebind.example': ['127.0.0.1'] }, {});
		expect(
			await guardedFetch('https://rebind.example/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('non_public_address');
		expect(calls).toHaveLength(0);
	});

	it('rejects a name with no answers, and a resolver that throws', async () => {
		const empty = deps({}, {});
		expect(
			await guardedFetch('https://nothing.example/', empty, limits).catch((e) => e.code)
		).toBe('unresolvable');
		const broken = {
			fetch: empty.fetch,
			resolve: async () => {
				throw new Error('dns down');
			}
		};
		expect(
			await guardedFetch('https://nothing.example/', broken, limits).catch((e) => e.code)
		).toBe('unresolvable');
	});

	it('refuses a redirect to an IP literal', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{
				'https://example.com/': () =>
					new Response(null, {
						status: 302,
						headers: { location: 'http://10.0.0.1/admin' }
					})
			}
		);
		expect(
			await guardedFetch('https://example.com/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('ip_literal');
	});

	it('refuses a redirect to a name that resolves to a private address', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC, 'internal-ish.example': ['192.168.0.9'] },
			{
				'https://example.com/': () =>
					new Response(null, {
						status: 302,
						headers: { location: 'https://internal-ish.example/' }
					})
			}
		);
		expect(
			await guardedFetch('https://example.com/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('non_public_address');
	});

	it('re-checks each redirect hop and follows a public one', async () => {
		const { fetch, resolve, calls } = deps(
			{ 'example.com': PUBLIC, 'cdn.example': PUBLIC },
			{
				'https://example.com/': () =>
					new Response(null, { status: 301, headers: { location: '/asset' } }),
				'https://example.com/asset': () =>
					new Response(null, {
						status: 307,
						headers: { location: 'https://cdn.example/x' }
					}),
				'https://cdn.example/x': () => new Response('final')
			}
		);
		const result = await guardedFetch('https://example.com/', { fetch, resolve }, limits);
		expect(result.url).toBe('https://cdn.example/x');
		expect(new TextDecoder().decode(result.body)).toBe('final');
		expect(calls).toHaveLength(3);
	});

	it('stops after the redirect limit', async () => {
		const hop =
			(n: number): Route =>
			() =>
				new Response(null, {
					status: 302,
					headers: { location: `https://example.com/${n + 1}` }
				});
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{
				'https://example.com/0': hop(0),
				'https://example.com/1': hop(1),
				'https://example.com/2': hop(2),
				'https://example.com/3': hop(3)
			}
		);
		const tight = { ...limits, maxRedirects: 2 };
		expect(
			await guardedFetch('https://example.com/0', { fetch, resolve }, tight).catch(
				(e) => e.code
			)
		).toBe('redirect_limit');
	});

	it('returns a redirect that carries no location as the final response', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{ 'https://example.com/': () => new Response(null, { status: 302 }) }
		);
		const result = await guardedFetch('https://example.com/', { fetch, resolve }, limits);
		expect(result.status).toBe(302);
	});

	it('rejects a redirect location that is not a URL', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{
				'https://example.com/': () =>
					new Response(null, { status: 302, headers: { location: 'https://[bad' } })
			}
		);
		expect(
			await guardedFetch('https://example.com/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('invalid_url');
	});

	it('rejects a body larger than the byte cap', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{ 'https://example.com/': () => new Response(new Uint8Array(2048)) }
		);
		expect(
			await guardedFetch('https://example.com/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('too_large');
	});

	it('rejects a declared content length over the cap without reading the body', async () => {
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{
				'https://example.com/': () =>
					new Response('x', { headers: { 'content-length': '999999' } })
			}
		);
		expect(
			await guardedFetch('https://example.com/', { fetch, resolve }, limits).catch(
				(e) => e.code
			)
		).toBe('too_large');
	});

	it('times out a body that never finishes', async () => {
		const stalled = new ReadableStream<Uint8Array>({ start() {} });
		const { fetch, resolve } = deps(
			{ 'example.com': PUBLIC },
			{ 'https://example.com/': () => new Response(stalled) }
		);
		expect(
			await guardedFetch(
				'https://example.com/',
				{ fetch, resolve },
				{ ...limits, timeoutMs: 50 }
			).catch((e) => e.code)
		).toBe('timeout');
	});

	it('times out a response that never arrives', async () => {
		const { resolve } = deps({ 'example.com': PUBLIC }, {});
		const fetch: FetchLike = () => new Promise<Response>(() => {});
		expect(
			await guardedFetch(
				'https://example.com/',
				{ fetch, resolve },
				{ ...limits, timeoutMs: 50 }
			).catch((e) => e.code)
		).toBe('timeout');
	});

	it('sends no cookies or authorization and does not follow redirects itself', async () => {
		const { fetch, resolve, calls } = deps(
			{ 'example.com': PUBLIC },
			{ 'https://example.com/': () => new Response('ok') }
		);
		await guardedFetch('https://example.com/', { fetch, resolve }, limits);
		const init = calls[0]?.init;
		expect(init?.redirect).toBe('manual');
		const headers = new Headers(init?.headers);
		expect(headers.has('cookie')).toBe(false);
		expect(headers.has('authorization')).toBe(false);
	});
});

describe('dohResolve', () => {
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } });

	it('asks for A and AAAA and keeps only address answers', async () => {
		const asked: string[] = [];
		const fetch: FetchLike = async (url) => {
			asked.push(url);
			if (url.endsWith('&type=A')) {
				return json({
					Status: 0,
					Answer: [
						{ type: 5, data: 'alias.example.' },
						{ type: 1, data: '93.184.216.34' }
					]
				});
			}
			return json({ Status: 0, Answer: [{ type: 28, data: '2606:2800:220:1::1' }] });
		};
		expect(await dohResolve('example.com', fetch)).toEqual([
			'93.184.216.34',
			'2606:2800:220:1::1'
		]);
		expect(asked.every((url) => url.includes('name=example.com'))).toBe(true);
	});

	it('returns no addresses for an NXDOMAIN status', async () => {
		const fetch: FetchLike = async () => json({ Status: 3 });
		expect(await dohResolve('nope.example', fetch)).toEqual([]);
	});

	it('throws when the DNS-over-HTTPS endpoint fails', async () => {
		const fetch: FetchLike = async () => new Response('down', { status: 503 });
		await expect(dohResolve('example.com', fetch)).rejects.toThrow();
	});
});
