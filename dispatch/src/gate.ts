import { fromBase64Url, toBase64Url, utf8 } from '@contracts/common';
import { verifyGateAssertion } from '@contracts/gate-assertion';
import type { Lease } from '@contracts/site-auth';
import type { Route } from './route';

export const GATE_COOKIE = '__Host-drupflare-gate';
export const GATE_PARAM = '__gate';
export const MAX_SEEN_ASSERTIONS = 5_000;

export type GateDeps = {
	publicKey: string;
	// the Gate's own origin, such as https://gate.drupflare.com
	origin: string;
	// ponytail: per isolate, so a replay in another isolate within the lifetime still lands; move to the site's object if that matters
	seen: Set<string>;
};

const NO_STORE = { 'cache-control': 'no-store' };

function decode(text: string): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(fromBase64Url(text)));
	} catch {
		return undefined;
	}
}

export function encodeAssertion(assertion: unknown): string {
	return toBase64Url(utf8(JSON.stringify(assertion)));
}

function readCookie(header: string | null): string | undefined {
	for (const part of (header ?? '').split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === GATE_COOKIE) return rest.join('=');
	}
	return undefined;
}

// a return target is only ever one of the site's own https hosts
export function allowedReturn(target: string, hosts: readonly string[]): string | null {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
	return hosts.includes(url.hostname.toLowerCase()) ? url.toString() : null;
}

function toGate(request: Request, host: string, route: Route, environment: string, deps: GateDeps) {
	const back = new URL(request.url);
	back.searchParams.delete(GATE_PARAM);
	const target = allowedReturn(back.toString(), [host]);
	if (target === null) return new Response('Not found', { status: 404, headers: NO_STORE });
	const url = new URL(deps.origin);
	url.searchParams.set('site', route.siteId);
	url.searchParams.set('env', environment);
	url.searchParams.set('return', target);
	return new Response(null, { status: 302, headers: { ...NO_STORE, location: url.toString() } });
}

// null means serve; the Gate is only asked about an environment the lease lists
export async function gate(
	request: Request,
	host: string,
	route: Route,
	lease: Lease,
	now: number,
	deps: GateDeps | undefined
): Promise<Response | null> {
	const environment = route.environment ?? 'prod';
	const ruleHash = lease.gates?.[environment];
	if (ruleHash === undefined) return null;
	if (deps === undefined) {
		return new Response('Unavailable', {
			status: 503,
			headers: { ...NO_STORE, 'retry-after': '5' }
		});
	}
	const check = { publicKey: deps.publicKey, now, siteId: route.siteId, environment, ruleHash };
	const url = new URL(request.url);
	const arriving = url.searchParams.get(GATE_PARAM);
	if (arriving !== null) {
		const result = await verifyGateAssertion(decode(arriving), { ...check, seen: deps.seen });
		if (!result.ok) return toGate(request, host, route, environment, deps);
		const { id, exp } = result.value;
		deps.seen.add(id);
		if (deps.seen.size > MAX_SEEN_ASSERTIONS) {
			const oldest = deps.seen.values().next().value;
			if (oldest !== undefined) deps.seen.delete(oldest);
		}
		url.searchParams.delete(GATE_PARAM);
		const maxAge = Math.max(1, Math.floor((exp - now) / 1000));
		const headers = new Headers({
			...NO_STORE,
			location: `https://${host}${url.pathname}${url.search}`
		});
		headers.append(
			'set-cookie',
			`${GATE_COOKIE}=${encodeAssertion(result.value)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`
		);
		return new Response(null, { status: 302, headers });
	}
	const held = readCookie(request.headers.get('cookie'));
	if (held !== undefined) {
		const result = await verifyGateAssertion(decode(held), check);
		if (result.ok) return null;
	}
	return toGate(request, host, route, environment, deps);
}
