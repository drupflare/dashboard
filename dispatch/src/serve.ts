import type { Lease, RenewalRequest } from '@contracts/site-auth';
import {
	admit,
	afterRenewal,
	blockedByBudget,
	callLimits,
	countingLimit,
	type AdmitContext,
	type CallLimits,
	type Decision,
	type Refused,
	type RenewalOutcome,
	type Served
} from './admit';
import { applyMessageSchema, type ApplyResult, type SiteAuthResult } from './authority';
import { COUNTS_PATH, countsRoute, type CountsReader } from './control-counts';
import { gate, type GateDeps } from './gate';
import { isOwnerRequest } from './owner-routes';
import { normalizeHost, resolveRoute, type Route } from './route';
import { SPIKE_PREFIX, spikeRoute, type Spike } from './spike';
import type { View } from './usage';
import type { ViewCounter } from './view-counter';

export type SiteAuthClient = {
	lease(request: { siteId: string; epoch: number }): Promise<SiteAuthResult>;
	renew(request: RenewalRequest): Promise<SiteAuthResult>;
	apply(message: unknown): Promise<ApplyResult>;
};

export type ServeDeps = {
	now(): number;
	publicKey: string;
	controlHost?: string;
	readRoute(host: string): Promise<string | null>;
	siteAuth(siteId: string): SiteAuthClient;
	tenant(script: string, limits: CallLimits): { fetch(request: Request): Promise<Response> };
	cache: Map<string, Lease>;
	inflight: Map<string, Promise<Served | Refused>>;
	// revoked is final for an epoch, so the answer is safe to keep and spares the object a call per request
	revoked: Set<string>;
	waitUntil(promise: Promise<unknown>): void;
	onView?(view: View): void;
	// set only when the stage switch is on
	spike?: Spike;
	// production counting; a site the spike has a mechanism for is counted by the spike instead
	counter?: ViewCounter;
	// the control key and the per-site counter object, for the signed counts read
	controlKey?: string;
	counts?(siteId: string): CountsReader;
	// without it a gated environment fails closed
	gate?: GateDeps;
	askTimeoutMs?: number;
	skewMs?: number;
	graceMs?: number;
};

export const MAX_CACHED_LEASES = 5_000;
export const DEFAULT_ASK_TIMEOUT_MS = 2_000;
const MAX_CONTROL_BODY = 4_096;

const STATUS: Record<string, number> = {
	unknown_host: 404,
	malformed_route: 404,
	wrong_site: 404,
	wrong_epoch: 404,
	unknown_site: 404,
	suspended: 403,
	revoked: 403,
	expired: 503,
	unavailable: 503,
	bad_signature: 503,
	malformed: 503,
	unsupported_version: 503
};

function refusal(code: string): Response {
	const status = STATUS[code] ?? 503;
	const headers: Record<string, string> = { 'cache-control': 'no-store' };
	if (status === 503) headers['retry-after'] = '5';
	return new Response(status === 404 ? 'Not found' : 'Unavailable', { status, headers });
}

// neutral on purpose: a visitor learns nothing about plans, billing or budgets
const BUDGET_PAGE =
	'<!doctype html><html lang="en"><meta charset="utf-8"><title>Unavailable</title><p>This site is temporarily unavailable.</p></html>';

// a refusal is a request and never a view, so nothing is counted; the metric keeps it observable
function budgetRefusal(host: string, siteId: string, deps: ServeDeps): Response {
	const onView = deps.onView;
	if (onView) {
		const view = { siteId, host, status: 503, serving: 'over-budget', served: false };
		deps.waitUntil(Promise.resolve().then(() => onView(view)));
	}
	return new Response(BUDGET_PAGE, {
		status: 503,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'retry-after': '60'
		}
	});
}

function ask(call: () => Promise<SiteAuthResult>, timeoutMs: number): Promise<RenewalOutcome> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve({ kind: 'unreachable' }), timeoutMs);
		call().then(
			(result) => {
				clearTimeout(timer);
				resolve(
					result.ok
						? { kind: 'lease', lease: result.lease }
						: { kind: 'refused', code: result.code }
				);
			},
			() => {
				clearTimeout(timer);
				resolve({ kind: 'unreachable' });
			}
		);
	});
}

function remember(deps: ServeDeps, key: string, lease: Lease): void {
	// a strict lease is never reused, so nothing stays cached for it
	if (lease.mode !== 'lease') {
		deps.cache.delete(key);
		return;
	}
	deps.cache.delete(key);
	deps.cache.set(key, lease);
	if (deps.cache.size > MAX_CACHED_LEASES) {
		const oldest = deps.cache.keys().next().value;
		if (oldest !== undefined) deps.cache.delete(oldest);
	}
}

// requests share one renewal only in lease mode, where the lease bounds how stale an answer can be
function shared(deps: ServeDeps, key: string, start: () => Promise<Served | Refused>) {
	let pending = deps.inflight.get(key);
	if (!pending) {
		pending = start().finally(() => deps.inflight.delete(key));
		deps.inflight.set(key, pending);
	}
	return pending;
}

async function forward(
	request: Request,
	host: string,
	route: Route,
	lease: Lease,
	serving: string,
	deps: ServeDeps
): Promise<Response> {
	const spike = deps.spike;
	// the lookup runs beside the tenant call
	const chosen = spike?.mechanismFor(route.siteId);
	let response: Response;
	try {
		response = await deps.tenant(route.script, callLimits(lease.limits)).fetch(request);
	} catch {
		response = new Response('Bad gateway', {
			status: 502,
			headers: { 'cache-control': 'no-store' }
		});
	}
	const onView = deps.onView;
	if (onView) {
		const view = { siteId: route.siteId, host, status: response.status, serving };
		deps.waitUntil(Promise.resolve().then(() => onView(view)));
	}
	const name = await chosen;
	const view = {
		siteId: route.siteId,
		status: response.status,
		contentType: response.headers.get('content-type'),
		limit: countingLimit(lease.limits)
	};
	if (spike && name) await spike.count(name, view, deps.waitUntil);
	else if (deps.counter) await deps.counter.count(view, deps.waitUntil);
	return response;
}

async function control(request: Request, deps: ServeDeps): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path.startsWith(SPIKE_PREFIX)) {
		const answer = deps.spike ? await spikeRoute(request, deps.spike, deps.now()) : null;
		return answer ?? refusal('unknown_host');
	}
	if (path === COUNTS_PATH) {
		if (deps.controlKey === undefined || deps.counts === undefined) {
			return refusal('unknown_host');
		}
		return countsRoute(request, {
			controlKey: deps.controlKey,
			now: deps.now,
			counter: deps.counts
		});
	}
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	const text = await request.text();
	if (text.length > MAX_CONTROL_BODY) return new Response('Too large', { status: 413 });
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return Response.json({ ok: false, code: 'malformed' }, { status: 400 });
	}
	const parsed = applyMessageSchema.safeParse(json);
	if (!parsed.success) return Response.json({ ok: false, code: 'malformed' }, { status: 400 });
	let result: ApplyResult;
	try {
		result = await deps.siteAuth(parsed.data.siteId).apply(json);
	} catch {
		return Response.json({ ok: false, code: 'unavailable' }, { status: 503 });
	}
	return Response.json(result, { status: result.ok ? 200 : 409 });
}

export async function serve(request: Request, deps: ServeDeps): Promise<Response> {
	const host = normalizeHost(new URL(request.url).hostname);
	if (host === null) return refusal('unknown_host');
	if (deps.controlHost !== undefined && host === deps.controlHost) return control(request, deps);
	let raw: string | null;
	try {
		raw = await deps.readRoute(host);
	} catch {
		return refusal('unavailable');
	}
	const resolved = resolveRoute(host, raw);
	if (!resolved.ok) return refusal(resolved.code);
	const route = resolved.value;
	const key = `${route.siteId}:${route.epoch}`;
	const timeoutMs = deps.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
	const context = (): AdmitContext => ({
		publicKey: deps.publicKey,
		now: deps.now(),
		siteId: route.siteId,
		epoch: route.epoch,
		skewMs: deps.skewMs,
		graceMs: deps.graceMs
	});
	const client = () => deps.siteAuth(route.siteId);
	// the owner's own routes pass a block so export, restore and backups stay reachable; the site
	// still checks the token, so a request with a made-up one reaches the site and is refused there
	const proceed = async (lease: Lease, serving: string) => {
		const seen = deps.counter?.acknowledged(route.siteId, deps.now()) ?? null;
		if (blockedByBudget(lease, seen) && !isOwnerRequest(request)) {
			return budgetRefusal(host, route.siteId, deps);
		}
		return (
			(await gate(request, host, route, lease, deps.now(), deps.gate)) ??
			forward(request, host, route, lease, serving, deps)
		);
	};
	// the answer is checked and cached inside the shared promise, so a waiter that arrives after it
	// settles finds the new lease instead of starting a second call
	const refresh = async (
		held: Lease | undefined,
		useRenew: boolean
	): Promise<Served | Refused> => {
		const outcome = await ask(
			() =>
				useRenew && held
					? client().renew({
							v: 1,
							siteId: route.siteId,
							epoch: route.epoch,
							generation: held.generation
						} as RenewalRequest)
					: client().lease({ siteId: route.siteId, epoch: route.epoch }),
			timeoutMs
		);
		const after = await afterRenewal(outcome, held, context());
		if (after.action === 'serve') remember(deps, key, after.lease);
		else if (outcome.kind === 'refused') {
			deps.cache.delete(key);
			if (outcome.code === 'revoked') {
				deps.revoked.add(key);
				if (deps.revoked.size > MAX_CACHED_LEASES) {
					const oldest = deps.revoked.values().next().value;
					if (oldest !== undefined) deps.revoked.delete(oldest);
				}
			}
		}
		// a suspended lease passed the signature check, so keep it and spare SITE_AUTH repeat asks
		else if (outcome.kind === 'lease' && after.code === 'suspended') {
			remember(deps, key, outcome.lease as Lease);
		}
		return after;
	};

	if (deps.revoked.has(key)) return refusal('revoked');

	const held = deps.cache.get(key);
	const decision: Decision = await admit(held, context());

	if (decision.action === 'refuse') {
		if (held && decision.code !== 'suspended') deps.cache.delete(key);
		return refusal(decision.code);
	}

	if (decision.action === 'serve') {
		if (decision.renew) {
			deps.waitUntil(shared(deps, key, () => refresh(held, true)));
		}
		return proceed(decision.lease, decision.serving);
	}

	// a request that waited on the check may find another request already renewed the lease
	const latest = deps.cache.get(key);
	if (decision.reason === 'expired' && latest !== undefined && latest !== held) {
		const again = await admit(latest, context());
		if (again.action === 'serve') {
			return proceed(again.lease, again.serving);
		}
	}

	const after =
		decision.reason === 'expired'
			? await shared(deps, key, () => refresh(held, true))
			: await refresh(held, false);
	if (after.action === 'refuse') return refusal(after.code);
	return proceed(after.lease, after.serving);
}
