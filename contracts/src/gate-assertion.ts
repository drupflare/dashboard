import { z } from 'zod';
import {
	digestSchema,
	omitSig,
	signatureSchema,
	signCanonical,
	siteId,
	toBase64Url,
	verifyCanonical,
	type SigningKey,
	type Verified
} from './common';

export const GATE_ASSERTION_VERSION = { major: 1, minor: 0 } as const;
export const GATE_ASSERTION_CONTRACT = 'gate-assertion';

export const GATE_CONTEXT = 'drupflare.gate-assertion.v1';

export const DEFAULT_GATE_TTL_MS = 3_600_000;
export const MAX_GATE_TTL_MS = 43_200_000;
export const GATE_SKEW_MS = 30_000;

export const gateAssertionSchema = z.object({
	v: z.literal(GATE_ASSERTION_VERSION.major),
	id: z.string().min(16).max(64),
	siteId,
	environment: z.string().min(1).max(64),
	ruleHash: digestSchema,
	sub: z.string().min(1).max(256),
	iat: z.int().nonnegative(),
	exp: z.int().nonnegative(),
	sig: signatureSchema
});

export type GateAssertion = z.infer<typeof gateAssertionSchema>;

export const GATE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'bad_signature',
	'ttl_too_long',
	'expired',
	'not_yet_valid',
	'wrong_site',
	'wrong_environment',
	'stale_rule_hash',
	'replayed'
] as const;
export type GateRefusal = (typeof GATE_REFUSALS)[number];

export async function signGateAssertion(
	claim: { siteId: string; environment: string; ruleHash: string; sub: string },
	now: number,
	key: SigningKey,
	opts: { ttlMs?: number; id?: string } = {}
): Promise<GateAssertion> {
	const unsigned = {
		v: GATE_ASSERTION_VERSION.major,
		id: opts.id ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		...claim,
		iat: now,
		exp: now + (opts.ttlMs ?? DEFAULT_GATE_TTL_MS)
	};
	const sig = await signCanonical(GATE_CONTEXT, unsigned, key.privateKey);
	return { ...unsigned, sig } as GateAssertion;
}

export type VerifyGateOptions = {
	publicKey: string;
	now: number;
	siteId: string;
	environment: string;
	// the digest the site's lease carries for this environment
	ruleHash: string;
	// pass it when an assertion first arrives; a cookie that already passed is checked without it
	seen?: ReadonlySet<string>;
};

export async function verifyGateAssertion(
	raw: unknown,
	opts: VerifyGateOptions
): Promise<Verified<GateAssertion, GateRefusal>> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, code: 'malformed' };
	}
	const version = (raw as { v?: unknown }).v;
	if (typeof version === 'number' && version !== GATE_ASSERTION_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	const parsed = gateAssertionSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const assertion = parsed.data;
	const valid = await verifyCanonical(
		GATE_CONTEXT,
		omitSig(raw as { sig: string }),
		assertion.sig,
		opts.publicKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (assertion.exp - assertion.iat > MAX_GATE_TTL_MS) return { ok: false, code: 'ttl_too_long' };
	if (opts.now > assertion.exp + GATE_SKEW_MS) return { ok: false, code: 'expired' };
	if (assertion.iat > opts.now + GATE_SKEW_MS) return { ok: false, code: 'not_yet_valid' };
	if (assertion.siteId !== opts.siteId) return { ok: false, code: 'wrong_site' };
	if (assertion.environment !== opts.environment) return { ok: false, code: 'wrong_environment' };
	if (assertion.ruleHash !== opts.ruleHash) return { ok: false, code: 'stale_rule_hash' };
	if (opts.seen?.has(assertion.id)) return { ok: false, code: 'replayed' };
	return { ok: true, value: assertion };
}

export const schemas = { gateAssertion: gateAssertionSchema };
