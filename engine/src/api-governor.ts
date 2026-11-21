import { readRetryAfter } from '@drupflare/workforce';
import { RateLimitedError } from './account-usage';

export const SHARED_QUOTA = 1200;
export const SHARED_WINDOW_MS = 300_000;
export const DEFAULT_MAX_WAIT_MS = 30_000;
const RING_SIZE = 100;
const LIST_ZONES = 'list_zones';
const DEFAULT_POLICY = 'default';

export interface RateHeaders {
	get(name: string): string | null;
}

export type Admission = { ok: true } | { ok: false; waitMs: number };

export interface Observation {
	policy: string;
	r: number;
	t: number | null;
	at: number;
}

export interface Bucket {
	quota: number | null;
	windowSeconds: number | null;
	remaining: number | null;
	resetAt: number | null;
	pausedUntil: number;
}

export interface GovernorState {
	shared: number[];
	buckets: Map<string, Bucket>;
	ring: Observation[];
}

// the port the wrapper talks to; ApiGovernor satisfies it in process, the Durable Object over RPC
export interface GovernorPort {
	admit(policy: string, now: number): Promise<Admission> | Admission;
	observe(policy: string, headers: RateHeaders, now: number): Promise<void> | void;
	retryAfter(policy: string, seconds: number, now: number): Promise<void> | void;
}

interface Item {
	name: string | null;
	params: Record<string, number>;
}

const NAME = /^"([^"]+)"$/;
const PARAM = /^([a-z]+)=(\d+(?:\.\d+)?)$/i;

// splits `"default";r=1;t=2, "list_zones";r=3` into items; a malformed part is dropped, not thrown
export function parseItems(header: string | null): Item[] {
	if (header === null) return [];
	const items: Item[] = [];
	for (const raw of header.split(',')) {
		const parts = raw
			.split(';')
			.map((part) => part.trim())
			.filter((part) => part !== '');
		if (parts.length === 0) continue;
		const named = NAME.exec(parts[0] ?? '');
		const name = named?.[1] ?? null;
		const params: Record<string, number> = {};
		for (const part of named === null ? parts : parts.slice(1)) {
			const match = PARAM.exec(part);
			if (match === null) continue;
			const value = Number(match[2]);
			if (Number.isFinite(value)) params[(match[1] ?? '').toLowerCase()] = value;
		}
		if (name === null && Object.keys(params).length === 0) continue;
		items.push({ name, params });
	}
	return items;
}

function freshState(): GovernorState {
	return { shared: [], buckets: new Map(), ring: [] };
}

function blankBucket(): Bucket {
	return {
		quota: null,
		windowSeconds: null,
		remaining: null,
		resetAt: null,
		pausedUntil: 0
	};
}

// the API's own counts per policy, with a shared sliding count over every request the governor admits
export class ApiGovernor implements GovernorPort {
	constructor(readonly state: GovernorState = freshState()) {}

	admit(policy: string, now: number): Admission {
		const { shared } = this.state;
		while (shared.length > 0 && (shared[0] ?? 0) <= now - SHARED_WINDOW_MS) shared.shift();

		let waitMs = 0;
		const bucket = this.state.buckets.get(policy);
		if (bucket !== undefined) {
			if (now < bucket.pausedUntil) waitMs = Math.max(waitMs, bucket.pausedUntil - now);
			if (
				this.windowOpen(bucket, now) &&
				bucket.remaining !== null &&
				bucket.remaining <= 0
			) {
				waitMs = Math.max(waitMs, (bucket.resetAt ?? now) - now);
			}
		}
		if (shared.length >= SHARED_QUOTA) {
			waitMs = Math.max(waitMs, (shared[0] ?? now) + SHARED_WINDOW_MS - now);
		}
		if (waitMs > 0) return { ok: false, waitMs };

		shared.push(now);
		if (bucket !== undefined && bucket.remaining !== null && this.windowOpen(bucket, now)) {
			bucket.remaining -= 1;
		}
		return { ok: true };
	}

	observe(policy: string, headers: RateHeaders, now: number): void {
		for (const item of parseItems(headers.get('ratelimit'))) {
			const r = item.params['r'];
			if (r === undefined) continue;
			const name = item.name ?? policy;
			const bucket = this.bucketOf(name);
			const t = item.params['t'] ?? null;
			bucket.remaining =
				bucket.remaining === null || !this.windowOpen(bucket, now)
					? r
					: Math.min(bucket.remaining, r);
			if (t !== null) bucket.resetAt = now + t * 1000;
			this.record({ policy: name, r, t, at: now });
		}
		for (const item of parseItems(headers.get('ratelimit-policy'))) {
			const bucket = this.bucketOf(item.name ?? policy);
			bucket.quota = item.params['q'] ?? bucket.quota;
			bucket.windowSeconds = item.params['w'] ?? bucket.windowSeconds;
		}
	}

	retryAfter(policy: string, seconds: number, now: number): void {
		if (!Number.isFinite(seconds) || seconds <= 0) return;
		const bucket = this.bucketOf(policy);
		bucket.pausedUntil = Math.max(bucket.pausedUntil, now + seconds * 1000);
	}

	observations(): Observation[] {
		return this.state.ring.slice();
	}

	// without a reset time the window is unknown, so the last r is trusted as is and never counted down
	private windowOpen(bucket: Bucket, now: number): boolean {
		return bucket.resetAt !== null && now < bucket.resetAt;
	}

	private bucketOf(policy: string): Bucket {
		const existing = this.state.buckets.get(policy);
		if (existing !== undefined) return existing;
		const created = blankBucket();
		this.state.buckets.set(policy, created);
		return created;
	}

	private record(observation: Observation): void {
		// ponytail: the whole state is rewritten per call; the ring is 100 rows and the shared log at most 1200 numbers, so it fits one storage value
		this.state.ring.push(observation);
		if (this.state.ring.length > RING_SIZE) this.state.ring.shift();
	}
}

// what a namespace stub exposes; RPC makes every call a promise, so the port accepts either
export interface ApiBudgetStub {
	admit(policy: string, now: number): Promise<Admission> | Admission;
	observe(
		policy: string,
		limit: string | null,
		limitPolicy: string | null,
		now: number
	): Promise<void> | void;
	retryAfter(policy: string, seconds: number, now: number): Promise<void> | void;
}

// the RPC form of the port; the headers cross the boundary as the two strings they are
export function apiBudgetPort(stub: ApiBudgetStub): GovernorPort {
	return {
		admit: (policy, now) => stub.admit(policy, now),
		observe: (policy, headers, now) =>
			stub.observe(policy, headers.get('ratelimit'), headers.get('ratelimit-policy'), now),
		retryAfter: (policy, seconds, now) => stub.retryAfter(policy, seconds, now)
	};
}

export interface GovernedFetchOptions {
	maxWaitMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	// workforce retries a 429 on its own, so a wrapped caller turns this off or each attempt sends two requests
	retryOnce?: boolean;
	// a direct caller that wants a typed refusal; the default answers with a synthetic 429
	throwOnRefusal?: boolean;
}

type FetchInput = string | URL | Request;

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// a guess made before the response; the response's own header names the policy it counted against
export function policyOf(input: FetchInput, init?: RequestInit): string {
	const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
	const method = (init?.method ?? 'GET').toUpperCase();
	const path = new URL(href).pathname;
	return method === 'GET' && path.endsWith('/zones') ? LIST_ZONES : DEFAULT_POLICY;
}

function namedPolicy(headers: RateHeaders, fallback: string): string {
	return parseItems(headers.get('ratelimit'))[0]?.name ?? fallback;
}

// the wait is capped per call; past the cap the call is refused rather than parked
export function governedFetch(
	fetch: (input: FetchInput, init?: RequestInit) => Promise<Response>,
	governor: GovernorPort,
	options: GovernedFetchOptions = {}
): (input: FetchInput, init?: RequestInit) => Promise<Response> {
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const retryOnce = options.retryOnce ?? true;
	const throwOnRefusal = options.throwOnRefusal ?? false;

	async function admit(policy: string): Promise<Admission> {
		let waited = 0;
		for (;;) {
			const admission = await governor.admit(policy, now());
			if (admission.ok || waited + admission.waitMs > maxWaitMs) return admission;
			waited += admission.waitMs;
			await sleep(admission.waitMs);
		}
	}

	// answered like a remote 429 so a caller paces on Retry-After; it is not sent, so it is not an observation
	function refuse(policy: string, waitMs: number): Response {
		if (throwOnRefusal) {
			throw new RateLimitedError(
				`the API budget for ${policy} is spent and the wait passes ${maxWaitMs} ms`,
				waitMs
			);
		}
		return new Response(JSON.stringify({ ok: false, code: 'governed' }), {
			status: 429,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
				'retry-after': String(Math.ceil(waitMs / 1000))
			}
		});
	}

	return async (input, init) => {
		const policy = policyOf(input, init);
		const admission = await admit(policy);
		if (!admission.ok) return refuse(policy, admission.waitMs);
		const first = await fetch(input, init);
		await governor.observe(policy, first.headers, now());
		if (first.status !== 429) return first;

		const pausedMs = readRetryAfter(first.headers, now());
		if (pausedMs === null) return first;
		const counted = namedPolicy(first.headers, policy);
		await governor.retryAfter(counted, pausedMs / 1000, now());
		if (!retryOnce || pausedMs > maxWaitMs) return first;

		const again = await admit(counted);
		if (!again.ok) return first;
		const second = await fetch(input, init);
		await governor.observe(counted, second.headers, now());
		return second;
	};
}
