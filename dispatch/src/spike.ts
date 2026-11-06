import {
	omitSig,
	signatureSchema,
	signCanonical,
	verifyCanonical,
	type Verified
} from '@contracts/common';
import { z } from 'zod';
import { APPLY_MAX_AGE_MS } from './authority';
import {
	createAccounting,
	DEFAULT_OPTIONS,
	mechanism,
	MECHANISMS,
	type Accounting,
	type ApplyAnswer,
	type CountedHour,
	type CounterStats,
	type CountingOptions,
	type CountWrite,
	type MechanismName
} from './counting';

export const SPIKE_PREFIX = '/__spike/';
export const SPIKE_CONTEXT = 'drupflare.dispatch.spike.v1';
const MAX_BODY = 4_096;
const MAX_HOURS = 48;

// #region signed requests

const base = { v: z.literal(1), iat: z.int().nonnegative(), sig: signatureSchema };

export const spikeMessageSchema = z.discriminatedUnion('op', [
	z.object({ ...base, op: z.literal('evict') }).strict(),
	z
		.object({
			...base,
			op: z.literal('counts'),
			siteId: z.string().min(1).max(64),
			hours: z.array(z.int().nonnegative()).max(MAX_HOURS)
		})
		.strict()
]);

export type SpikeMessage = z.infer<typeof spikeMessageSchema>;
export type SpikeBody = { op: 'evict' } | { op: 'counts'; siteId: string; hours: number[] };
export type SpikeRefusal = 'malformed' | 'bad_signature' | 'stale_message';

// the control key signs these under their own context, so an apply write cannot stand in for one
export async function signSpike(
	body: SpikeBody,
	iat: number,
	privateKey: CryptoKey
): Promise<SpikeMessage> {
	const unsigned = { ...body, v: 1 as const, iat };
	const sig = await signCanonical(SPIKE_CONTEXT, unsigned, privateKey);
	return { ...unsigned, sig } as SpikeMessage;
}

export async function verifySpike(
	raw: unknown,
	controlKey: string,
	now: number
): Promise<Verified<SpikeMessage, SpikeRefusal>> {
	const parsed = spikeMessageSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const message = parsed.data;
	const valid = await verifyCanonical(SPIKE_CONTEXT, omitSig(message), message.sig, controlKey);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (Math.abs(now - message.iat) > APPLY_MAX_AGE_MS) return { ok: false, code: 'stale_message' };
	return { ok: true, value: message };
}

// #endregion

// #region mechanism per site

export function parseMechanism(raw: string | null): MechanismName | null {
	return (MECHANISMS as readonly (string | null)[]).includes(raw) ? (raw as MechanismName) : null;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomOrigin(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// holds memory until the limit ends the isolate; an isolate that survives gets the size it reached
export function allocatePastLimit(chunkMb = 16, maxMb = 1_024): number {
	const held: Uint8Array[] = [];
	for (let mb = 0; mb < maxMb; mb += chunkMb) held.push(new Uint8Array(chunkMb << 20).fill(1));
	return held.length * chunkMb;
}

// #endregion

// #region spike

export type CounterStub = {
	apply(write: CountWrite): Promise<ApplyAnswer>;
	read(hour: number): Promise<CountedHour | null>;
	counts(): Promise<CounterStats>;
};

export type SpikeDeps = {
	controlKey: string;
	origin?: string;
	now(): number;
	sleep(ms: number): Promise<void>;
	readMechanism(siteId: string): Promise<string | null>;
	counter(siteId: string): CounterStub;
	evict(): number;
	options?: Partial<CountingOptions>;
	timeoutMs?: number;
};

export type SpikeView = {
	siteId: string;
	status: number;
	contentType: string | null;
	limit: number | null;
};

export type Spike = {
	controlKey: string;
	bind(waitUntil: (promise: Promise<unknown>) => void): void;
	mechanismFor(siteId: string): Promise<MechanismName | null>;
	count(name: MechanismName, view: SpikeView): Promise<void>;
	counts(
		siteId: string,
		hours: number[]
	): Promise<{ counts: CounterStats; hours: (CountedHour | null)[] }>;
	evict(): number;
};

// one accounting per mechanism, all under one origin id for the isolate; a site keeps the
// mechanism it was first seen with, so no site is numbered by two of them
export function createSpike(deps: SpikeDeps): Spike {
	const origin = deps.origin ?? randomOrigin();
	const flushMs = deps.options?.flushMs ?? DEFAULT_OPTIONS.flushMs;
	const known = new Map<string, MechanismName | null>();
	const accountings = new Map<MechanismName, Accounting>();
	let waitUntil: (promise: Promise<unknown>) => void = () => undefined;
	let ticking = false;

	const accounting = (name: MechanismName): Accounting => {
		let made = accountings.get(name);
		if (!made) {
			made = createAccounting({
				counting: mechanism(name, deps.options),
				origin,
				now: deps.now,
				send: (write) => deps.counter(write.siteId).apply(write),
				waitUntil: (promise) => waitUntil(promise),
				timeoutMs: deps.timeoutMs
			});
			accountings.set(name, made);
		}
		return made;
	};

	const pending = () =>
		[...accountings.values()].some((a) =>
			[...a.state().entries.values()].some((e) => e.dueAt !== null)
		);

	// a Worker has no timer between requests, so one request keeps itself alive to flush the tail
	async function drain(until: (promise: Promise<unknown>) => void): Promise<void> {
		try {
			for (;;) {
				await deps.sleep(flushMs);
				waitUntil = until;
				const busy = pending();
				for (const a of accountings.values()) a.tick();
				if (!busy) return;
			}
		} finally {
			ticking = false;
		}
	}

	return {
		controlKey: deps.controlKey,
		bind(next) {
			waitUntil = next;
		},
		async mechanismFor(siteId) {
			const have = known.get(siteId);
			if (have !== undefined) return have;
			let raw: string | null;
			try {
				raw = await deps.readMechanism(siteId);
			} catch {
				return null;
			}
			const chosen = parseMechanism(raw);
			known.set(siteId, chosen);
			return chosen;
		},
		async count(name, view) {
			try {
				const done = accounting(name).count(view);
				if (!ticking) {
					ticking = true;
					waitUntil(drain(waitUntil));
				}
				await done;
			} catch {
				// a counting failure never fails a response
			}
		},
		async counts(siteId, hours) {
			const stub = deps.counter(siteId);
			const [counts, rows] = await Promise.all([
				stub.counts(),
				Promise.all(hours.map((hour) => stub.read(hour)))
			]);
			return { counts, hours: rows };
		},
		evict: () => deps.evict()
	};
}

// #endregion

// #region routes

const json = (body: unknown, status: number) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// null for a path that is not a spike route, so the caller answers the unknown-host 404
export async function spikeRoute(
	request: Request,
	spike: Spike,
	now: number
): Promise<Response | null> {
	const op = new URL(request.url).pathname.slice(SPIKE_PREFIX.length);
	if (op !== 'evict' && op !== 'counts') return null;
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	const text = await request.text();
	if (text.length > MAX_BODY) return new Response('Too large', { status: 413 });
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return json({ ok: false, code: 'malformed' }, 400);
	}
	const verified = await verifySpike(raw, spike.controlKey, now);
	if (!verified.ok) return json(verified, verified.code === 'malformed' ? 400 : 403);
	const message = verified.value;
	if (message.op !== op) return json({ ok: false, code: 'malformed' }, 400);
	if (message.op === 'evict') {
		return json({ ok: true, survivedAfterMb: spike.evict() }, 200);
	}
	try {
		return json({ ok: true, ...(await spike.counts(message.siteId, message.hours)) }, 200);
	} catch {
		return json({ ok: false, code: 'unavailable' }, 503);
	}
}

// #endregion
