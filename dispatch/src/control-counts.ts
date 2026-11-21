import {
	omitSig,
	signatureSchema,
	signCanonical,
	verifyCanonical,
	type Verified
} from '@contracts/common';
import { z } from 'zod';
import { APPLY_MAX_AGE_MS } from './authority';
import type { CountedHour } from './counting';

export const COUNTS_PATH = '/counts';
export const COUNTS_CONTEXT = 'drupflare.dispatch.counts.v1';
export const COUNTS_MAX_HOURS = 48;
export const COUNTS_MAX_MONTHS = 3;
const MAX_BODY = 4_096;

export const countsMessageSchema = z
	.object({
		v: z.literal(1),
		iat: z.int().nonnegative(),
		sig: signatureSchema,
		siteId: z.string().min(1).max(64),
		hours: z.array(z.int().nonnegative()).max(COUNTS_MAX_HOURS),
		months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(COUNTS_MAX_MONTHS)
	})
	.strict();

export type CountsMessage = z.infer<typeof countsMessageSchema>;
export type CountsBody = { siteId: string; hours: number[]; months: string[] };
export type CountsRefusal = 'malformed' | 'bad_signature' | 'stale_message';

export type CountsReader = {
	read(hour: number): Promise<CountedHour | null>;
	month(month: string): Promise<number>;
};

export type CountsAnswer = {
	ok: true;
	hours: (CountedHour | null)[];
	months: { month: string; views: number }[];
};

// the control key signs this under its own context, so an apply write or a spike message cannot
// stand in for it, and a counts message cannot stand in for either
export async function signCounts(
	body: CountsBody,
	iat: number,
	privateKey: CryptoKey
): Promise<CountsMessage> {
	const unsigned = { ...body, v: 1 as const, iat };
	const sig = await signCanonical(COUNTS_CONTEXT, unsigned, privateKey);
	return { ...unsigned, sig } as CountsMessage;
}

export async function verifyCounts(
	raw: unknown,
	controlKey: string,
	now: number
): Promise<Verified<CountsMessage, CountsRefusal>> {
	const parsed = countsMessageSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const message = parsed.data;
	const valid = await verifyCanonical(COUNTS_CONTEXT, omitSig(message), message.sig, controlKey);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (Math.abs(now - message.iat) > APPLY_MAX_AGE_MS) return { ok: false, code: 'stale_message' };
	return { ok: true, value: message };
}

const json = (body: unknown, status: number) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export type CountsRouteDeps = {
	controlKey: string;
	now(): number;
	counter(siteId: string): CountsReader;
};

// read only: it names a site and some hours and months, and returns what the counter holds
export async function countsRoute(request: Request, deps: CountsRouteDeps): Promise<Response> {
	if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
	const text = await request.text();
	if (text.length > MAX_BODY) return new Response('Too large', { status: 413 });
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return json({ ok: false, code: 'malformed' }, 400);
	}
	const verified = await verifyCounts(raw, deps.controlKey, deps.now());
	if (!verified.ok) return json(verified, verified.code === 'malformed' ? 400 : 403);
	const { siteId, hours, months } = verified.value;
	try {
		const stub = deps.counter(siteId);
		const [rows, totals] = await Promise.all([
			Promise.all(hours.map((hour) => stub.read(hour))),
			Promise.all(months.map((month) => stub.month(month)))
		]);
		const answer: CountsAnswer = {
			ok: true,
			hours: rows,
			months: months.map((month, index) => ({ month, views: totals[index] as number }))
		};
		return json(answer, 200);
	} catch {
		return json({ ok: false, code: 'unavailable' }, 503);
	}
}
