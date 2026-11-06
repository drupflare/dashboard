import type { SiteId, Verified } from '@contracts/common';
import {
	canonicalJson,
	omitSig,
	signatureSchema,
	signCanonical,
	verifyCanonical
} from '@contracts/common';
import {
	authorityStateSchema,
	decideRenewal,
	issueLease,
	renewalRequestSchema,
	type AuthorityState,
	type Lease,
	type RenewalRefusal
} from '@contracts/site-auth';
import { z } from 'zod';
import type { SyncKv } from './storage';

export const APPLY_CONTEXT = 'drupflare.site-auth.apply.v1';
export const APPLY_MAX_AGE_MS = 300_000;
const AUTHORITY_KEY = 'authority';

export const applyMessageSchema = authorityStateSchema
	.extend({ v: z.literal(1), iat: z.int().nonnegative(), sig: signatureSchema })
	.strict();

export type ApplyMessage = z.infer<typeof applyMessageSchema>;

export const APPLY_REFUSALS = [
	'malformed',
	'wrong_site',
	'bad_signature',
	'stale_message',
	'stale_generation',
	'stale_epoch',
	'revoked_epoch'
] as const;
export type ApplyRefusal = (typeof APPLY_REFUSALS)[number];
export type ApplyResult = Verified<{ applied: boolean; generation: number }, ApplyRefusal>;

export type SiteAuthRefusal = RenewalRefusal | 'unknown_site' | 'malformed';
export type SiteAuthResult = { ok: true; lease: Lease } | { ok: false; code: SiteAuthRefusal };

// the control plane signs a write with its own key; the message is the authority plus a time and a sig
export async function signApply(
	state: AuthorityState,
	iat: number,
	privateKey: CryptoKey
): Promise<ApplyMessage> {
	const unsigned = { ...state, v: 1 as const, iat };
	const sig = await signCanonical(APPLY_CONTEXT, unsigned, privateKey);
	return { ...unsigned, sig } as ApplyMessage;
}

export type ApplyOptions = { controlKey: string; now: number; expectedSiteId?: string };

// verify first (async), then decide against the stored state without awaiting, so the read and
// the write that follows run in one turn of the object
export async function verifyApply(
	raw: unknown,
	opts: ApplyOptions
): Promise<Verified<ApplyMessage, ApplyRefusal>> {
	const parsed = applyMessageSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const message = parsed.data;
	if (opts.expectedSiteId !== undefined && message.siteId !== opts.expectedSiteId) {
		return { ok: false, code: 'wrong_site' };
	}
	const valid = await verifyCanonical(
		APPLY_CONTEXT,
		omitSig(message),
		message.sig,
		opts.controlKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (Math.abs(opts.now - message.iat) > APPLY_MAX_AGE_MS)
		return { ok: false, code: 'stale_message' };
	return { ok: true, value: message };
}

export function decideApply(
	current: AuthorityState | undefined,
	message: ApplyMessage
): Verified<{ state: AuthorityState; applied: boolean }, ApplyRefusal> {
	const { v: _v, iat: _iat, sig: _sig, ...incoming } = message;
	const next = incoming as AuthorityState;
	if (current === undefined) return { ok: true, value: { state: next, applied: true } };
	if (next.siteId !== current.siteId) return { ok: false, code: 'wrong_site' };
	if (next.generation === current.generation) {
		return canonicalJson(next) === canonicalJson(current)
			? { ok: true, value: { state: current, applied: false } }
			: { ok: false, code: 'stale_generation' };
	}
	if (next.generation < current.generation) return { ok: false, code: 'stale_generation' };
	if (next.epoch < current.epoch) return { ok: false, code: 'stale_epoch' };
	if (current.state === 'revoked' && next.epoch === current.epoch && next.state !== 'revoked') {
		return { ok: false, code: 'revoked_epoch' };
	}
	return { ok: true, value: { state: next, applied: true } };
}

export function readAuthority(kv: SyncKv): AuthorityState | undefined {
	return kv.get<AuthorityState>(AUTHORITY_KEY);
}

export async function applyTo(kv: SyncKv, raw: unknown, opts: ApplyOptions): Promise<ApplyResult> {
	const verified = await verifyApply(raw, opts);
	if (!verified.ok) return verified;
	const decided = decideApply(readAuthority(kv), verified.value);
	if (!decided.ok) return decided;
	if (decided.value.applied) kv.put(AUTHORITY_KEY, decided.value.state);
	return {
		ok: true,
		value: { applied: decided.value.applied, generation: decided.value.state.generation }
	};
}

// a revoked site gets no lease at the same epoch; a suspended one gets a lease that says so
export async function leaseFor(
	kv: SyncKv,
	request: { siteId: string; epoch: number },
	now: number,
	privateKey: CryptoKey
): Promise<SiteAuthResult> {
	const state = readAuthority(kv);
	if (state === undefined) return { ok: false, code: 'unknown_site' };
	const decision = decideRenewal(
		{ siteId: request.siteId as SiteId, epoch: request.epoch },
		state
	);
	if (!decision.ok) return { ok: false, code: decision.code };
	return { ok: true, lease: await issueLease(state, now, privateKey) };
}

export async function renewFor(
	kv: SyncKv,
	raw: unknown,
	now: number,
	privateKey: CryptoKey
): Promise<SiteAuthResult> {
	const parsed = renewalRequestSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	return leaseFor(kv, parsed.data, now, privateKey);
}
