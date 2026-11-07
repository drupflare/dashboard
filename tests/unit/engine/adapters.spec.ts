import {
	Budget,
	dispatch,
	Resources,
	SESSION_MARGIN_MS,
	SESSION_TTL_MS,
	type DispatchPlane
} from '@drupflare/workforce';
import { describe, expect, it, vi } from 'vitest';
import { generateSigningKey } from '../../../contracts/src/common';
import { scriptName } from '../../../contracts/src/sites';
import { resolveRoute } from '../../../dispatch/src/route';
import { RateLimitedError } from '../../../engine/src/account-usage';
import { authorityOf, AuthorityStale } from '../../../engine/src/adapters/authority';
import { hostsOf, hostValue } from '../../../engine/src/adapters/hosts';
import { leasesOf } from '../../../engine/src/adapters/leases';
import { namesOf } from '../../../engine/src/adapters/names';
import { releasesOf } from '../../../engine/src/adapters/releases';
import { siteOf, SiteUnreachable } from '../../../engine/src/adapters/site';
import { steppedMigrations, workforceCloudflare } from '../../../engine/src/adapters/workforce';
import { bundleKeys } from '../../../engine/src/bundle';
import { CONFIG_VARS, ConfigError, readConfig } from '../../../engine/src/config';
import { PermanentError } from '../../../engine/src/step';
import { shardKey } from '../../../src/shared/names';
import { CDN_BASE, cdnOf, hostsKv, newAnswer, siteFetch } from './doubles';
import { makeBundle } from './fakes';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const ACCOUNT = 'a'.repeat(32);
const SITE = `site_${'s'.repeat(26)}`;

interface Seen {
	method: string;
	path: string;
	body: unknown;
	auth: string | null;
	contentType: string | null;
}

// the streamed body is read back through the same parser a server would use
const formOf = (seen: Seen | undefined): Promise<FormData> =>
	new Response(seen?.body as BodyInit, {
		headers: { 'content-type': seen?.contentType ?? '' }
	}).formData();

function cloudflareWith(
	answer: (seen: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> }
) {
	const calls: Seen[] = [];
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const seen: Seen = {
			method: init?.method ?? 'GET',
			path: `${url.pathname}${url.search}`,
			body: init?.body ?? null,
			auth: new Headers(init?.headers).get('authorization'),
			contentType: new Headers(init?.headers).get('content-type')
		};
		calls.push(seen);
		const { status = 200, body = { success: true, result: {} }, headers = {} } = answer(seen);
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json', ...headers }
		});
	};
	// the governor waits out a 429's retry-after on its own sleep, so it runs on a clock that sleep advances
	let clock = 0;
	const sleep = async (ms: number) => {
		clock += ms;
	};
	const plane: DispatchPlane = dispatch({
		accountId: ACCOUNT,
		token: 'fake-token',
		namespace: 'ns',
		fetch: fetcher,
		retries: 0,
		sleep,
		now: () => clock,
		budget: new Budget({ now: () => clock, sleep })
	});
	return { calls, cloudflare: workforceCloudflare(plane, new Resources(plane.http, ACCOUNT)) };
}

const page = (result: unknown) => ({
	success: true,
	result,
	result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 }
});

describe('the workforce adapter', () => {
	it('finds and creates a KV namespace by title', async () => {
		const { calls, cloudflare } = cloudflareWith((seen) =>
			seen.method === 'POST'
				? { body: { success: true, result: { id: 'kv-new', title: 'x' } } }
				: { body: page([{ id: 'kv-1', title: 'present' }]) }
		);
		expect(await cloudflare.findResource('kv', 'present')).toEqual({ providerId: 'kv-1' });
		expect(await cloudflare.findResource('kv', 'absent')).toBeNull();
		expect(await cloudflare.createResource('kv', 'x')).toEqual({ providerId: 'kv-new' });
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.path).toBe(`/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces`);
		expect(JSON.parse(String(post?.body))).toEqual({ title: 'x' });
		expect(post?.auth).toBe('Bearer fake-token');
	});

	it('finds and creates a bucket and a database', async () => {
		const { cloudflare } = cloudflareWith((seen) => {
			if (seen.path.includes('/r2/buckets')) {
				return seen.method === 'POST'
					? { body: { success: true, result: { name: 'bucket-new' } } }
					: { body: { success: true, result: { buckets: [{ name: 'bucket-1' }] } } };
			}
			return seen.method === 'POST'
				? { body: { success: true, result: { uuid: 'db-new', name: 'db' } } }
				: { body: page([{ uuid: 'db-1', name: 'db-present' }]) };
		});
		expect(await cloudflare.findResource('r2', 'bucket-1')).toEqual({ providerId: 'bucket-1' });
		expect(await cloudflare.findResource('r2', 'nope')).toBeNull();
		expect(await cloudflare.createResource('r2', 'bucket-new')).toEqual({
			providerId: 'bucket-new'
		});
		expect(await cloudflare.findResource('d1', 'db-present')).toEqual({ providerId: 'db-1' });
		expect(await cloudflare.findResource('d1', 'nope')).toBeNull();
		expect(await cloudflare.createResource('d1', 'db')).toEqual({ providerId: 'db-new' });
	});

	it('reads the status of a delete: gone is absent, a refusal throws', async () => {
		let status = 200;
		const { calls, cloudflare } = cloudflareWith(() => ({ status }));
		expect(await cloudflare.deleteResource('kv', 'kv-1')).toBe('deleted');
		expect(await cloudflare.deleteResource('r2', 'bucket-1')).toBe('deleted');
		expect(await cloudflare.deleteResource('d1', 'db-1')).toBe('deleted');
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			`DELETE /client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/kv-1`,
			`DELETE /client/v4/accounts/${ACCOUNT}/r2/buckets/bucket-1`,
			`DELETE /client/v4/accounts/${ACCOUNT}/d1/database/db-1`
		]);
		status = 404;
		expect(await cloudflare.deleteResource('kv', 'kv-1')).toBe('absent');
		expect(await cloudflare.deleteScript(scriptName(SITE))).toBe('absent');
		status = 403;
		await expect(cloudflare.deleteResource('kv', 'kv-1')).rejects.toThrow('403');
		await expect(cloudflare.deleteScript(scriptName(SITE))).rejects.toThrow('403');
	});

	it('deletes a script from the namespace with force', async () => {
		const { calls, cloudflare } = cloudflareWith(() => ({}));
		expect(await cloudflare.deleteScript(scriptName(SITE))).toBe('deleted');
		expect(calls[0]?.path).toBe(
			`/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/ns/scripts/${scriptName(SITE)}?force=true`
		);
	});

	it('opens an asset session and uploads a bucket with the session token', async () => {
		const { calls, cloudflare } = cloudflareWith((seen) =>
			seen.path.includes('assets-upload-session')
				? { body: { success: true, result: { jwt: 'session', buckets: [['h1']] } } }
				: { body: { success: true, result: { jwt: 'completion' } } }
		);
		const session = await cloudflare.startAssetSession(scriptName(SITE), {
			'/a.txt': { hash: 'h1', size: 1 }
		});
		expect(session).toEqual({ jwt: 'session', buckets: [['h1']], complete: false });
		const token = await cloudflare.uploadAssetBucket('session', [
			{ hash: 'h1', bytes: new Uint8Array([1]) }
		]);
		expect(token).toBe('completion');
		expect(calls[0]?.path).toBe(
			`/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/ns/scripts/${scriptName(SITE)}/assets-upload-session`
		);
		expect(calls[1]?.path).toBe(
			`/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`
		);
		expect(calls[1]?.auth).toBe('Bearer session');
		const sent = await formOf(calls[1]);
		expect(atob(await (sent.get('h1') as File).text())).toBe('\u0001');
	});

	it('uploads a script as multipart with the metadata and one part per module', async () => {
		const { calls, cloudflare } = cloudflareWith(() => ({
			body: { success: true, result: { id: 'x', etag: 'e' } }
		}));
		const bundle = await makeBundle();
		const modules = bundle.manifest.modules.map((module) => ({
			module,
			bytes: bundle.parts.get(bundleKeys.module('v1.0.4', module.name))!
		}));
		const name = scriptName(SITE);
		const result = await cloudflare.putScript(name, {
			main: 'index.js',
			metadata: { compatibility_date: '2026-08-01', tags: ['s:x'] },
			modules
		});
		expect(result).toEqual({ versionId: null });
		expect(calls[0]?.method).toBe('PUT');
		expect(calls[0]?.path).toBe(
			`/client/v4/accounts/${ACCOUNT}/workers/dispatch/namespaces/ns/scripts/${name}`
		);
		const form = await formOf(calls[0]);
		expect(JSON.parse(String(form.get('metadata')))).toMatchObject({
			main_module: 'index.js',
			compatibility_date: '2026-08-01'
		});
		expect((form.get('index.js') as File).type).toBe('application/javascript+module');
		expect((form.get('php.wasm') as File).type).toBe('application/wasm');
	});

	it('sends migrations as the one stepped object the API takes, not a list', async () => {
		const { calls, cloudflare } = cloudflareWith(() => ({
			body: { success: true, result: { id: 'x', etag: 'e' } }
		}));
		const bundle = await makeBundle();
		const modules = bundle.manifest.modules.map((module) => ({
			module,
			bytes: bundle.parts.get(bundleKeys.module('v1.0.4', module.name))!
		}));
		await cloudflare.putScript(scriptName(SITE), {
			main: 'index.js',
			metadata: {
				migrations: [
					{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] },
					{ tag: 'v2', new_sqlite_classes: ['RenderLane'] }
				]
			},
			modules
		});
		const sent = JSON.parse(String((await formOf(calls[0])).get('metadata')));
		expect(sent.migrations).toEqual({
			new_tag: 'v2',
			steps: [
				{ new_sqlite_classes: ['SitePhpDurableObject'] },
				{ new_sqlite_classes: ['RenderLane'] }
			]
		});
	});

	it('leaves out an empty migration list and steps a single one', () => {
		expect(steppedMigrations([])).toBeUndefined();
		expect(steppedMigrations([{ tag: 'v1', new_classes: ['A'] }])).toEqual({
			new_tag: 'v1',
			steps: [{ new_classes: ['A'] }]
		});
	});

	it('uses the same asset session lifetime workforce does', () => {
		expect(SESSION_TTL_MS - SESSION_MARGIN_MS).toBe(55 * 60 * 1000);
	});
});

describe('the workforce adapter reads and the ownership calls', () => {
	it('lists each kind with its provider id and name', async () => {
		const { cloudflare } = cloudflareWith((seen) => {
			if (seen.path.includes('/r2/buckets')) {
				return { body: { success: true, result: { buckets: [{ name: 'b1' }] } } };
			}
			if (seen.path.includes('/d1/')) return { body: page([{ uuid: 'u1', name: 'db1' }]) };
			return { body: page([{ id: 'k1', title: 'ns1' }]) };
		});
		expect(await cloudflare.listResources('kv')).toEqual([{ id: 'k1', name: 'ns1' }]);
		expect(await cloudflare.listResources('r2')).toEqual([{ id: 'b1', name: 'b1' }]);
		expect(await cloudflare.listResources('d1')).toEqual([{ id: 'u1', name: 'db1' }]);
	});

	it('reads a script with its tags and version, and null for one that is not there', async () => {
		const name = scriptName(SITE);
		const { cloudflare } = cloudflareWith((seen) => {
			if (seen.path.includes('/tags')) return { body: page([`s:${SITE}`, 'team:web']) };
			if (seen.path.includes(name)) {
				return {
					body: {
						success: true,
						result: { modified_on: '2026-11-05T00:00:00Z', script: { id: name } }
					}
				};
			}
			return {
				status: 404,
				body: { success: false, errors: [{ code: 10007, message: 'gone' }] }
			};
		});
		expect(await cloudflare.getScript(name)).toEqual({
			tags: [`s:${SITE}`, 'team:web'],
			version: '2026-11-05T00:00:00Z'
		});
		expect(await cloudflare.getScript('s-nothereatall')).toBeNull();
	});

	it('reads the live answer for a script that is not there, a 200 with a null script, as absent', async () => {
		const { calls, cloudflare } = cloudflareWith(() => ({
			body: {
				success: true,
				result: {
					dispatch_namespace: 'ns',
					modified_on: '2026-11-05T00:00:00Z',
					script: null
				}
			}
		}));
		expect(await cloudflare.getScript('s-nothereatall')).toBeNull();
		expect(calls.filter((call) => call.path.includes('/tags'))).toHaveLength(0);
	});

	it('lists, adds and removes a route on a zone, and reads the status of the remove', async () => {
		let status = 200;
		const { calls, cloudflare } = cloudflareWith((seen) => {
			if (seen.method === 'DELETE') return { status };
			if (seen.method === 'POST') return { body: { success: true, result: { id: 'r-new' } } };
			return { body: page([{ id: 'r1', pattern: 'a.example.com/*', script: 'theirs' }]) };
		});
		expect(await cloudflare.listRoutes('z1')).toEqual([
			{ id: 'r1', zoneId: 'z1', pattern: 'a.example.com/*', script: 'theirs' }
		]);
		expect(await cloudflare.addRoute('z1', 'b.example.com/*', 'mine')).toEqual({
			providerId: 'r-new'
		});
		expect(JSON.parse(String(calls.find((call) => call.method === 'POST')?.body))).toEqual({
			pattern: 'b.example.com/*',
			script: 'mine'
		});
		expect(await cloudflare.removeRoute('z1', 'r-new')).toBe('deleted');
		status = 404;
		expect(await cloudflare.removeRoute('z1', 'r-new')).toBe('absent');
		status = 500;
		await expect(cloudflare.removeRoute('z1', 'r-new')).rejects.toThrow('500');
		expect(calls.at(-1)?.path).toBe('/client/v4/zones/z1/workers/routes/r-new');
	});

	it('reads the namespace and bucket counts and the rate headroom from the response headers', async () => {
		const { cloudflare } = cloudflareWith((seen) => {
			const headers = {
				ratelimit: '"default";r=1100;t=250',
				'ratelimit-policy': '"default";q=1200;w=300'
			};
			if (seen.path.includes('/r2/buckets')) {
				return {
					body: { success: true, result: { buckets: [{ name: 'a' }, { name: 'b' }] } }
				};
			}
			return {
				headers,
				body: page([
					{ id: 'k1', title: 'one' },
					{ id: 'k2', title: 'two' },
					{ id: 'k3', title: 'three' }
				])
			};
		});
		expect(await cloudflare.readUsage()).toEqual({
			kvNamespaces: 3,
			buckets: 2,
			rate: { remaining: 1100, resetSeconds: 250, quota: 1200, windowSeconds: 300 }
		});
	});

	it('leaves the headroom unknown when the response carries no rate headers', async () => {
		const { cloudflare } = cloudflareWith(() => ({ body: page([]) }));
		const usage = await cloudflare.readUsage().catch(() => null);
		if (usage !== null) {
			expect(usage.rate).toEqual({
				remaining: null,
				resetSeconds: null,
				quota: null,
				windowSeconds: null
			});
		}
	});

	it('turns a rate limit into a retryable error that carries the wait', async () => {
		const { cloudflare } = cloudflareWith(() => ({
			status: 429,
			headers: { 'retry-after': '7' }
		}));
		const error = await cloudflare.createResource('kv', 'x').catch((caught) => caught);
		expect(error).toBeInstanceOf(RateLimitedError);
		expect(error).not.toBeInstanceOf(PermanentError);
		expect(error.retryAfterMs).toBe(7000);
		await expect(cloudflare.listResources('kv')).rejects.toBeInstanceOf(RateLimitedError);
		await expect(cloudflare.readUsage()).rejects.toBeInstanceOf(RateLimitedError);
	});
});

describe('the authority adapter', () => {
	const refusing = async (code: string) =>
		authorityOf({
			siteAuth: () => ({
				read: async () => null,
				apply: async () => ({ ok: false, code })
			}),
			hosts: hostsOf(hostsKv().kv),
			controlKey: (await generateSigningKey()).privateKey,
			now: () => 1
		});
	const state = { siteId: SITE, epoch: 1, generation: 1 } as never;

	it('treats a stale message as retryable', async () => {
		const stale = await (await refusing('stale_message')).apply(state).catch((error) => error);
		expect(stale).toBeInstanceOf(AuthorityStale);
		expect(stale).not.toBeInstanceOf(PermanentError);
	});

	it('treats every other refusal as permanent and names it', async () => {
		for (const code of ['malformed', 'wrong_site', 'bad_signature', 'stale_generation']) {
			const refused = await (await refusing(code)).apply(state).catch((error) => error);
			expect(refused).toBeInstanceOf(PermanentError);
			expect(refused.code).toBe(`authority_${code}`);
		}
	});

	it('signs each write with the time it is sent', async () => {
		const sent: { iat: number }[] = [];
		const control = await generateSigningKey();
		let clock = 1_790_000_000_000;
		const authority = authorityOf({
			siteAuth: () => ({
				read: async () => null,
				apply: async (message) => {
					sent.push(message as { iat: number });
					return { ok: true, value: { applied: true, generation: 1 } };
				}
			}),
			hosts: hostsOf(hostsKv().kv),
			controlKey: control.privateKey,
			now: () => clock
		});
		await authority.apply(state);
		clock += 5_000;
		await authority.apply(state);
		expect(sent.map((message) => message.iat)).toEqual([1_790_000_000_000, 1_790_000_005_000]);
	});
});

describe('the hosts adapter', () => {
	it('writes the value the dispatch parser reads, for every site script name', async () => {
		for (const id of [SITE, `site_${'a1'.repeat(13)}`]) {
			const { kv, map } = hostsKv();
			const route = { siteId: id, script: scriptName(id), epoch: 3 };
			await hostsOf(kv).put('Quiet-Otter.Drupflare.App', route);
			expect([...map.keys()]).toEqual(['quiet-otter.drupflare.app']);
			const parsed = resolveRoute('quiet-otter.drupflare.app', [...map.values()][0]!);
			expect(parsed).toEqual({ ok: true, value: route });
		}
	});

	it('writes exactly the fields the parser accepts and nothing else', async () => {
		const { kv, map } = hostsKv();
		const route = { siteId: SITE, script: scriptName(SITE), epoch: 1, extra: 'x' } as never;
		await hostsOf(kv).put('a.example.com', route);
		expect(JSON.parse(map.get('a.example.com')!)).toEqual({
			v: 1,
			siteId: SITE,
			script: scriptName(SITE),
			epoch: 1
		});
		expect(hostValue(route)).toBe(map.get('a.example.com'));
	});

	it('refuses a host that is not a hostname and a route the parser would refuse', async () => {
		const { kv, map } = hostsKv();
		const hosts = hostsOf(kv);
		const route = { siteId: SITE, script: scriptName(SITE), epoch: 1 };
		const badHost = await hosts.put('not a host', route).catch((error) => error);
		expect(badHost).toBeInstanceOf(PermanentError);
		expect(badHost.code).toBe('invalid_host');
		const badRoute = await hosts
			.put('a.example.com', { ...route, script: 'Bad Script!' })
			.catch((error) => error);
		expect(badRoute).toBeInstanceOf(PermanentError);
		expect(badRoute.code).toBe('invalid_route');
		const badDelete = await hosts.deleteIfOwned('not a host', SITE).catch((error) => error);
		expect(badDelete.code).toBe('invalid_host');
		expect(map.size).toBe(0);
	});

	it('deletes under the same normalized key when the route names the site', async () => {
		const { kv, map } = hostsKv();
		const hosts = hostsOf(kv);
		await hosts.put('a.example.com', { siteId: SITE, script: 's-x', epoch: 1 });
		expect(await hosts.deleteIfOwned('A.Example.com.', SITE)).toBe('deleted');
		expect(map.size).toBe(0);
		expect(await hosts.deleteIfOwned('a.example.com', SITE)).toBe('absent');
	});

	it('leaves a route that names another site, or that does not parse, exactly as it is', async () => {
		const { kv, map } = hostsKv();
		const hosts = hostsOf(kv);
		await hosts.put('a.example.com', {
			siteId: `site_${'x'.repeat(26)}`,
			script: 's-x',
			epoch: 1
		});
		map.set('b.example.com', '{not json');
		const before = [...map];
		expect(await hosts.deleteIfOwned('a.example.com', SITE)).toBe('foreign');
		expect(await hosts.deleteIfOwned('b.example.com', SITE)).toBe('foreign');
		expect([...map]).toEqual(before);
	});
});

describe('the other binding adapters', () => {
	it('sends a name to the shard that owns it', async () => {
		const asked: string[] = [];
		const names = namesOf((shard) => ({
			reserve: async (name) => {
				asked.push(`${shard}:${name}`);
				return 'reserved';
			},
			release: async (name, _site, hold) => {
				asked.push(`${shard}:${name}:${hold}`);
				return 'released';
			}
		}));
		expect(await names.reserve('quiet-otter', SITE)).toBe('reserved');
		expect(await names.confirm('quiet-otter', SITE)).toBe(true);
		expect(await names.release('quiet-otter', SITE, 0)).toBe('released');
		expect(await names.release('quiet-otter', SITE)).toBe('released');
		const shard = shardKey('quiet-otter');
		expect(asked).toEqual([
			`${shard}:quiet-otter`,
			`${shard}:quiet-otter`,
			`${shard}:quiet-otter:0`,
			`${shard}:quiet-otter:undefined`
		]);
	});

	it('passes each lease call to the site object', async () => {
		const calls: string[] = [];
		const stub = (siteId: string) => ({
			acquire: async () => (
				calls.push(`acquire:${siteId}`),
				{ ok: true as const, epoch: 1, expiresAt: 2 }
			),
			heartbeat: async () => (
				calls.push('heartbeat'),
				{ ok: true as const, epoch: 1, expiresAt: 2 }
			),
			release: async () => (calls.push('release'), { ok: true as const }),
			check: async () => (calls.push('check'), { ok: true as const, epoch: 1, expiresAt: 2 })
		});
		const leases = leasesOf(stub);
		await leases.acquire(SITE, { holder: 'op', purpose: 'p', ttlMs: 1 });
		await leases.heartbeat(SITE, { holder: 'op', epoch: 1, ttlMs: 1 });
		await leases.check(SITE, { holder: 'op', epoch: 1 });
		await leases.release(SITE, { holder: 'op', epoch: 1 });
		expect(calls).toEqual([`acquire:${SITE}`, 'heartbeat', 'check', 'release']);
	});

	it('reads a release from the CDN and names what is missing or unreadable', async () => {
		const calls: string[] = [];
		const objects = new Map<string, Uint8Array | string | number>([
			[bundleKeys.manifest('v1.0.4'), '{"releaseId":"v1.0.4"}'],
			[bundleKeys.manifest('broken'), 'not json'],
			[bundleKeys.module('v1.0.4', 'site.js'), new Uint8Array([1, 2, 3])],
			[bundleKeys.module('v1.0.4', 'down.js'), 503]
		]);
		const releases = releasesOf(CDN_BASE.slice(0, -1), cdnOf(objects, calls));
		expect(await releases.manifest('v1.0.4')).toEqual({ releaseId: 'v1.0.4' });
		expect(calls).toEqual([`${CDN_BASE}releases/v1.0.4/manifest.json`]);
		expect(await releases.part(bundleKeys.module('v1.0.4', 'site.js'))).toEqual(
			new Uint8Array([1, 2, 3])
		);
		await expect(releases.manifest('v9')).rejects.toMatchObject({ code: 'release_not_found' });
		await expect(releases.manifest('broken')).rejects.toMatchObject({
			code: 'release_manifest_unreadable'
		});
		await expect(releases.part('releases/v9/modules/x')).rejects.toMatchObject({
			code: 'release_part_missing'
		});
	});

	it('treats a CDN failure as an interruption to retry, not a refusal', async () => {
		const objects = new Map<string, Uint8Array | string | number>([
			[bundleKeys.module('v1.0.4', 'down.js'), 503]
		]);
		const releases = releasesOf(CDN_BASE, cdnOf(objects));
		const error = await releases.part(bundleKeys.module('v1.0.4', 'down.js')).catch((e) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PermanentError);
		expect(error.message).toContain('503');
	});
});

describe('the site adapter', () => {
	const make = (timeoutMs = 1_000) => {
		const answer = newAnswer();
		return { answer, site: siteOf(siteFetch(answer), timeoutMs) };
	};

	it('probes and calls through the public host without following a redirect', async () => {
		const { answer, site } = make();
		answer.status = 204;
		expect(await site.probe('a.example.com', '/health')).toEqual({ status: 204 });
		expect(
			await site.firstRun('a.example.com', { method: 'POST', path: '/first-run', body: '{}' })
		).toEqual({ status: 204 });
		expect(answer.calls).toEqual([
			'GET https://a.example.com/health manual',
			'POST https://a.example.com/first-run manual'
		]);
	});

	it('logs the route, the answer and the time of each call, and never the query, the body or a token', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			const { answer, site } = make();
			answer.status = 503;
			answer.body = 'secret-body';
			await site
				.probe('a.example.com', '/health?token=hunter2', 200, {
					bearer: 'owner-token-value'
				})
				.catch(() => undefined);
			expect(log).toHaveBeenCalledOnce();
			const line = JSON.parse(String(log.mock.calls[0]?.[0]));
			expect(line).toMatchObject({
				event: 'engine.site-call',
				hostname: 'a.example.com',
				path: '/health',
				status: 503
			});
			expect(typeof line.ms).toBe('number');
			expect(JSON.stringify(line)).not.toMatch(/hunter2|secret-body|owner-token-value/);
		} finally {
			log.mockRestore();
		}
	});

	it('logs a call that got no answer', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			const { answer, site } = make();
			answer.fail = true;
			await site.probe('a.example.com', '/').catch(() => undefined);
			expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
				status: 'no answer'
			});
		} finally {
			log.mockRestore();
		}
	});

	it('maps a transport failure to a retryable error', async () => {
		const { answer, site } = make();
		answer.fail = true;
		const failure = await site.probe('a.example.com', '/').catch((error) => error);
		expect(failure).toBeInstanceOf(SiteUnreachable);
		expect(failure).not.toBeInstanceOf(PermanentError);
		expect(failure.message).toContain('connection refused');
	});

	it('maps a call that outlives its timeout to the same retryable error', async () => {
		const { answer, site } = make(5);
		answer.hang = true;
		const failure = await site
			.firstRun('a.example.com', { method: 'GET', path: '/' })
			.catch((error) => error);
		expect(failure).toBeInstanceOf(SiteUnreachable);
		expect(failure).not.toBeInstanceOf(PermanentError);
	});

	it('maps a refusing 4xx to a permanent error', async () => {
		const { answer, site } = make();
		for (const status of [400, 401, 403, 410, 451]) {
			answer.status = status;
			const failure = await site.probe('a.example.com', '/').catch((error) => error);
			expect(failure, String(status)).toBeInstanceOf(PermanentError);
			expect(failure.code).toBe('site_rejected');
		}
	});

	it('returns a 4xx the caller expects and the statuses a starting site gives', async () => {
		const { answer, site } = make();
		answer.status = 401;
		expect(await site.probe('a.example.com', '/', 401)).toEqual({ status: 401 });
		expect(
			await site.firstRun('a.example.com', { method: 'GET', path: '/', expectStatus: 401 })
		).toEqual({ status: 401 });
		for (const status of [404, 408, 425, 429, 500, 502, 503]) {
			answer.status = status;
			expect(await site.probe('a.example.com', '/')).toEqual({ status });
		}
	});

	it('refuses a path that leaves the host and a timeout that is not a positive whole number', async () => {
		const { answer, site } = make();
		for (const path of ['//evil.example.net/x', 'http://evil.example.net/']) {
			const failure = await site.probe('a.example.com', path).catch((error) => error);
			expect(failure).toBeInstanceOf(PermanentError);
			expect(failure.code).toBe('invalid_site_call');
		}
		expect(answer.calls).toEqual([]);
		for (const bad of [0, -1, 1.5, Number.NaN]) {
			expect(() => siteOf(siteFetch(answer), bad)).toThrow(ConfigError);
		}
	});
});

describe('the engine config', () => {
	const complete = {
		LEASE_TTL_MS: '120000',
		ASSET_CHUNK_BYTES: 4_000_000,
		LIMIT_MODULE_BYTES: '1000',
		LIMIT_TOTAL_BYTES: '2000',
		LIMIT_ASSET_BYTES: '300',
		LIMIT_ASSETS: '40'
	};

	it('reads every number from the environment and states none itself', () => {
		expect(readConfig(complete, 5)).toEqual({
			leaseTtlMs: 120_000,
			chunkBytes: 4_000_000,
			assetSessionMs: 5,
			limits: { maxModuleBytes: 1000, maxTotalBytes: 2000, maxAssetBytes: 300, maxAssets: 40 }
		});
	});

	it('refuses to start without each variable, or with one that is not a positive whole number', () => {
		for (const name of CONFIG_VARS) {
			const { [name]: _gone, ...rest } = complete;
			expect(() => readConfig(rest, 5)).toThrow(ConfigError);
			for (const bad of ['0', '-3', '1.5', 'many', '', null]) {
				expect(() => readConfig({ ...complete, [name]: bad }, 5)).toThrow(name);
			}
		}
	});
});
