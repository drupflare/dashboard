import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import type { Interval } from '~/shared/plans';

// the free plan id from server domain/entitlements.ts; an org on it has no subscription
export const FREE_PLAN_ID = 'managed-free';

export interface BillingPlan {
	id: string;
	name: string;
	kind: string;
	lookupKey: string;
	sites: number | null;
	views: number | null;
	support: string;
	disabled: boolean;
	// absent for viewers who may not see prices; present with a value otherwise
	monthly?: number | null;
	annual?: number | null;
	unreviewed?: boolean;
}

export interface PlanEntitlement {
	planId: string;
	addOns: string[];
	sites: number | null;
	views: number | null;
	// true when the organization has a Stripe customer, so the portal can open
	billingAccount: boolean;
}

export const useBillingStore = defineStore('billing', {
	state: () => ({
		// undefined: not loaded; an array (possibly empty): loaded
		plans: undefined as BillingPlan[] | undefined,
		plansError: null as ApiClientError | null,
		// keyed by organization id; undefined: not loaded; null: the organization has no plan record
		entitlements: new Map<string, PlanEntitlement | null>(),
		entitlementError: null as ApiClientError | null
	}),
	actions: {
		async loadPlans(): Promise<void> {
			if (this.plans !== undefined) return;
			try {
				const page = await useApi().get<{ items: BillingPlan[] }>('/billing/plans');
				this.plans = page.items;
				this.plansError = null;
			} catch (error) {
				this.plansError = toApiClientError(error);
			}
		},
		async loadEntitlement(orgId: string): Promise<void> {
			if (this.entitlements.has(orgId)) return;
			this.entitlementError = null;
			try {
				const plan = await useApi().get<PlanEntitlement>(
					`/orgs/${encodeURIComponent(orgId)}/entitlement`
				);
				this.entitlements.set(orgId, plan);
			} catch (error) {
				const failure = toApiClientError(error);
				if (failure.status === 404) this.entitlements.set(orgId, null);
				else this.entitlementError = failure;
			}
		},
		checkout(orgId: string, plan: string, interval: Interval): Promise<{ url: string }> {
			return useApi().post<{ url: string }>(
				`/billing/${encodeURIComponent(orgId)}/checkout`,
				{
					plan,
					interval
				}
			);
		},
		portal(orgId: string): Promise<{ url: string }> {
			return useApi().post<{ url: string }>(`/billing/${encodeURIComponent(orgId)}/portal`);
		},
		reset(): void {
			this.plans = undefined;
			this.plansError = null;
			this.entitlements.clear();
			this.entitlementError = null;
		}
	}
});
