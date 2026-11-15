import Stripe from 'stripe';
import type { BillingAccount } from '../../../../src/server/db/repos/billing';
import { fakeStripeClient, type FakeStripe } from '../../../../src/server/integrations/stripe';
import type { AuditInput } from '../../../../src/server/services/audit';
import type { BillingServices, BillingStore } from '../../../../src/server/services/billing';
import {
	findAddOn,
	findPlan,
	packLookupKey,
	priceLookupKey,
	type AddOn,
	type Plan
} from '../../../../src/shared/plans';

export const WEBHOOK_SECRET = 'whsec_fixture_secret';
export const NOW = 1_800_000_000_000;

// mirrors the repo's rules: a stale event changes nothing, a patch never bumps the revision
export function memoryBillingStore(): BillingStore & {
	accounts: Map<string, BillingAccount>;
	customers: Map<string, string>;
	events: Map<string, string>;
	credits: Map<string, { organizationId: string; meter: string; units: number }>;
	pending: Map<string, { organizationId: string; mode: string }>;
} {
	const accounts = new Map<string, BillingAccount>();
	const customers = new Map<string, string>();
	const events = new Map<string, string>();
	const credits = new Map<string, { organizationId: string; meter: string; units: number }>();
	const pending = new Map<string, { organizationId: string; mode: string }>();
	return {
		accounts,
		customers,
		events,
		credits,
		pending,
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
				addOns: [],
				status: 'none',
				entitlementState: 'pending',
				revision: 0,
				lastEventAt: 0,
				billingEmail: null,
				billingName: null,
				billingCountry: null,
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
				addOns: input.addOns.map((holding) => ({ ...holding })),
				status: input.status,
				entitlementState: input.entitlementState,
				revision,
				lastEventAt: input.eventAt,
				billingEmail: existing?.billingEmail ?? null,
				billingName: existing?.billingName ?? null,
				billingCountry: existing?.billingCountry ?? null,
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
		},
		async addCredit(input) {
			if (credits.has(input.sourceId)) return false;
			credits.set(input.sourceId, {
				organizationId: input.organizationId,
				meter: input.meter,
				units: input.units
			});
			return true;
		},
		async setBillingDetails(orgId, details, now) {
			const existing = accounts.get(orgId);
			if (!existing) return;
			accounts.set(orgId, {
				...existing,
				billingName: details.name,
				billingEmail: details.email,
				billingCountry: details.country,
				updatedAt: now
			});
		},
		async addPending(input) {
			if (!pending.has(input.sessionId)) {
				pending.set(input.sessionId, {
					organizationId: input.organizationId,
					mode: input.mode
				});
			}
		},
		async clearPending(orgId, sessionId) {
			return pending.get(sessionId)?.organizationId === orgId && pending.delete(sessionId);
		},
		async creditBalances(orgId) {
			const out: Record<string, number> = {};
			for (const row of credits.values()) {
				if (row.organizationId === orgId)
					out[row.meter] = (out[row.meter] ?? 0) + row.units;
			}
			return out;
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
		addOns?: { id: string; quantity?: number }[];
		organizationId?: string;
		interval?: 'month' | 'year';
	} = {}
) {
	const plans = (over.plans ?? ['managed-pro']).map((id) => findPlan(id) as Plan);
	const interval = over.interval ?? 'month';
	const addOns = (over.addOns ?? []).map((one) => ({
		quantity: 1,
		...one,
		addOn: findAddOn(one.id) as AddOn
	}));
	return {
		id: over.id ?? 'sub_fixture',
		object: 'subscription',
		customer: over.customer ?? 'cus_fixture',
		status: over.status ?? 'active',
		metadata: over.organizationId ? { organization_id: over.organizationId } : {},
		items: {
			object: 'list',
			data: [
				...plans.map((plan) => ({
					id: `si_${plan.id}`,
					object: 'subscription_item',
					quantity: 1,
					price: {
						id: `price_${plan.id}`,
						object: 'price',
						lookup_key: priceLookupKey(plan, interval)
					}
				})),
				...addOns.map((one) => ({
					id: `si_${one.id}`,
					object: 'subscription_item',
					quantity: one.quantity,
					price: {
						id: `price_${one.id}`,
						object: 'price',
						lookup_key: priceLookupKey(one.addOn, interval)
					}
				}))
			]
		}
	};
}

// the session a one-time pack opens; stripe leaves the line items out unless they are expanded
export const packCheckoutCompleted = (
	over: {
		addOn?: string;
		units?: number;
		org?: string | null;
		customer?: string | null;
		paymentStatus?: string;
		lines?: boolean;
		key?: string;
	} = {}
) => {
	const key =
		over.key ??
		packLookupKey(findAddOn(over.addOn ?? 'support-hours') as AddOn, over.units ?? 5);
	return {
		id: 'cs_pack_fixture',
		object: 'checkout.session',
		mode: 'payment',
		payment_status: over.paymentStatus ?? 'paid',
		customer: over.customer === undefined ? 'cus_fixture' : over.customer,
		subscription: null,
		client_reference_id: over.org === undefined ? 'org-1' : over.org,
		metadata: over.lines === false ? { price_lookup_key: key } : {},
		...(over.lines === false
			? {}
			: { line_items: { data: [{ price: { lookup_key: key }, quantity: 1 }] } })
	};
};

export const CONTACT: { name: string; email: string; country: string } = {
	name: 'Ada Owner',
	email: 'ada@example.test',
	country: 'US'
};

// an organisation that has saved the billing details the gate asks for
export async function withDetails(r: Rig, orgId = 'org-1', over: Partial<typeof CONTACT> = {}) {
	await r.store.ensureAccount(orgId, NOW);
	await r.store.setBillingDetails(orgId, { ...CONTACT, ...over }, NOW);
}

export const checkoutCompleted = (
	over: {
		customer?: string;
		org?: string | null;
		id?: string;
		paymentStatus?: string;
		details?: { name?: string; email?: string; country?: string };
	} = {}
) => ({
	id: over.id ?? 'cs_fixture',
	object: 'checkout.session',
	mode: 'subscription',
	payment_status: over.paymentStatus ?? 'paid',
	...(over.details
		? {
				customer_details: {
					name: over.details.name,
					email: over.details.email,
					address: { country: over.details.country }
				}
			}
		: {}),
	customer: over.customer ?? 'cus_fixture',
	subscription: 'sub_fixture',
	client_reference_id: over.org === undefined ? 'org-1' : over.org,
	metadata: {}
});

// #endregion
