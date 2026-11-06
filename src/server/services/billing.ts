import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
	PLANS,
	describePlan,
	findPlan,
	intervalPrice,
	planFromPriceKey,
	planPricesVisible,
	priceLookupKey,
	type Interval
} from '../../shared/plans';
import {
	applySubscription,
	ensureAccount,
	findOrgByCustomer,
	getAccount,
	hasEvent,
	linkCustomer,
	patchAccount,
	recordEvent,
	type AccountPatch,
	type BillingAccount,
	type SubscriptionApply
} from '../db/repos/billing';
import type { Facts, Principal } from '../domain/authorize';
import { FREE_PLAN_ID, canActivate, derive, type Entitlement } from '../domain/entitlements';
import type { Desired, DesiredSite } from '../domain/reconcile';
import {
	WebhookSignatureError,
	verifyWebhook,
	type StripeClient,
	type StripeEvent
} from '../integrations/stripe';
import type { AuditInput } from './audit';

// #region store

export interface BillingStore {
	getAccount(orgId: string): Promise<BillingAccount | null>;
	ensureAccount(orgId: string, now: number): Promise<BillingAccount>;
	linkCustomer(customerId: string, orgId: string): Promise<'linked' | 'conflict'>;
	findOrgByCustomer(customerId: string): Promise<string | null>;
	applySubscription(input: SubscriptionApply): Promise<number | null>;
	patchAccount(
		orgId: string,
		patch: AccountPatch,
		eventAt: number,
		now: number
	): Promise<boolean>;
	hasEvent(eventId: string): Promise<boolean>;
	recordEvent(eventId: string, type: string, now: number): Promise<void>;
}

export function collegeBillingStore(getDb: () => Promise<CollegeDBClient>): BillingStore {
	return {
		async getAccount(orgId) {
			return getAccount(await getDb(), orgId);
		},
		async ensureAccount(orgId, now) {
			return ensureAccount(await getDb(), orgId, FREE_PLAN_ID, now);
		},
		async linkCustomer(customerId, orgId) {
			return linkCustomer(await getDb(), customerId, orgId);
		},
		async findOrgByCustomer(customerId) {
			return findOrgByCustomer(await getDb(), customerId);
		},
		async applySubscription(input) {
			return applySubscription(await getDb(), input);
		},
		async patchAccount(orgId, patch, eventAt, now) {
			return patchAccount(await getDb(), orgId, patch, eventAt, now);
		},
		async hasEvent(eventId) {
			return hasEvent(await getDb(), eventId);
		},
		async recordEvent(eventId, type, now) {
			await recordEvent(await getDb(), eventId, type, now);
		}
	};
}

// #endregion

// #region services

export interface BillingFlags {
	// sso.built
	ssoBuilt: boolean;
	// billing.overage.enabled
	overageEnabled: boolean;
}

export interface BillingServices {
	stripe: StripeClient | null;
	webhookSecret: string | null;
	store: BillingStore;
	audit(orgId: string, input: AuditInput): Promise<void>;
	flags: BillingFlags;
	now(): number;
	log(message: string, detail: Record<string, unknown>): void;
	baseUrl: string;
}

let installed: BillingServices | null = null;

export function setBillingServices(services: BillingServices | null): void {
	installed = services;
}

export function billingServices(): BillingServices {
	if (installed === null) throw new ApiError('not_built', 'Billing is not available yet');
	return installed;
}

export function billingFlags(env: Record<string, unknown>): BillingFlags {
	const on = (name: string) => env[name] === 'true';
	return { ssoBuilt: on('SSO_BUILT'), overageEnabled: on('BILLING_OVERAGE_ENABLED') };
}

// #endregion

// #region entitlement of an account

// only an activated account runs its plan; a blocked, revoked or new one runs the free plan
export function entitlementOf(account: BillingAccount | null): Entitlement {
	const live = account !== null && account.entitlementState === 'activated';
	const result = live ? derive(account.planId, account.addOnIds) : derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(`billing account holds an unusable plan: ${result.reason}`);
	return result.entitlement;
}

export async function entitlementFor(s: BillingServices, orgId: string): Promise<Entitlement> {
	return entitlementOf(await s.store.getAccount(orgId));
}

export async function desiredFor(
	s: BillingServices,
	orgId: string,
	sites: readonly DesiredSite[],
	overage: Desired['overage'] = null
): Promise<Desired> {
	const account = await s.store.getAccount(orgId);
	return {
		orgId,
		revision: account?.revision ?? 0,
		entitlement: entitlementOf(account),
		sites,
		overage
	};
}

// #endregion

// #region webhook events

const text = z.string().min(1);
const ref = z
	.union([text, z.object({ id: text })])
	.transform((v) => (typeof v === 'string' ? v : v.id));
const metadata = z.record(z.string(), z.string()).nullish();

const checkoutObject = z.object({
	customer: ref.nullish(),
	subscription: ref.nullish(),
	client_reference_id: z.string().nullish(),
	metadata
});

const subscriptionObject = z.object({
	id: text,
	customer: ref,
	status: z.enum([
		'incomplete',
		'incomplete_expired',
		'trialing',
		'active',
		'past_due',
		'canceled',
		'unpaid',
		'paused'
	]),
	items: z.object({
		data: z.array(z.object({ price: z.object({ lookup_key: z.string().nullish() }) }))
	}),
	metadata
});

const invoiceObject = z.object({ id: text, customer: ref.nullish() });
const chargeObject = z.object({ id: text, customer: ref.nullish() });
const disputeObject = z.object({ id: text, charge: ref });
const customerObject = z.object({ id: text, email: z.string().nullish() });

export const HANDLED_EVENTS = [
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
	'invoice.paid',
	'invoice.payment_failed',
	'invoice.finalized',
	'charge.refunded',
	'charge.dispute.created',
	'customer.updated'
] as const;

export type EventOutcome = 'handled' | 'ignored' | 'unknown_type';

interface EventContext {
	s: BillingServices;
	eventId: string;
	eventAt: number;
	now: number;
}

async function resolveOrg(
	ctx: EventContext,
	customerId: string,
	hint: string | null | undefined
): Promise<string | null> {
	const linked = await ctx.s.store.findOrgByCustomer(customerId);
	if (linked !== null) return linked;
	if (!hint) return null;
	if ((await ctx.s.store.linkCustomer(customerId, hint)) === 'conflict') {
		throw new Error(`customer ${customerId} is already linked to another organisation`);
	}
	return hint;
}

const audited = (
	ctx: EventContext,
	orgId: string,
	action: string,
	detail: Record<string, unknown>
) =>
	ctx.s.audit(orgId, {
		actor: `stripe:${ctx.eventId}`,
		action,
		target: orgId,
		detail
	});

async function onCheckout(ctx: EventContext, raw: unknown): Promise<EventOutcome> {
	const object = checkoutObject.parse(raw);
	const customerId = object.customer ?? null;
	const orgId = object.client_reference_id ?? object.metadata?.organization_id ?? null;
	if (customerId === null || orgId === null) return 'ignored';
	const { s, now, eventAt } = ctx;
	await s.store.ensureAccount(orgId, now);
	if ((await s.store.linkCustomer(customerId, orgId)) === 'conflict') {
		throw new Error(`customer ${customerId} is already linked to another organisation`);
	}
	await s.store.patchAccount(
		orgId,
		{
			stripeCustomerId: customerId,
			...(object.subscription ? { subscriptionId: object.subscription } : {})
		},
		eventAt,
		now
	);
	await audited(ctx, orgId, 'billing.customer.linked', { customerId });
	return 'handled';
}

const ENDED = ['canceled', 'unpaid', 'incomplete_expired'];
const RUNNING = ['active', 'trialing', 'past_due'];

async function onSubscription(ctx: EventContext, raw: unknown): Promise<EventOutcome> {
	const sub = subscriptionObject.parse(raw);
	const { s, now, eventAt } = ctx;
	const orgId = await resolveOrg(ctx, sub.customer, sub.metadata?.organization_id);
	if (orgId === null) {
		s.log('subscription for an unlinked customer', {
			eventId: ctx.eventId,
			customer: sub.customer
		});
		return 'ignored';
	}

	const resolved = sub.items.data.map((item) => {
		const key = item.price.lookup_key;
		const found = key ? planFromPriceKey(key) : undefined;
		if (!found)
			throw new Error(`subscription ${sub.id} has a price this catalogue does not know`);
		return found.plan;
	});
	const bases = resolved.filter((plan) => plan.kind !== 'add-on');
	if (bases.length !== 1) throw new Error(`subscription ${sub.id} needs exactly one base plan`);
	const base = bases[0]!;
	const addOnIds = resolved.filter((plan) => plan.kind === 'add-on').map((plan) => plan.id);

	let planId = base.id;
	let addOns = addOnIds;
	let entitlementState: string;
	if (RUNNING.includes(sub.status)) {
		const derived = derive(base.id, addOnIds);
		if (!derived.ok)
			throw new Error(`subscription ${sub.id} cannot be derived: ${derived.reason}`);
		entitlementState = canActivate(derived.entitlement, s.flags).ok ? 'activated' : 'blocked';
	} else if (ENDED.includes(sub.status)) {
		planId = FREE_PLAN_ID;
		addOns = [];
		entitlementState = 'revoked';
	} else {
		const current = await s.store.ensureAccount(orgId, now);
		planId = current.planId;
		addOns = current.addOnIds;
		entitlementState = current.entitlementState;
	}

	const revision = await s.store.applySubscription({
		organizationId: orgId,
		customerId: sub.customer,
		subscriptionId: sub.id,
		planId,
		addOnIds: addOns,
		status: sub.status,
		entitlementState,
		eventAt,
		now
	});
	if (revision === null) {
		s.log('stale subscription event', { eventId: ctx.eventId, orgId });
		return 'ignored';
	}
	await audited(ctx, orgId, `billing.entitlement.${entitlementState}`, {
		planId,
		addOns,
		status: sub.status,
		subscriptionId: sub.id,
		revision
	});
	return 'handled';
}

async function onInvoice(ctx: EventContext, type: string, raw: unknown): Promise<EventOutcome> {
	const invoice = invoiceObject.parse(raw);
	if (!invoice.customer) return 'ignored';
	const orgId = await ctx.s.store.findOrgByCustomer(invoice.customer);
	if (orgId === null) return 'ignored';
	const account = await ctx.s.store.getAccount(orgId);
	if (account === null) return 'ignored';
	const patch: AccountPatch = { lastInvoiceId: invoice.id };
	if (type === 'invoice.payment_failed') patch.status = 'past_due';
	if (type === 'invoice.paid' && account.status === 'past_due') patch.status = 'active';
	if (!(await ctx.s.store.patchAccount(orgId, patch, ctx.eventAt, ctx.now))) return 'ignored';
	if (type === 'invoice.payment_failed') {
		await audited(ctx, orgId, 'billing.payment.failed', { invoiceId: invoice.id });
	}
	return 'handled';
}

// a refund or a dispute flags the account for a person and changes no entitlement: the amount
// refunded does not say whether the subscription should end
async function onReview(
	ctx: EventContext,
	customerId: string | null,
	reason: 'refunded' | 'disputed',
	detail: Record<string, unknown>
): Promise<EventOutcome> {
	if (customerId === null) return 'ignored';
	const orgId = await ctx.s.store.findOrgByCustomer(customerId);
	if (orgId === null) return 'ignored';
	if (!(await ctx.s.store.patchAccount(orgId, { reviewReason: reason }, ctx.eventAt, ctx.now))) {
		return 'ignored';
	}
	await audited(ctx, orgId, `billing.${reason}`, detail);
	return 'handled';
}

async function onCustomer(ctx: EventContext, raw: unknown): Promise<EventOutcome> {
	const customer = customerObject.parse(raw);
	const orgId = await ctx.s.store.findOrgByCustomer(customer.id);
	if (orgId === null || !customer.email) return 'ignored';
	const changed = await ctx.s.store.patchAccount(
		orgId,
		{ billingEmail: customer.email },
		ctx.eventAt,
		ctx.now
	);
	return changed ? 'handled' : 'ignored';
}

export async function handleEvent(s: BillingServices, event: StripeEvent): Promise<EventOutcome> {
	const ctx: EventContext = { s, eventId: event.id, eventAt: event.created * 1000, now: s.now() };
	const object: unknown = event.data.object;
	switch (event.type) {
		case 'checkout.session.completed':
			return onCheckout(ctx, object);
		case 'customer.subscription.created':
		case 'customer.subscription.updated':
		case 'customer.subscription.deleted':
			return onSubscription(ctx, object);
		case 'invoice.paid':
		case 'invoice.payment_failed':
		case 'invoice.finalized':
			return onInvoice(ctx, event.type, object);
		case 'charge.refunded': {
			const charge = chargeObject.parse(object);
			return onReview(ctx, charge.customer ?? null, 'refunded', { chargeId: charge.id });
		}
		case 'charge.dispute.created': {
			const dispute = disputeObject.parse(object);
			const customer = s.stripe ? await s.stripe.chargeCustomer(dispute.charge) : null;
			return onReview(ctx, customer, 'disputed', {
				disputeId: dispute.id,
				chargeId: dispute.charge
			});
		}
		case 'customer.updated':
			return onCustomer(ctx, object);
		default:
			s.log('unknown stripe event type', { eventId: event.id, type: event.type });
			return 'unknown_type';
	}
}

export interface WebhookResult {
	status: number;
	body: { received: true; duplicate?: true; outcome?: EventOutcome };
}

// the signature is checked first; the event id is written only after the handler succeeds, so a
// failed handler leaves the event open for the retry
export async function processWebhook(
	s: BillingServices,
	rawBody: string,
	signature: string | null
): Promise<WebhookResult> {
	if (s.webhookSecret === null) throw new ApiError('not_built', 'Billing is not available yet');
	let event: StripeEvent;
	try {
		event = await verifyWebhook(rawBody, signature, s.webhookSecret, s.now());
	} catch (error) {
		if (error instanceof WebhookSignatureError) {
			throw new ApiError('validation', 'The webhook signature is not valid');
		}
		throw error;
	}
	if (await s.store.hasEvent(event.id))
		return { status: 200, body: { received: true, duplicate: true } };
	const outcome = await handleEvent(s, event);
	await s.store.recordEvent(event.id, event.type, s.now());
	return { status: 200, body: { received: true, outcome } };
}

// #endregion

// #region routes

export interface PlanListItem {
	id: string;
	name: string;
	kind: string;
	lookupKey: string;
	sites: number | null;
	views: number | null;
	support: string;
	disabled: boolean;
	monthly?: number | null;
	annual?: number | null;
	unreviewed?: boolean;
}

// prices are for platform admins who hold the billing support permission and passed Access
export function isBillingAdmin(facts: Facts | null): boolean {
	const platform = facts?.platform;
	return (
		platform?.admin === true &&
		platform.access === true &&
		platform.permissions.includes('billing_support')
	);
}

export function listPlans(admin: boolean): PlanListItem[] {
	return PLANS.map((plan) => describePlan(plan, { admin }));
}

function requireSession(principal: Principal | null): void {
	if (principal === null || principal.kind !== 'user') {
		throw new ApiError('forbidden', 'This action needs a signed-in session', {
			requires: 'session'
		});
	}
}

export interface CheckoutRequest {
	orgId: string;
	planId: string;
	interval: Interval;
	admin: boolean;
	principal: Principal | null;
	idempotencyKey: string;
}

const SUBSCRIBED = ['active', 'trialing', 'past_due'];

export async function startCheckout(
	s: BillingServices,
	request: CheckoutRequest
): Promise<{ url: string }> {
	requireSession(request.principal);
	if (s.stripe === null) throw new ApiError('not_built', 'Billing is not available yet');
	const plan = findPlan(request.planId);
	// a hidden price is never confirmed to exist, because the payment page would show it
	if (!plan || plan.disabled || !planPricesVisible(plan, { admin: request.admin })) {
		throw new ApiError('not_found', 'Not found');
	}
	if (plan.kind !== 'managed' || (intervalPrice(plan, request.interval) ?? 0) <= 0) {
		throw new ApiError('unprocessable', 'This plan cannot be bought online', {
			reason: 'not_self_serve'
		});
	}
	const account = await s.store.getAccount(request.orgId);
	if (account?.subscriptionId && SUBSCRIBED.includes(account.status)) {
		throw new ApiError('conflict', 'This organisation already has a subscription', {
			reason: 'already_subscribed'
		});
	}
	const session = await s.stripe.createCheckoutSession({
		organizationId: request.orgId,
		priceLookupKey: priceLookupKey(plan, request.interval),
		planLookupKey: plan.lookupKey,
		customerId: account?.stripeCustomerId ?? null,
		successUrl: `${s.baseUrl}/billing?checkout=success`,
		cancelUrl: `${s.baseUrl}/billing?checkout=cancelled`,
		idempotencyKey: request.idempotencyKey
	});
	return { url: session.url };
}

export async function startPortal(
	s: BillingServices,
	request: { orgId: string; principal: Principal | null }
): Promise<{ url: string }> {
	requireSession(request.principal);
	if (s.stripe === null) throw new ApiError('not_built', 'Billing is not available yet');
	const account = await s.store.getAccount(request.orgId);
	if (!account?.stripeCustomerId) {
		throw new ApiError('not_found', 'This organisation has no billing account', {
			reason: 'no_billing_account'
		});
	}
	return s.stripe.createPortalSession({
		customerId: account.stripeCustomerId,
		returnUrl: `${s.baseUrl}/billing`
	});
}

// #endregion
