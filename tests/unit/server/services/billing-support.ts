import Stripe from 'stripe';
import type { BillingAccount } from '../../../../src/server/db/repos/billing';
import { fakeStripeClient, type FakeStripe } from '../../../../src/server/integrations/stripe';
import type { AuditInput } from '../../../../src/server/services/audit';
import type { BillingServices, BillingStore } from '../../../../src/server/services/billing';
import { findPlan, priceLookupKey, type Plan } from '../../../../src/shared/plans';

export const WEBHOOK_SECRET = 'whsec_fixture_secret';
export const NOW = 1_800_000_000_000;

// mirrors the repo's rules: a stale event changes nothing, a patch never bumps the revision
export function memoryBillingStore(): BillingStore & {
	accounts: Map<string, BillingAccount>;
	customers: Map<string, string>;
	events: Map<string, string>;
} {
	const accounts = new Map<string, BillingAccount>();
	const customers = new Map<string, string>();
	const events = new Map<string, string>();
	return {
		accounts,
		customers,
		events,
		async getAccount(orgId) {
			return accounts.get(orgId) ?? null;
		},
		async ensureAccount(orgId, now) {
			const existing = accounts.get(orgId);
			if (existing) return existing;
			const row: BillingAccount = {
				organizationId: orgId,
				stripeCustomerId: null,
				subscriptionId: null,
				planId: 'managed-free',
				addOnIds: [],
				status: 'none',
				entitlementState: 'pending',
				revision: 0,
				lastEventAt: 0,
				billingEmail: null,
				lastInvoiceId: null,
				reviewReason: null,
				createdAt: now,
				updatedAt: now
			};
			accounts.set(orgId, row);
			return row;
		},
		async linkCustomer(customerId, orgId) {
			if (!customers.has(customerId)) customers.set(customerId, orgId);
			return customers.get(customerId) === orgId ? 'linked' : 'conflict';
		},
		async findOrgByCustomer(customerId) {
			return customers.get(customerId) ?? null;
		},
		async applySubscription(input) {
			const existing = accounts.get(input.organizationId);
			if (existing && input.eventAt < existing.lastEventAt) return null;
			const revision = (existing?.revision ?? 0) + 1;
			accounts.set(input.organizationId, {
				organizationId: input.organizationId,
				stripeCustomerId: input.customerId,
				subscriptionId: input.subscriptionId,
				planId: input.planId,
				addOnIds: [...input.addOnIds],
				status: input.status,
				entitlementState: input.entitlementState,
				revision,
				lastEventAt: input.eventAt,
				billingEmail: existing?.billingEmail ?? null,
				lastInvoiceId: existing?.lastInvoiceId ?? null,
				reviewReason: existing?.reviewReason ?? null,
				createdAt: existing?.createdAt ?? input.now,
				updatedAt: input.now
			});
			return revision;
		},
		async patchAccount(orgId, patch, eventAt, now) {
			const existing = accounts.get(orgId);
			if (!existing || existing.lastEventAt > eventAt) return false;
			const next = {
				...existing,
				lastEventAt: Math.max(existing.lastEventAt, eventAt),
				updatedAt: now
			};
			for (const [key, value] of Object.entries(patch)) {
				if (value !== undefined) Object.assign(next, { [key]: value });
			}
			accounts.set(orgId, next);
			return true;
		},
		async hasEvent(eventId) {
			return events.has(eventId);
		},
		async recordEvent(eventId, type) {
			if (!events.has(eventId)) events.set(eventId, type);
		}
	};
}

export interface Rig {
	services: BillingServices;
	store: ReturnType<typeof memoryBillingStore>;
	stripe: FakeStripe;
	audits: { orgId: string; input: AuditInput }[];
	logs: { message: string; detail: Record<string, unknown> }[];
	clock: { now: number };
}

export function rig(over: Partial<BillingServices> = {}): Rig {
	const store = memoryBillingStore();
	const stripe = fakeStripeClient();
	const audits: Rig['audits'] = [];
	const logs: Rig['logs'] = [];
	const clock = { now: NOW };
	const services: BillingServices = {
		stripe,
		webhookSecret: WEBHOOK_SECRET,
		store,
		audit: async (orgId, input) => {
			audits.push({ orgId, input });
		},
		flags: { ssoBuilt: false, overageEnabled: false },
		now: () => clock.now,
		log: (message, detail) => {
			logs.push({ message, detail });
		},
		baseUrl: 'https://app.example.test',
		...over
	};
	return { services, store, stripe, audits, logs, clock };
}

// #region stripe-shaped fixtures

let counter = 0;

export function event(type: string, object: unknown, over: { id?: string; created?: number } = {}) {
	counter += 1;
	return {
		id: over.id ?? `evt_fixture_${counter}`,
		object: 'event',
		api_version: '2025-01-01',
		created: over.created ?? Math.floor(NOW / 1000),
		livemode: false,
		pending_webhooks: 1,
		type,
		data: { object }
	};
}

export async function signed(body: unknown, atMs = NOW, secret = WEBHOOK_SECRET) {
	const raw = JSON.stringify(body);
	const header = await Stripe.webhooks.generateTestHeaderStringAsync({
		timestamp: Math.floor(atMs / 1000),
		payload: raw,
		secret,
		cryptoProvider: Stripe.createSubtleCryptoProvider()
	});
	return { raw, header };
}

export function subscription(
	over: {
		id?: string;
		customer?: string;
		status?: string;
		plans?: string[];
		organizationId?: string;
		interval?: 'month' | 'year';
	} = {}
) {
	const plans = (over.plans ?? ['managed-studio']).map((id) => findPlan(id) as Plan);
	return {
		id: over.id ?? 'sub_fixture',
		object: 'subscription',
		customer: over.customer ?? 'cus_fixture',
		status: over.status ?? 'active',
		metadata: over.organizationId ? { organization_id: over.organizationId } : {},
		items: {
			object: 'list',
			data: plans.map((plan) => ({
				id: `si_${plan.id}`,
				object: 'subscription_item',
				price: {
					id: `price_${plan.id}`,
					object: 'price',
					lookup_key: priceLookupKey(plan, over.interval ?? 'month')
				}
			}))
		}
	};
}

export const checkoutCompleted = (over: { customer?: string; org?: string | null } = {}) => ({
	id: 'cs_fixture',
	object: 'checkout.session',
	mode: 'subscription',
	customer: over.customer ?? 'cus_fixture',
	subscription: 'sub_fixture',
	client_reference_id: over.org === undefined ? 'org-1' : over.org,
	metadata: {}
});

// #endregion
