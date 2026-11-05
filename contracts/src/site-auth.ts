import { z } from 'zod';
import {
	digestSchema,
	omitSig,
	signatureSchema,
	signCanonical,
	siteId,
	verifyCanonical,
	type Verified
} from './common';

export const SITE_AUTH_VERSION = { major: 1, minor: 0 } as const;
export const SITE_AUTH_CONTRACT = 'site-auth';

export const LEASE_CONTEXT = 'drupflare.site-auth.lease.v1';

export const DEFAULT_LEASE_MS = 30_000;
export const STRICT_LEASE_MS = 5_000;
export const DEFAULT_STALE_GRACE_MS = 300_000;
export const DEFAULT_CLOCK_SKEW_MS = 5_000;
export const RENEW_WHEN_REMAINING = 1 / 3;

export const LEASE_STATES = ['active', 'plan-grace', 'suspended', 'revoked'] as const;
export const SECURITY_STATES = ['suspended', 'revoked'] as const;
export const RISK_CLASSES = ['established', 'new-free', 'abuse-watch', 'escalated'] as const;
export const LEASE_MODES = ['lease', 'strict'] as const;

export const leaseState = z.enum(LEASE_STATES);
export const riskClass = z.enum(RISK_CLASSES);
export const leaseMode = z.enum(LEASE_MODES);

export type LeaseState = z.infer<typeof leaseState>;
export type RiskClass = z.infer<typeof riskClass>;
export type LeaseMode = z.infer<typeof leaseMode>;

export const limitsSchema = z.record(z.string(), z.number().nonnegative());

export const authorityStateSchema = z.object({
	siteId,
	epoch: z.int().nonnegative(),
	generation: z.int().nonnegative(),
	state: leaseState,
	risk: riskClass,
	limits: limitsSchema,
	accessRuleHash: digestSchema
});

export const leaseSchema = z
	.object({
		v: z.literal(SITE_AUTH_VERSION.major),
		siteId,
		epoch: z.int().nonnegative(),
		generation: z.int().nonnegative(),
		state: leaseState,
		mode: leaseMode,
		limits: limitsSchema,
		accessRuleHash: digestSchema,
		iat: z.int().nonnegative(),
		exp: z.int().nonnegative(),
		sig: signatureSchema
	})
	.refine((lease) => lease.exp > lease.iat, { message: 'exp must follow iat', path: ['exp'] });

export const renewalRequestSchema = z.object({
	v: z.literal(SITE_AUTH_VERSION.major),
	siteId,
	epoch: z.int().nonnegative(),
	generation: z.int().nonnegative()
});

export const RENEWAL_REFUSALS = ['wrong_site', 'wrong_epoch', 'revoked'] as const;
export type RenewalRefusal = (typeof RENEWAL_REFUSALS)[number];

export const renewalResponseSchema = z.union([
	z.object({ ok: z.literal(true), lease: leaseSchema }),
	z.object({ ok: z.literal(false), code: z.enum(RENEWAL_REFUSALS) })
]);

export type AuthorityState = z.infer<typeof authorityStateSchema>;
export type Lease = z.infer<typeof leaseSchema>;
export type RenewalRequest = z.infer<typeof renewalRequestSchema>;

// #region issuing and renewing

export function isSecurityState(state: LeaseState): boolean {
	return (SECURITY_STATES as readonly string[]).includes(state);
}

// only established sites ride a reusable lease; every other class asks per request
export function modeForRisk(risk: RiskClass): LeaseMode {
	return risk === 'established' ? 'lease' : 'strict';
}

export async function issueLease(
	authority: AuthorityState,
	now: number,
	privateKey: CryptoKey,
	opts: { leaseMs?: number } = {}
): Promise<Lease> {
	const mode = modeForRisk(authority.risk);
	const life = mode === 'strict' ? STRICT_LEASE_MS : (opts.leaseMs ?? DEFAULT_LEASE_MS);
	const unsigned = {
		v: SITE_AUTH_VERSION.major,
		siteId: authority.siteId,
		epoch: authority.epoch,
		generation: authority.generation,
		state: authority.state,
		mode,
		limits: authority.limits,
		accessRuleHash: authority.accessRuleHash,
		iat: now,
		exp: now + life
	};
	const sig = await signCanonical(LEASE_CONTEXT, unsigned, privateKey);
	return { ...unsigned, sig } as Lease;
}

export function decideRenewal(
	request: Pick<RenewalRequest, 'siteId' | 'epoch'>,
	authority: Pick<AuthorityState, 'siteId' | 'epoch' | 'state'>
): { ok: true } | { ok: false; code: RenewalRefusal } {
	if (request.siteId !== authority.siteId) return { ok: false, code: 'wrong_site' };
	if (request.epoch !== authority.epoch) return { ok: false, code: 'wrong_epoch' };
	if (authority.state === 'revoked') return { ok: false, code: 'revoked' };
	return { ok: true };
}

export function isReusable(lease: Lease): boolean {
	return lease.mode === 'lease';
}

export function needsRenewal(lease: Lease, now: number): boolean {
	return isReusable(lease) && lease.exp - now <= (lease.exp - lease.iat) * RENEW_WHEN_REMAINING;
}

// #endregion

// #region checking a lease

export const LEASE_REFUSALS = [
	'malformed',
	'unsupported_version',
	'bad_signature',
	'wrong_site',
	'wrong_epoch',
	'revoked',
	'suspended',
	'expired'
] as const;
export type LeaseRefusal = (typeof LEASE_REFUSALS)[number];

export type Serving = 'lease' | 'strict' | 'availability-grace';
export type LeaseAdmission = { lease: Lease; serving: Serving };

export type CheckLeaseOptions = {
	publicKey: string;
	now: number;
	siteId: string;
	epoch: number;
	skewMs?: number;
	graceMs?: number;
	renewalFailed?: boolean;
};

export async function checkLease(
	raw: unknown,
	opts: CheckLeaseOptions
): Promise<Verified<LeaseAdmission, LeaseRefusal>> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { ok: false, code: 'malformed' };
	}
	const version = (raw as { v?: unknown }).v;
	if (typeof version === 'number' && version !== SITE_AUTH_VERSION.major) {
		return { ok: false, code: 'unsupported_version' };
	}
	const parsed = leaseSchema.safeParse(raw);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const lease = parsed.data;
	const valid = await verifyCanonical(
		LEASE_CONTEXT,
		omitSig(raw as { sig: string }),
		lease.sig,
		opts.publicKey
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (lease.siteId !== opts.siteId) return { ok: false, code: 'wrong_site' };
	if (lease.epoch !== opts.epoch) return { ok: false, code: 'wrong_epoch' };
	if (lease.state === 'revoked') return { ok: false, code: 'revoked' };
	if (lease.state === 'suspended') return { ok: false, code: 'suspended' };
	const skew = opts.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
	if (opts.now <= lease.exp + skew) return { ok: true, value: { lease, serving: lease.mode } };
	const graceMs = opts.graceMs ?? DEFAULT_STALE_GRACE_MS;
	if (opts.renewalFailed && isReusable(lease) && opts.now <= lease.exp + skew + graceMs) {
		return { ok: true, value: { lease, serving: 'availability-grace' } };
	}
	return { ok: false, code: 'expired' };
}

// #endregion

export const schemas = {
	authorityState: authorityStateSchema,
	lease: leaseSchema,
	renewalRequest: renewalRequestSchema,
	renewalResponse: renewalResponseSchema
};
