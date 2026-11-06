import {
	checkLease,
	needsRenewal,
	type Lease,
	type LeaseRefusal,
	type RenewalRefusal,
	type Serving
} from '@contracts/site-auth';

export type AdmitContext = {
	publicKey: string;
	now: number;
	siteId: string;
	epoch: number;
	skewMs?: number;
	graceMs?: number;
};

export type Refusal = LeaseRefusal | RenewalRefusal | 'unknown_site' | 'unavailable';

export type Served = { action: 'serve'; lease: Lease; serving: Serving; renew: boolean };
export type Refused = { action: 'refuse'; code: Refusal };
export type Decision =
	Served | Refused | { action: 'renew-then-serve'; reason: 'none' | 'strict' | 'expired' };

export type RenewalOutcome =
	| { kind: 'lease'; lease: unknown }
	| { kind: 'refused'; code: Refusal }
	| { kind: 'unreachable' };

function check(raw: unknown, ctx: AdmitContext, renewalFailed = false) {
	return checkLease(raw, {
		publicKey: ctx.publicKey,
		now: ctx.now,
		siteId: ctx.siteId,
		epoch: ctx.epoch,
		skewMs: ctx.skewMs,
		graceMs: ctx.graceMs,
		renewalFailed
	});
}

// the mode comes from the signed lease, never from the route or any flag a stale reader could hold
export async function admit(cached: unknown, ctx: AdmitContext): Promise<Decision> {
	if (cached === undefined || cached === null)
		return { action: 'renew-then-serve', reason: 'none' };
	const result = await check(cached, ctx);
	if (result.ok) {
		const { lease, serving } = result.value;
		if (lease.mode === 'strict') return { action: 'renew-then-serve', reason: 'strict' };
		return { action: 'serve', lease, serving, renew: needsRenewal(lease, ctx.now) };
	}
	if (result.code === 'expired') return { action: 'renew-then-serve', reason: 'expired' };
	if (result.code === 'suspended' || result.code === 'revoked') {
		// the signature held, so exp is authentic; an expired security lease asks again
		const exp = (cached as Lease).exp;
		const lapsed = ctx.now > exp + (ctx.skewMs ?? 5_000);
		return lapsed
			? { action: 'renew-then-serve', reason: 'expired' }
			: { action: 'refuse', code: result.code };
	}
	return { action: 'refuse', code: result.code };
}

// strict mode and an unknown mode fail closed; only a lease-mode lease gets availability grace
export async function afterRenewal(
	outcome: RenewalOutcome,
	cached: unknown,
	ctx: AdmitContext
): Promise<Served | Refused> {
	if (outcome.kind === 'refused') return { action: 'refuse', code: outcome.code };
	if (outcome.kind === 'lease') {
		const result = await check(outcome.lease, ctx);
		if (!result.ok) return { action: 'refuse', code: result.code };
		const { lease, serving } = result.value;
		return { action: 'serve', lease, serving, renew: false };
	}
	if (cached === undefined || cached === null) return { action: 'refuse', code: 'unavailable' };
	const held = await check(cached, ctx, true);
	if (!held.ok) return { action: 'refuse', code: held.code };
	if (held.value.serving !== 'availability-grace')
		return { action: 'refuse', code: 'unavailable' };
	return {
		action: 'serve',
		lease: held.value.lease,
		serving: 'availability-grace',
		renew: false
	};
}

export type CallLimits = { cpuMs?: number; subRequests?: number };

function positiveInt(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: undefined;
}

export function callLimits(limits: Record<string, number>): CallLimits {
	const out: CallLimits = {};
	const cpuMs = positiveInt(limits.cpuMs);
	const subRequests = positiveInt(limits.subRequests);
	if (cpuMs !== undefined) out.cpuMs = cpuMs;
	if (subRequests !== undefined) out.subRequests = subRequests;
	return out;
}
