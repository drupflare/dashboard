import { discoveryDocumentSchema } from '@contracts/discovery';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	composeDrupalDiscovery,
	DiscoveryError,
	fetchDiscovery,
	writeSetting,
	type DiscoverySite,
	type SettingsResponse
} from '~/server/integrations/site-discovery';
import type { FetchLike } from '~/server/integrations/url-guard';

const fixture = JSON.parse(
	readFileSync(new URL('../fixtures/discovery/settings-response.json', import.meta.url), 'utf8')
) as SettingsResponse;

// fixture values: none of these is a real release
const release = { version: '0.0.0-fixture', releaseId: 'fixture-release', schemaVersion: 0 };
const siteId = 'site-fixture';
const site: DiscoverySite = {
	origin: 'https://site.fixture.test',
	ownerToken: 'fixture-owner-token',
	release,
	siteId
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function compose(settings: SettingsResponse = fixture) {
	return composeDrupalDiscovery({ settings, release, siteId });
}

describe('composeDrupalDiscovery', () => {
	it('builds a document that passes the discovery contract', () => {
		const doc = compose();
		expect(discoveryDocumentSchema.safeParse(doc).success).toBe(true);
		expect(doc.kind).toBe('drupal');
		expect(doc.v).toBe(1);
		expect(doc.releaseId).toBe(release.releaseId);
	});

	it('lists only the levers the settings route reports, with their provenance', () => {
		const doc = compose();
		expect(Object.keys(doc.settings.values)).toHaveLength(fixture.levers.length);
		expect(doc.settings.provenance['SPOOL']).toBe('kv');
		expect(doc.settings.provenance['SITE_LOCATION_HINT']).toBe('var');
		expect(doc.settings.provenance['PREFILL']).toBe('default');
	});

	it('coerces integer levers to numbers and keeps the default in the schema', () => {
		const doc = compose();
		expect(doc.settings.values['WARM_INTERVAL_MS']).toBe(30000);
		const prop = doc.settings.schema['WARM_INTERVAL_MS'] as Record<string, unknown>;
		expect(prop['type']).toBe('integer');
		expect(prop['default']).toBe(8000);
	});

	it('marks owner-only levers with the security group', () => {
		const doc = compose();
		for (const key of ['CSP_MODE', 'SPOOL', 'SPOOL_IMAGES', 'SPOOL_VIDEO', 'SPOOL_EMBEDS']) {
			const prop = doc.settings.schema[key] as { 'x-ui': { permission: string } };
			expect(prop['x-ui'].permission).toBe('security');
		}
	});

	it('makes only allow-listed keys writable', () => {
		const doc = compose();
		expect(doc.settings.writable['SPOOL']).toBe('kv');
		expect(doc.settings.writable['WARM_INTERVAL_MS']).toBe('kv');
		expect(doc.settings.writable['SITE_LOCATION_HINT']).toBe('kv');
		expect(doc.settings.writable['PLAN']).toBeUndefined();
	});

	it('refuses a lever outside KV_OVERRIDABLE even when the settings route reports it', () => {
		const hostile: SettingsResponse = {
			...fixture,
			levers: [
				...fixture.levers,
				{
					name: 'SMTP_HOST',
					value: 'relay.fixture.test',
					source: 'var',
					domain: { kind: 'flag' }
				},
				{ name: 'PLAN', value: 'paid', source: 'kv', domain: { kind: 'flag' } }
			]
		};
		const doc = compose(hostile);
		expect(doc.settings.writable['SMTP_HOST']).toBeUndefined();
		expect(doc.settings.writable['PLAN']).toBeUndefined();
		expect(doc.settings.values['SMTP_HOST']).toBe('relay.fixture.test');
	});

	it('etag changes when a setting value changes and not otherwise', () => {
		const same = compose();
		expect(compose().settings.etag).toBe(same.settings.etag);

		const changed: SettingsResponse = {
			...fixture,
			levers: fixture.levers.map((l) => (l.name === 'SPOOL' ? { ...l, value: '1' } : l))
		};
		expect(compose(changed).settings.etag).not.toBe(same.settings.etag);
	});

	it('etag ignores fields outside the settings block', () => {
		const a = composeDrupalDiscovery({ settings: fixture, release, siteId });
		const b = composeDrupalDiscovery({
			settings: fixture,
			release: { ...release, releaseId: 'fixture-release-2' },
			siteId
		});
		expect(a.settings.etag).toBe(b.settings.etag);
	});

	it('substitutes the site id into the redirect map', () => {
		const doc = compose();
		expect(doc.redirects.length).toBeGreaterThan(0);
		for (const r of doc.redirects) {
			expect(r.to).not.toContain('<id>');
			expect(r.to).toContain(`/sites/${siteId}`);
		}
		expect(doc.redirects).toContainEqual({
			from: '/_cfw/deploy',
			to: `/sites/${siteId}/readiness`
		});
	});

	it('lists the routes with a class and owner-token auth', () => {
		const doc = compose();
		const settings = doc.routes.find((r) => r.id === 'settings.write');
		expect(settings).toEqual({
			id: 'settings.write',
			method: 'PUT',
			path: '/settings',
			class: 'stateful',
			auth: 'owner-token'
		});
		expect(doc.routes.find((r) => r.id === 'settings.read')?.class).toBe('safe');
	});

	it('reports the health vocabulary the worker emits', () => {
		expect(compose().healthVocabulary).toEqual(['ok', 'info', 'warn', 'error', 'critical']);
	});

	it('states a capability with its reason and never drops one that is unnamed', () => {
		const doc = composeDrupalDiscovery({
			settings: fixture,
			release,
			siteId,
			capabilities: [
				{ id: 'http.outbound.deferred', expected: true, blocker: null },
				{ id: 'http.outbound.blocking', expected: false, blocker: 'platform' },
				{ id: 'cache.memory', expected: false, blocker: 'by-design' },
				{ id: 'x.unnamed', expected: false, blocker: null }
			]
		});
		expect(doc.capabilities).toEqual([
			{ id: 'http.outbound.deferred', state: 'enabled', reason: null },
			{ id: 'http.outbound.blocking', state: 'unavailable', reason: 'platform' },
			{ id: 'cache.memory', state: 'disabled', reason: 'by-design' },
			{ id: 'x.unnamed', state: 'disabled', reason: 'no blocker named' }
		]);
	});
});

describe('fetchDiscovery', () => {
	it('returns the native document when the site serves one', async () => {
		const doc = compose();
		const calls: string[] = [];
		const fetchFn: FetchLike = async (input) => {
			calls.push(input);
			return json(doc);
		};
		const got = await fetchDiscovery(site, fetchFn);
		expect(got).toEqual(doc);
		expect(calls).toEqual([`${site.origin}/.well-known/drupflare`]);
	});

	it('composes from the settings route only on a 404', async () => {
		const calls: string[] = [];
		const fetchFn: FetchLike = async (input) => {
			calls.push(input);
			return input.endsWith('/.well-known/drupflare')
				? new Response('', { status: 404 })
				: json(fixture);
		};
		const got = await fetchDiscovery(site, fetchFn);
		expect(calls).toEqual([`${site.origin}/.well-known/drupflare`, `${site.origin}/settings`]);
		expect(got.settings.etag).toBe(compose().settings.etag);
	});

	it('does not fall back on a server error', async () => {
		const calls: string[] = [];
		const fetchFn: FetchLike = async (input) => {
			calls.push(input);
			return new Response('boom', { status: 500 });
		};
		await expect(fetchDiscovery(site, fetchFn)).rejects.toMatchObject({ code: 'status' });
		expect(calls).toHaveLength(1);
	});

	it('throws a typed error for a malformed document, never a partial one', async () => {
		const fetchFn: FetchLike = async () => json({ v: 1, kind: 'drupal' });
		const err = await fetchDiscovery(site, fetchFn).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DiscoveryError);
		expect((err as DiscoveryError).code).toBe('malformed');
	});

	it('throws a typed error when the document is not JSON and the settings answer is not either', async () => {
		const fetchFn: FetchLike = async () => new Response('<html>', { status: 200 });
		await expect(fetchDiscovery(site, fetchFn)).rejects.toMatchObject({ code: 'malformed' });
	});

	it('treats a 200 that is not JSON as no document and composes from settings', async () => {
		const calls: string[] = [];
		const fetchFn: FetchLike = async (input) => {
			calls.push(input);
			return input.endsWith('/.well-known/drupflare')
				? new Response('<html>page</html>', {
						status: 200,
						headers: { 'content-type': 'text/html; charset=utf-8' }
					})
				: json(fixture);
		};
		const got = await fetchDiscovery(site, fetchFn);
		expect(calls).toEqual([`${site.origin}/.well-known/drupflare`, `${site.origin}/settings`]);
		expect(got.settings.etag).toBe(compose().settings.etag);
	});

	it('gives every request a timeout signal', async () => {
		const signals: unknown[] = [];
		const fetchFn: FetchLike = async (input, init) => {
			signals.push(init.signal);
			return input.endsWith('/.well-known/drupflare')
				? new Response('', { status: 404 })
				: json(fixture);
		};
		await fetchDiscovery(site, fetchFn);
		expect(signals).toHaveLength(2);
		for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
	});

	it('reports a settings route that does not answer as unreachable', async () => {
		const fetchFn: FetchLike = async (input) => {
			if (input.endsWith('/.well-known/drupflare')) return new Response('', { status: 404 });
			throw new TypeError('fetch failed');
		};
		await expect(fetchDiscovery(site, fetchFn)).rejects.toMatchObject({ code: 'unreachable' });
	});

	it('aborts a request that hangs at the timeout as unreachable', async () => {
		const fetchFn: FetchLike = (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			});
		await expect(fetchDiscovery(site, fetchFn, 20)).rejects.toMatchObject({
			code: 'unreachable'
		});
	});

	it('throws a typed error when the composed settings answer is malformed', async () => {
		const fetchFn: FetchLike = async (input) =>
			input.endsWith('/.well-known/drupflare')
				? new Response('', { status: 404 })
				: json({ ok: true, levers: [{ name: 'SPOOL', value: 0 }] });
		await expect(fetchDiscovery(site, fetchFn)).rejects.toMatchObject({ code: 'malformed' });
	});

	it('sends the owner token as a bearer credential', async () => {
		let auth: string | null = null;
		const fetchFn: FetchLike = async (_input, init) => {
			auth = new Headers(init.headers).get('authorization');
			return json(compose());
		};
		await fetchDiscovery(site, fetchFn);
		expect(auth).toBe(`Bearer ${site.ownerToken}`);
	});
});

type Sent = { ifMatch: string | null; body: unknown };

// a site whose settings read reports SPOOL at `spool`; PUTs are recorded and answered by `put`
function fakeSite(opts: { etag?: string; spool?: string; put?: () => Response } = {}): {
	fetchFn: FetchLike;
	sent: Sent[];
} {
	const sent: Sent[] = [];
	const fetchFn: FetchLike = async (input, init) => {
		expect(input).toBe(`${site.origin}/settings`);
		if (init.method === 'GET') {
			const levers = fixture.levers.map((l) =>
				l.name === 'SPOOL' && opts.spool !== undefined ? { ...l, value: opts.spool } : l
			);
			return json({ ...fixture, levers }, 200, opts.etag ? { etag: opts.etag } : {});
		}
		sent.push({
			ifMatch: new Headers(init.headers).get('if-match'),
			body: JSON.parse(String(init.body))
		});
		return opts.put
			? opts.put()
			: json({ ok: true, accepted: ['SPOOL'], refused: [], invalid: [] });
	};
	return { fetchFn, sent };
}

describe('writeSetting', () => {
	const siteEtag = '"site-etag-fixture"';

	it('reads the setting, then sends the value when it still matches the snapshot', async () => {
		const { fetchFn, sent } = fakeSite();
		const result = await writeSetting(site, 'SPOOL', 1, '0', fetchFn);
		expect(result).toEqual({ ok: true });
		expect(sent).toEqual([{ ifMatch: null, body: { SPOOL: 1 } }]);
	});

	it('sends If-Match with the site etag only when the site serves one', async () => {
		const { fetchFn, sent } = fakeSite({ etag: siteEtag });
		await writeSetting(site, 'SPOOL', 1, '0', fetchFn);
		expect(sent).toEqual([{ ifMatch: siteEtag, body: { SPOOL: 1 } }]);
	});

	it('returns a conflict with both values and sends nothing when the server value moved', async () => {
		const { fetchFn, sent } = fakeSite({ etag: siteEtag, spool: '1' });
		const result = await writeSetting(site, 'SPOOL', 0, '0', fetchFn);
		expect(result).toEqual({
			ok: false,
			kind: 'conflict',
			key: 'SPOOL',
			server: '1',
			snapshot: '0',
			sent: 0
		});
		expect(sent).toEqual([]);
	});

	it('maps a 412 from the site to a conflict with the server value', async () => {
		const { fetchFn } = fakeSite({
			etag: siteEtag,
			put: () => json({ ok: false, value: '1' }, 412)
		});
		const result = await writeSetting(site, 'SPOOL', 1, '0', fetchFn);
		expect(result).toEqual({
			ok: false,
			kind: 'conflict',
			key: 'SPOOL',
			server: '1',
			snapshot: '0',
			sent: 1
		});
	});

	it('never sends a key that is not writable', async () => {
		let calls = 0;
		const fetchFn: FetchLike = async () => {
			calls++;
			return json({ ok: true });
		};
		for (const key of ['PLAN', 'SMTP_HOST', 'WRITE_FORWARD', 'NOT_A_LEVER']) {
			const result = await writeSetting(site, key, '1', '0', fetchFn);
			expect(result).toMatchObject({ ok: false, kind: 'refused', key });
		}
		expect(calls).toBe(0);
	});

	it('reports a value the site refused even though the request succeeded', async () => {
		const { fetchFn } = fakeSite({
			put: () =>
				json({
					ok: true,
					accepted: [],
					refused: [],
					invalid: [{ name: 'SPOOL', reason: 'SPOOL must be 0 or 1; got 7' }]
				})
		});
		const result = await writeSetting(site, 'SPOOL', 7, '0', fetchFn);
		expect(result).toMatchObject({ ok: false, kind: 'rejected' });
	});

	it('rejects without writing when the fresh read fails', async () => {
		let puts = 0;
		const fetchFn: FetchLike = async (_input, init) => {
			if (init.method === 'GET') return new Response('boom', { status: 500 });
			puts++;
			return json({ ok: true });
		};
		const result = await writeSetting(site, 'SPOOL', 1, '0', fetchFn);
		expect(result).toMatchObject({ ok: false, kind: 'rejected', key: 'SPOOL' });
		expect(puts).toBe(0);
	});

	it('rejects without writing when the site does not answer', async () => {
		const fetchFn: FetchLike = async () => {
			throw new TypeError('fetch failed');
		};
		const result = await writeSetting(site, 'SPOOL', 1, '0', fetchFn);
		expect(result).toMatchObject({ ok: false, kind: 'rejected', key: 'SPOOL' });
	});
});
