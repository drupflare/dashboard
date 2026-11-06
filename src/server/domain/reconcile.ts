import { FREE_PLAN_ID, siteLimits, type Entitlement } from './entitlements';

export interface ReconcileFlags {
	// billing.overage.enabled
	overageEnabled: boolean;
}

export const DEFAULT_FLAGS: ReconcileFlags = { overageEnabled: false };

export interface DesiredSite {
	siteId: string;
	createdAt: number;
}

export interface Desired {
	orgId: string;
	// bumps on every change to the org's billing row, so an operation key never repeats across states
	revision: number;
	entitlement: Entitlement | null;
	sites: readonly DesiredSite[];
	overage: { views: number; meterEventId: string } | null;
}

export type SiteState = 'active' | 'plan-grace' | 'suspended' | 'revoked';

export interface AppliedSite {
	siteId: string;
	plan: string | null;
	limits: Readonly<Record<string, number>>;
	state: SiteState;
	suspendedBy: 'billing' | 'security' | null;
	// a security change was requested and the site has not confirmed it yet
	securityPending: boolean;
}

export type OperationParams =
	| { target: 'plan'; plan: string }
	| { target: 'site-auth-limits'; limits: Record<string, number> }
	| { target: 'site-auth-state'; state: 'active' | 'suspended'; reason: 'billing' }
	| { target: 'meter-overage'; views: number; meterEventId: string };

export interface OperationRequest {
	type: 'config.apply';
	organizationId: string;
	siteId: string | null;
	idempotencyKey: string;
	params: OperationParams;
}

export type SkipReason = 'security_unreconciled' | 'revoked';

export interface Reconciliation {
	actions: OperationRequest[];
	skipped: { siteId: string; reason: SkipReason }[];
}

const same = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

// a limit that disappears is a raise, so every applied key must stay and none may grow
function lowersOnly(
	applied: Readonly<Record<string, number>>,
	desired: Readonly<Record<string, number>>
): boolean {
	return Object.keys(applied).every((key) => {
		const next = desired[key];
		return next !== undefined && next <= (applied[key] as number);
	});
}

export function reconcile(
	desired: Desired,
	applied: readonly AppliedSite[],
	flags: ReconcileFlags = DEFAULT_FLAGS
): Reconciliation {
	const out: Reconciliation = { actions: [], skipped: [] };
	const { entitlement } = desired;
	if (entitlement === null) return out;

	const request = (siteId: string | null, params: OperationParams): OperationRequest => ({
		type: 'config.apply',
		organizationId: desired.orgId,
		siteId,
		idempotencyKey: `billing:${desired.orgId}:r${desired.revision}:${siteId ?? 'org'}:${params.target}`,
		params
	});

	const order = [...desired.sites].sort(
		(a, b) => a.createdAt - b.createdAt || a.siteId.localeCompare(b.siteId)
	);
	const limit = entitlement.sites;
	const over = new Set(limit === null ? [] : order.slice(limit).map((site) => site.siteId));
	const wantLimits = siteLimits(entitlement);

	for (const site of applied) {
		if (site.securityPending) {
			out.skipped.push({ siteId: site.siteId, reason: 'security_unreconciled' });
			continue;
		}
		if (site.state === 'revoked') {
			out.skipped.push({ siteId: site.siteId, reason: 'revoked' });
			continue;
		}
		const held = site.state === 'suspended' && site.suspendedBy === 'security';
		const billingSuspended = site.state === 'suspended' && site.suspendedBy === 'billing';

		if (over.has(site.siteId)) {
			if (site.state === 'active' || site.state === 'plan-grace') {
				out.actions.push(
					request(site.siteId, {
						target: 'site-auth-state',
						state: 'suspended',
						reason: 'billing'
					})
				);
			}
			continue;
		}

		const limitsOk = !held || lowersOnly(site.limits, wantLimits);
		if (limitsOk && site.plan !== entitlement.planId) {
			out.actions.push(request(site.siteId, { target: 'plan', plan: entitlement.planId }));
		}
		if (limitsOk && !same(site.limits, wantLimits)) {
			out.actions.push(
				request(site.siteId, { target: 'site-auth-limits', limits: wantLimits })
			);
		}
		if (billingSuspended && limit !== null) {
			out.actions.push(
				request(site.siteId, {
					target: 'site-auth-state',
					state: 'active',
					reason: 'billing'
				})
			);
		}
	}

	const { overage } = desired;
	if (
		flags.overageEnabled &&
		overage !== null &&
		overage.views > 0 &&
		entitlement.planId !== FREE_PLAN_ID
	) {
		out.actions.push(
			request(null, {
				target: 'meter-overage',
				views: overage.views,
				meterEventId: overage.meterEventId
			})
		);
	}
	return out;
}
