import { z } from 'zod';
import {
	digestSchema,
	omitSig,
	operationId,
	publicKeyDigest,
	signatureSchema,
	signCanonical,
	siteId,
	toBase64Url,
	verifyCanonical,
	type SigningKey,
	type Verified
} from './common';

export const OWNER_ASSERTION_VERSION = { major: 1, minor: 0 } as const;
export const OWNER_ASSERTION_CONTRACT = 'owner-assertion';

export const ASSERTION_CONTEXT = 'drupflare.owner-assertion.v1';

export const DEFAULT_ASSERTION_TTL_MS = 60_000;
export const MAX_ASSERTION_TTL_MS = 300_000;
export const ASSERTION_SKEW_MS = 30_000;

export const assertionScopeSchema = z.object({
	siteId,
	opId: operationId,
	action: z.string().min(1).max(64)
});

export const assertionSchema = z.object({
	v: z.literal(OWNER_ASSERTION_VERSION.major),
	id: z.string().min(16).max(64),
	kid: digestSchema,
	scope: assertionScopeSchema,
	iat: z.int().nonnegative(),
	exp: z.int().nonnegative(),
	sig: signatureSchema
});

export type AssertionScope = z.infer<typeof assertionScopeSchema>;
export type Assertion = z.infer<typeof assertionSchema>;

export const ASSERTION_REFUSALS = [
	'malformed',
	'unsupported_version',
	'key_mismatch',
	'bad_signature',
	'ttl_too_long',
	'expired',
	'not_yet_valid',
	'wrong_scope',
	'replayed'
] as const;
export type AssertionRefusal = (typeof ASSERTION_REFUSALS)[number];

export function isReplayed(id: string, seen: ReadonlySet<string>): boolean {
	return seen.has(id);
}

export async function signAssertion(
	scope: AssertionScope,
	now: number,
	key: SigningKey,
	opts: { ttlMs?: number; id?: string } = {}
): Promise<Assertion> {
	const unsigned = {
		v: OWNER_ASSERTION_VERSION.major,
		id: opts.id ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
		kid: await publicKeyDigest(key.publicKey),
		scope,
		iat: now,
		exp: now + (opts.ttlMs ?? DEFAULT_ASSERTION_TTL_MS)
	};
	const sig = await signCanonical(ASSERTION_CONTEXT, unsigned, key.privateKey);
	return { ...unsigned, sig } as Assertion;
}

export type VerifyAssertionOptions = {
	pinnedPublicKey: string;
	now: number;
	expect: AssertionScope;
	seen?: ReadonlySet<string>;
};

export async function verifyAssertion(
	raw: unknown,
	opts: VerifyAssertionOptions
): Promise<Verified<Assertion, AssertionRefusal>> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, code: 'malformed' };
	}
	const version = (raw as { v?: unknown }).v;
	if (typeof version === 'number' && version !== OWNER_ASSERTION_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	const parsed = assertionSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const assertion = parsed.data;
	if (assertion.kid !== (await publicKeyDigest(opts.pinnedPublicKey))) {
		return { ok: false, code: 'key_mismatch' };
	}
	const valid = await verifyCanonical(
		ASSERTION_CONTEXT,
		omitSig(raw as { sig: string }),
		assertion.sig,
		opts.pinnedPublicKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (assertion.exp - assertion.iat > MAX_ASSERTION_TTL_MS)
		return { ok: false, code: 'ttl_too_long' };
	if (opts.now > assertion.exp + ASSERTION_SKEW_MS) return { ok: false, code: 'expired' };
	if (assertion.iat > opts.now + ASSERTION_SKEW_MS) return { ok: false, code: 'not_yet_valid' };
	const scope = assertion.scope;
	if (
		scope.siteId !== opts.expect.siteId ||
		scope.opId !== opts.expect.opId ||
		scope.action !== opts.expect.action
	) {
		return { ok: false, code: 'wrong_scope' };
	}
	if (opts.seen && isReplayed(assertion.id, opts.seen)) return { ok: false, code: 'replayed' };
	return { ok: true, value: assertion };
}

export const schemas = { assertionScope: assertionScopeSchema, assertion: assertionSchema };
