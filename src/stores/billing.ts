import { defineStore } from 'pinia';
import { ApiClientError, toApiClientError, useApi } from '~/composables/useApi';
import type { Interval, MeterId, Plane } from '~/shared/plans';

// the free plan id from server domain/entitlements.ts; an org on it has no subscription
export const FREE_PLAN_ID = 'managed-free';

// base plans with no price; an organization on one pays only for add-ons, if anything
export const FREE_PLAN_IDS: readonly string[] = [FREE_PLAN_ID, 'self-managed', 'self-hosted'];

export interface PlanIncluded {
	storageGb: number | null;
	writes: number | null;
	backupGb: number | null;
	mailSends: number | null;
	containerHours: number | null;
	invitees: number | null;
	customDomains: number | null;
	backupDays: number | null;
}

export interface BillingPlan {
	id: string;
	name: string;
	kind: string;
	plane: Plane;
	lookupKey: string;
	sites: number | null;
	sitesUnlimited: boolean;
	views: number | null;
	support: string;
	supportHoursPerYear: number | null;
	included: PlanIncluded;
	disabled: boolean;
	// absent for viewers who may not see prices; present with a value otherwise
	monthly?: number | null;
	annual?: number | null;
	unreviewed?: boolean;
}

export interface BillingAddOn {
	id: string;
	name: string;
	meter: MeterId;
	lookupKey: string;
	unit: string;
	grants: number;
	planes: Plane[];
	requires: string[] | null;
	subscription: boolean;
	packSizes: number[];
	available: boolean;
	availableNote: string | null;
	monthly?: number | null;
	annual?: number | null;
	packs?: { units: number; price: number | null }[];
	unreviewed?: boolean;
}

export interface PlanEntitlement {
	planId: string;
	managedPlanId: string;
	plane: Plane;
	addOns: { id: string; quantity: number }[];
	sites: number | null;
	views: number | null;
	storageGb: number | null;
	writes: number | null;
	backupGb: number | null;
	mailSends: number | null;
	containerHours: number | null;
	invitees: number | null;
	supportHoursPerYear: number | null;
	support: string;
	// true when the organization has a Stripe customer, so the portal can open
	billingAccount: boolean;
	features?: Record<string, boolean>;
	// units bought as one-time packs, per meter; zeros are omitted
	credits?: Record<string, number>;
}

export type BillingDetails = {
	name: string;
	email: string;
	// two-letter country code
	country: string;
};

export type AddOnPurchase =
	| { mode: 'subscription'; addOn: string; quantity: number; interval: Interval }
	| { mode: 'pack'; addOn: string; units: number };

// a url is a hosted checkout to leave for; applied means the running subscription was changed
export type AddOnResult = { url: string } | { applied: true };

export const useBillingStore = defineStore('billing', {
	state: () => ({
		// undefined: not loaded; an array (possibly empty): loaded
		plans: undefined as BillingPlan[] | undefined,
		plansError: null as ApiClientError | null,
		addOns: undefined as BillingAddOn[] | undefined,
		addOnsError: null as ApiClientError | null,
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
		async loadAddOns(): Promise<void> {
			if (this.addOns !== undefined) return;
			try {
				const page = await useApi().get<{ items: BillingAddOn[] }>('/billing/add-ons');
				this.addOns = page.items;
				this.addOnsError = null;
			} catch (error) {
				this.addOnsError = toApiClientError(error);
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
		// a fresh read that keeps the last good value on screen until it lands
		async refreshEntitlement(orgId: string): Promise<void> {
			const plan = await useApi().get<PlanEntitlement>(
				`/orgs/${encodeURIComponent(orgId)}/entitlement`
			);
			this.entitlements.set(orgId, plan);
		},
		buyAddOn(orgId: string, purchase: AddOnPurchase): Promise<AddOnResult> {
			return useApi().post<AddOnResult>(
				`/billing/${encodeURIComponent(orgId)}/add-ons`,
				purchase
			);
		},
		setAddOnQuantity(orgId: string, addOnId: string, quantity: number): Promise<AddOnResult> {
			return useApi().put<AddOnResult>(
				`/billing/${encodeURIComponent(orgId)}/add-ons/${encodeURIComponent(addOnId)}`,
				{ quantity }
			);
		},
		// a url is a hosted checkout; applied means the plan joined the running subscription
		checkout(orgId: string, plan: string, interval: Interval): Promise<AddOnResult> {
			return useApi().post<AddOnResult>(`/billing/${encodeURIComponent(orgId)}/checkout`, {
				plan,
				interval
			});
		},
		saveDetails(orgId: string, details: BillingDetails): Promise<{ saved: true }> {
			return useApi().put<{ saved: true }>(
				`/billing/${encodeURIComponent(orgId)}/details`,
				details
			);
		},
		portal(orgId: string): Promise<{ url: string }> {
			return useApi().post<{ url: string }>(`/billing/${encodeURIComponent(orgId)}/portal`);
		},
		reset(): void {
			this.plans = undefined;
			this.plansError = null;
			this.addOns = undefined;
			this.addOnsError = null;
			this.entitlements.clear();
			this.entitlementError = null;
		}
	}
});
