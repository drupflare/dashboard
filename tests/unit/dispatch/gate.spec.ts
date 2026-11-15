import { generateSigningKey, type SigningKey } from '@contracts/common';
import { signGateAssertion } from '@contracts/gate-assertion';
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_LEASE_MS, withAccess } from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
import {
	allowedReturn,
	encodeAssertion,
	GATE_COOKIE,
	GATE_PARAM,
	type GateDeps
} from '../../../dispatch/src/gate';
import { serve, type ServeDeps } from '../../../dispatch/src/serve';
import { authorityState, makeRig } from './fakes';

const HOST = 'staging-calm-river.drupflare.app';
const ORIGIN = 'https://gate.drupflare.test';
const HASH = `sha256:${'a'.repeat(64)}`;

async function world(options: { gated?: boolean; withGate?: boolean } = {}) {
	const rig = await makeRig();
	const gateKey: SigningKey = await generateSigningKey();
	const state = await authorityState({
		epoch: 3,
		...(options.gated === false ? {} : { gates: { env_1: HASH } })
	});
	await rig.commit(state);
	const served: string[] = [];
	const gate: GateDeps = { publicKey: gateKey.publicKey, origin: ORIGIN, seen: new Set() };
	const deps: ServeDeps = {
		now: rig.clock.now,
		publicKey: rig.lease.publicKey,
		readRoute: async (host) =>
			host === HOST
				? JSON.stringify({
						v: 1,
						siteId: state.siteId,
						script: 'tenant-one',
						epoch: 3,
						environment: 'env_1'
					})
				: null,
		siteAuth: () => rig.client,
		tenant: () => ({
			fetch: async (request) => {
				served.push(new URL(request.url).pathname);
				return new Response('tenant');
			}
		}),
		cache: new Map(),
		inflight: new Map(),
		revoked: new Set(),
		waitUntil: () => undefined,
		...(options.withGate === false ? {} : { gate })
	};
	const get = (path = '/page', headers: Record<string, string> = {}) =>
		serve(new Request(`https://${HOST}${path}`, { headers }), deps);
	const assertion = (
		patch: Partial<Parameters<typeof signGateAssertion>[0]> = {},
		key = gateKey
	) =>
		signGateAssertion(
			{
				siteId: state.siteId,
				environment: 'env_1',
				ruleHash: HASH,
				sub: 'visitor-1',
				...patch
			},
			rig.clock.now(),
			key
		);
	const arrive = (value: unknown) => get(`/page?${GATE_PARAM}=${encodeAssertion(value)}`);
	return { rig, state, deps, gate, served, get, assertion, arrive };
}

function cookieOf(response: Response): string {
	const header = response.headers.get('set-cookie') ?? '';
	return header.split(';')[0]!;
}

describe('the Gate on dispatch', () => {
	it('serves an environment the lease does not list without asking for anything', async () => {
		const w = await world({ gated: false });
		const response = await w.get();
		expect(response.status).toBe(200);
		expect(w.served).toEqual(['/page']);
	});

	it('sends a visitor with no cookie to the Gate with the site, the environment and a return to its own host', async () => {
		const w = await world();
		const response = await w.get('/page?x=1');
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get('location')!);
		expect(location.origin).toBe(ORIGIN);
		expect(location.searchParams.get('site')).toBe(w.state.siteId);
		expect(location.searchParams.get('env')).toBe('env_1');
		expect(location.searchParams.get('return')).toBe(`https://${HOST}/page?x=1`);
		expect(w.served).toEqual([]);
	});

	it('admits a valid assertion, sets the host-only cookie and then serves on the cookie', async () => {
		const w = await world();
		const arrived = await w.arrive(await w.assertion());
		expect(arrived.status).toBe(302);
		expect(arrived.headers.get('location')).toBe(`https://${HOST}/page`);
		const header = arrived.headers.get('set-cookie')!;
		expect(header.startsWith(`${GATE_COOKIE}=`)).toBe(true);
		expect(GATE_COOKIE.startsWith('__Host-')).toBe(true);
		expect(header).toContain('Secure');
		expect(header).toContain('HttpOnly');
		expect(header).toContain('SameSite=Lax');
		expect(header).toContain('Path=/');
		expect(header).not.toContain('Domain');
		const next = await w.get('/page', { cookie: cookieOf(arrived) });
		expect(next.status).toBe(200);
		expect(w.served).toEqual(['/page']);
	});

	it('refuses a forged assertion and sends the visitor back to the Gate', async () => {
		const w = await world();
		const forged = await w.assertion({}, await generateSigningKey());
		const response = await w.arrive(forged);
		expect(response.headers.get('location')).toContain(ORIGIN);
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('refuses an expired assertion', async () => {
		const w = await world();
		const old = await w.assertion();
		w.rig.clock.advance(old.exp - old.iat + 60_000);
		const response = await w.arrive(old);
		expect(response.headers.get('location')).toContain(ORIGIN);
		expect(response.headers.get('set-cookie')).toBeNull();
	});

	it('refuses an assertion id it has already taken in', async () => {
		const w = await world();
		const once = await w.assertion();
		expect((await w.arrive(once)).headers.get('set-cookie')).not.toBeNull();
		const again = await w.arrive(once);
		expect(again.headers.get('set-cookie')).toBeNull();
		expect(again.headers.get('location')).toContain(ORIGIN);
	});

	it('refuses an assertion made for another site', async () => {
		const w = await world();
		const other = await w.assertion({ siteId: 'site_someothersite01' });
		expect((await w.arrive(other)).headers.get('set-cookie')).toBeNull();
	});

	it('refuses an assertion made for another environment', async () => {
		const w = await world();
		const other = await w.assertion({ environment: 'env_2' });
		expect((await w.arrive(other)).headers.get('set-cookie')).toBeNull();
	});

	it('refuses an assertion that carries a stale rule hash', async () => {
		const w = await world();
		const stale = await w.assertion({ ruleHash: `sha256:${'b'.repeat(64)}` });
		expect((await w.arrive(stale)).headers.get('set-cookie')).toBeNull();
	});

	it('refuses a garbled token and a garbled cookie', async () => {
		const w = await world();
		expect((await w.arrive({ nonsense: true })).headers.get('location')).toContain(ORIGIN);
		const bad = await w.get('/page', { cookie: `${GATE_COOKIE}=%%%` });
		expect(bad.status).toBe(302);
	});

	it('fails closed when a gated environment has no Gate configured', async () => {
		const w = await world({ withGate: false });
		const response = await w.get();
		expect(response.status).toBe(503);
		expect(w.served).toEqual([]);
	});

	it('stops honouring a cookie at the next lease renewal after a rule is removed', async () => {
		const w = await world();
		const arrived = await w.arrive(await w.assertion());
		const cookie = cookieOf(arrived);
		expect((await w.get('/page', { cookie })).status).toBe(200);

		const changed = withAccess(w.state, {
			accessRuleHash: `sha256:${'c'.repeat(64)}`,
			gates: { env_1: `sha256:${'d'.repeat(64)}` }
		});
		await w.rig.commit(changed);

		// the held lease still carries the old hash, so the cookie works until it expires
		expect((await w.get('/page', { cookie })).status).toBe(200);

		w.rig.clock.advance(DEFAULT_LEASE_MS + DEFAULT_CLOCK_SKEW_MS + 1);
		const after = await w.get('/page', { cookie });
		expect(after.status).toBe(302);
		expect(after.headers.get('location')).toContain(ORIGIN);
	});
});

describe('allowedReturn', () => {
	it('keeps the redirect after sign-in on the request host even for a double-slash path', async () => {
		const w = await world();
		const token = encodeAssertion(await w.assertion());
		const response = await serve(
			new Request(`https://${HOST}//evil.example/x?${GATE_PARAM}=${token}`),
			w.deps
		);
		expect(new URL(response.headers.get('location')!).hostname).toBe(HOST);
	});

	const hosts = [HOST];

	it('keeps a target on the site own https host', () => {
		expect(allowedReturn(`https://${HOST}/a?b=1`, hosts)).toBe(`https://${HOST}/a?b=1`);
	});

	it('refuses another host, plain http, embedded credentials and non-urls', () => {
		expect(allowedReturn('https://evil.example/', hosts)).toBeNull();
		expect(allowedReturn(`https://${HOST}.evil.example/`, hosts)).toBeNull();
		expect(allowedReturn(`http://${HOST}/`, hosts)).toBeNull();
		expect(allowedReturn(`https://user:pw@${HOST}/`, hosts)).toBeNull();
		expect(allowedReturn(`https://${HOST}@evil.example/`, hosts)).toBeNull();
		expect(allowedReturn('//evil.example/', hosts)).toBeNull();
		expect(allowedReturn('not a url', hosts)).toBeNull();
	});

	it('never builds a Gate return that leaves the request host', async () => {
		const w = await world();
		const response = await serve(
			new Request(`https://${HOST}//evil.example/x?return=https://evil.example/`),
			w.deps
		);
		const target = new URL(
			new URL(response.headers.get('location')!).searchParams.get('return')!
		);
		expect(target.hostname).toBe(HOST);
	});
});
