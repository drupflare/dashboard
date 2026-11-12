import { formatMoney } from './utils/format';

// the default per-account limit on Workers KV namespaces, for display only; the engine never reads it
export const KV_NAMESPACE_LIMIT = 1000;
export const KV_WARN_ABOVE = 0.8;
export const CREDIT_DAYS_WARN = 30;
export const CAPACITY_REFRESH_MS = 60_000;

// #region view

export type CreditsView =
	| {
			state: 'ok';
			currency: string;
			balanceCents: number;
			originalCents: number;
			usedCents: number;
			daysRemaining: number | null;
			validFrom: string | null;
			validTo: string | null;
			projectedDepletion: string | null;
	  }
	| { state: 'none' | 'no_billing_access' | 'not_configured' | 'unavailable' };

export interface ServiceCost {
	name: string;
	cents: number;
}

export type UsageView =
	| {
			state: 'ok';
			currency: string | null;
			from: string | null;
			through: string | null;
			totalCents: number;
			services: ServiceCost[];
	  }
	| { state: 'not_configured' | 'unavailable' };

export interface RateView {
	remaining: number | null;
	quota: number | null;
	resetSeconds: number | null;
	windowSeconds: number | null;
}

export type HeadroomView =
	| {
			state: 'ok';
			kvNamespaces: number;
			kvLimit: number;
			buckets: number;
			// null when that one listing failed, so the rest of the card still shows
			scripts: number | null;
			databases: number | null;
			rate: RateView;
	  }
	| { state: 'not_configured' | 'unavailable' };

export interface FailedChange {
	id: string;
	type: string;
	siteId: string | null;
	reason: string | null;
	at: number;
}

export interface WorkView {
	running: number;
	failedLastDay: number;
	recentFailures: FailedChange[];
	sites: Record<string, number>;
}

export interface CapacityView {
	generatedAt: number;
	credits: CreditsView;
	usage: UsageView;
	headroom: HeadroomView;
	work: WorkView;
}

// #endregion

// #region words

export interface CapacityWarning {
	id: 'namespaces' | 'expiry' | 'depletion';
	title: string;
	text: string;
}

export const dollars = (cents: number, currency: string | null): string =>
	formatMoney(cents, currency ?? 'USD');

export function formatPercent(percent: number): string {
	if (percent > 0 && percent < 0.01) return 'under 0.01 percent';
	return `${Number(percent.toFixed(2))} percent`;
}

const day = (iso: string): string => iso.slice(0, 10);

const parsed = (iso: string | null): number | null => {
	if (iso === null) return null;
	const at = Date.parse(iso);
	return Number.isFinite(at) ? at : null;
};

export function capacityWarnings(
	view: Pick<CapacityView, 'credits' | 'headroom'>
): CapacityWarning[] {
	const warnings: CapacityWarning[] = [];
	const { credits, headroom } = view;
	if (headroom.state === 'ok' && headroom.kvNamespaces > headroom.kvLimit * KV_WARN_ABOVE) {
		const percent = Math.floor((headroom.kvNamespaces / headroom.kvLimit) * 100);
		warnings.push({
			id: 'namespaces',
			title: 'Storage Namespaces Are Filling Up',
			text: `${headroom.kvNamespaces.toLocaleString('en-US')} of ${headroom.kvLimit.toLocaleString('en-US')} namespaces are in use (${percent} percent). Ask Cloudflare to raise the limit before the next batch of sites.`
		});
	}
	if (credits.state !== 'ok') return warnings;
	if (credits.daysRemaining !== null && credits.daysRemaining < CREDIT_DAYS_WARN) {
		const ends = credits.validTo === null ? '' : ` on ${day(credits.validTo)}`;
		const days = credits.daysRemaining;
		warnings.push({
			id: 'expiry',
			title: 'Credit Grant Ends Soon',
			text: `The grant ends in ${days} ${days === 1 ? 'day' : 'days'}${ends}.`
		});
	}
	const runsOut = parsed(credits.projectedDepletion);
	const expires = parsed(credits.validTo);
	if (
		credits.projectedDepletion !== null &&
		credits.validTo !== null &&
		runsOut !== null &&
		expires !== null &&
		runsOut < expires
	) {
		warnings.push({
			id: 'depletion',
			title: 'Credit Will Run Out Early',
			text: `At the current pace the grant is used up on ${day(credits.projectedDepletion)}, before it expires on ${day(credits.validTo)}.`
		});
	}
	return warnings;
}

// #endregion
