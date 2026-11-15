import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import {
	ADD_ONS,
	PLANS,
	describeAddOn,
	describePlan,
	findPlan,
	intervalPrice,
	offerFromPriceKey,
	planPricesVisible,
	priceLookupKey,
	type Interval
} from '../../shared/plans';
import {
	addCredit,
	addPending,
	applySubscription,
	clearPending,
	creditBalances,
	ensureAccount,
	findOrgByCustomer,
	getAccount,
	hasEvent,
	linkCustomer,
	patchAccount,
	recordEvent,
	setBillingDetails,
	type AccountPatch,
	type BillingAccount,
	type BillingDetails,
	type CreditInput,
	type PendingInput,
	type SubscriptionApply
} from '../db/repos/billing';
import type { Facts, Principal } from '../domain/authorize';
import {
	FREE_PLAN_ID,
	canActivate,
	derive,
	type AddOnHolding,
	type Entitlement
} from '../domain/entitlements';
import type { Desired, DesiredSite } from '../domain/reconcile';
import {
	IntervalMismatchError,
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
	// false means the source id was already credited
	addCredit(input: CreditInput): Promise<boolean>;
	creditBalances(orgId: string): Promise<Record<string, number>>;
	// the stored copy of the contact and country; webhooks keep it in step with Stripe
	setBillingDetails(orgId: string, details: BillingDetails, now: number): Promise<void>;
	addPending(input: PendingInput): Promise<void>;
	// true when a pending purchase was there to clear
	clearPending(orgId: string, sessionId: string): Promise<boolean>;
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
		},
		async addCredit(input) {
			return addCredit(await getDb(), input);
		},
		async creditBalances(orgId) {
			return creditBalances(await getDb(), orgId);
		},
		async setBillingDetails(orgId, details, now) {
			await setBillingDetails(await getDb(), orgId, details, now);
		},
		async addPending(input) {
			await addPending(await getDb(), input);
		},
		async clearPending(orgId, sessionId) {
			return clearPending(await getDb(), orgId, sessionId);
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
	const result = live ? derive(account.planId, account.addOns) : derive(FREE_PLAN_ID);
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
	id: text,
	mode: z.string().nullish(),
	payment_status: z.string().nullish(),
	customer: ref.nullish(),
	subscription: ref.nullish(),
	client_reference_id: z.string().nullish(),
	customer_details: z
		.object({
			name: z.string().nullish(),
			email: z.string().nullish(),
			address: z.object({ country: z.string().nullish() }).nullish()
		})
		.nullish(),
	line_items: z
		.object({
			data: z.array(
				z.object({
					price: z.object({ lookup_key: z.string().nullish() }).nullish(),
					quantity: z.number().int().positive().nullish()
				})
			)
		})
		.nullish(),
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
		data: z.array(
			z.object({
				price: z.object({ lookup_key: z.string().nullish() }),
				quantity: z.number().int().nullish()
			})
		)
	}),
	metadata
});

const invoiceObject = z.object({ id: text, customer: ref.nullish() });
const chargeObject = z.object({ id: text, customer: ref.nullish() });
const disputeObject = z.object({ id: text, charge: ref });
const customerObject = z.object({
	id: text,
	email: z.string().nullish(),
	name: z.string().nullish(),
	address: z.object({ country: z.string().nullish() }).nullish()
});

export const HANDLED_EVENTS = [
	'checkout.session.completed',
	'checkout.session.async_payment_succeeded',
	'checkout.session.async_payment_failed',
	'checkout.session.expired',
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

// a webhook carries no line items, so the pack falls back to the price key in the metadata
// a credit records units bought and nothing spends them yet
async function creditPacks(
	ctx: EventContext,
	orgId: string,
	object: z.infer<typeof checkoutObject>
): Promise<number> {
	const { s, now, eventId } = ctx;
	if (!isSettled(object)) {
		s.log('pack checkout that is not paid', { eventId, status: object.payment_status ?? null });
		return 0;
	}
	const metaKey = object.metadata?.price_lookup_key;
	const lines = object.line_items
		? object.line_items.data.map((line) => ({
				key: line.price?.lookup_key ?? null,
				quantity: line.quantity ?? 1
			}))
		: metaKey
			? [{ key: metaKey, quantity: 1 }]
			: [];
	let credited = 0;
	for (const [index, line] of lines.entries()) {
		const offer = line.key ? offerFromPriceKey(line.key) : undefined;
		if (offer?.kind !== 'pack') {
			s.log('payment for a price that is not a pack', { eventId, key: line.key });
			continue;
		}
		const units = offer.units * line.quantity;
		const added = await s.store.addCredit({
			organizationId: orgId,
			meter: offer.addOn.meter,
			units,
			sourceId: index === 0 ? eventId : `${eventId}:${index}`,
			now
		});
		if (!added) continue;
		credited += 1;
		await audited(ctx, orgId, 'billing.credit.added', {
			addOn: offer.addOn.id,
			meter: offer.addOn.meter,
			units
		});
	}
	return credited;
}

// no_payment_required is a session a full discount made free; anything else has not settled yet
const SETTLED = ['paid', 'no_payment_required'];

const isSettled = (object: z.infer<typeof checkoutObject>) =>
	SETTLED.includes(object.payment_status ?? '');

const checkoutOrg = (object: z.infer<typeof checkoutObject>) =>
	object.client_reference_id ?? object.metadata?.organization_id ?? null;

// what Checkout collected goes into the stored copy; a value it did not collect is left alone
function collectedDetails(object: z.infer<typeof checkoutObject>): AccountPatch {
	const details = object.customer_details;
	return {
		...(details?.name ? { billingName: details.name } : {}),
		...(details?.email ? { billingEmail: details.email } : {}),
		...(details?.address?.country ? { billingCountry: details.address.country } : {})
	};
}

// a session whose payment has not settled grants nothing: it waits as a pending purchase until
// the async success, failure or expiry event settles it
async function onCheckout(
	ctx: EventContext,
	raw: unknown,
	fromAsync = false
): Promise<EventOutcome> {
	const object = checkoutObject.parse(raw);
	const customerId = object.customer ?? null;
	const orgId = checkoutOrg(object);
	if (orgId === null) return 'ignored';
	if (!isSettled(object)) {
		if (fromAsync) {
			ctx.s.log('async checkout success for a session that is not paid', {
				eventId: ctx.eventId,
				status: object.payment_status ?? null
			});
			return 'ignored';
		}
		await ctx.s.store.addPending({
			sessionId: object.id,
			organizationId: orgId,
			mode: object.mode ?? 'subscription',
			now: ctx.now
		});
		await audited(ctx, orgId, 'billing.purchase.pending', {
			sessionId: object.id,
			mode: object.mode ?? 'subscription'
		});
		return 'handled';
	}
	const outcome = await grantCheckout(ctx, object, orgId, customerId);
	if (fromAsync) await ctx.s.store.clearPending(orgId, object.id);
	return outcome;
}

async function grantCheckout(
	ctx: EventContext,
	object: z.infer<typeof checkoutObject>,
	orgId: string,
	customerId: string | null
): Promise<EventOutcome> {
	const credited = object.mode === 'payment' ? await creditPacks(ctx, orgId, object) : 0;
	if (customerId === null) return credited > 0 ? 'handled' : 'ignored';
	const { s, now, eventAt } = ctx;
	await s.store.ensureAccount(orgId, now);
	if ((await s.store.linkCustomer(customerId, orgId)) === 'conflict') {
		throw new Error(`customer ${customerId} is already linked to another organisation`);
	}
	await s.store.patchAccount(
		orgId,
		{
			stripeCustomerId: customerId,
			...(object.subscription ? { subscriptionId: object.subscription } : {}),
			...collectedDetails(object)
		},
		eventAt,
		now
	);
	await audited(ctx, orgId, 'billing.customer.linked', { customerId });
	return 'handled';
}

// a failed or expired session clears its pending purchase; only a failure is a payment problem
async function onCheckoutEnded(
	ctx: EventContext,
	raw: unknown,
	failed: boolean
): Promise<EventOutcome> {
	const object = checkoutObject.parse(raw);
	const orgId = checkoutOrg(object);
	if (orgId === null) return 'ignored';
	const cleared = await ctx.s.store.clearPending(orgId, object.id);
	if (failed) {
		await audited(ctx, orgId, 'billing.payment.failed', {
			sessionId: object.id,
			source: 'checkout'
		});
		return 'handled';
	}
	return cleared ? 'handled' : 'ignored';
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

	const bases: string[] = [];
	const holdings: AddOnHolding[] = [];
	for (const item of sub.items.data) {
		const key = item.price.lookup_key;
		const offer = key ? offerFromPriceKey(key) : undefined;
		if (!offer)
			throw new Error(`subscription ${sub.id} has a price this catalogue does not know`);
		if (offer.kind === 'plan') bases.push(offer.plan.id);
		else if (offer.kind === 'add-on') {
			holdings.push({ id: offer.addOn.id, quantity: item.quantity ?? 1 });
		} else {
			throw new Error(`subscription ${sub.id} holds a one-time pack as a recurring item`);
		}
	}
	if (bases.length > 1 || sub.items.data.length === 0) {
		throw new Error(`subscription ${sub.id} needs exactly one base plan`);
	}
	// a subscription of add-ons alone is how a free plan buys one; the plan stays as it is
	const baseId = bases[0] ?? (await s.store.getAccount(orgId))?.planId ?? FREE_PLAN_ID;

	let planId = baseId;
	let addOns: AddOnHolding[] = holdings;
	let entitlementState: string;
	if (RUNNING.includes(sub.status)) {
		const derived = derive(baseId, holdings);
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
		addOns = current.addOns;
		entitlementState = current.entitlementState;
	}

	const revision = await s.store.applySubscription({
		organizationId: orgId,
		customerId: sub.customer,
		subscriptionId: sub.id,
		planId,
		addOns,
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
	if (orgId === null) return 'ignored';
	// the event carries the whole customer, so a missing field means it was removed
	const changed = await ctx.s.store.patchAccount(
		orgId,
		{
			billingEmail: customer.email || null,
			billingName: customer.name || null,
			billingCountry: customer.address?.country || null
		},
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
		case 'checkout.session.async_payment_succeeded':
			return onCheckout(ctx, object, true);
		case 'checkout.session.async_payment_failed':
			return onCheckoutEnded(ctx, object, true);
		case 'checkout.session.expired':
			return onCheckoutEnded(ctx, object, false);
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

export type PlanListItem = ReturnType<typeof describePlan>;
export type AddOnListItem = ReturnType<typeof describeAddOn>;

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

export function listAddOns(admin: boolean): AddOnListItem[] {
	return ADD_ONS.map((addOn) => describeAddOn(addOn, { admin }));
}

export function requireSession(principal: Principal | null): void {
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

export const SUBSCRIBED = ['active', 'trialing', 'past_due'];

// the stored copy decides, never the request: a checkout or an add-on purchase needs a contact
// name and email and a billing country on the account
export type MissingDetail = 'name' | 'email' | 'country';

export function missingBillingDetails(account: BillingAccount | null): MissingDetail[] {
	const missing: MissingDetail[] = [];
	if (!account?.billingName?.trim()) missing.push('name');
	if (!account?.billingEmail?.trim()) missing.push('email');
	if (!account?.billingCountry?.trim()) missing.push('country');
	return missing;
}

export function requireBillingDetails(account: BillingAccount | null): void {
	const missing = missingBillingDetails(account);
	if (missing.length > 0) {
		throw new ApiError('unprocessable', 'Add your billing details first', {
			reason: 'billing_details_required',
			missing
		});
	}
}

// a free plan is one with no price at either interval; a plan with an unreviewed price counts as paid
export function isFreePlanId(planId: string): boolean {
	const plan = findPlan(planId);
	return (
		plan !== undefined &&
		intervalPrice(plan, 'month') === 0 &&
		intervalPrice(plan, 'year') === 0
	);
}

// an organisation holds one subscription. A free plan's subscription holds add-ons alone, so it
// does not stop a plan purchase; a paid plan's subscription does
export function holdsPlanSubscription(account: BillingAccount | null): boolean {
	return (
		account?.subscriptionId !== null &&
		account?.subscriptionId !== undefined &&
		SUBSCRIBED.includes(account.status) &&
		!isFreePlanId(account.planId)
	);
}

export const COUNTRY = /^[A-Z]{2}$/;

export interface DetailsRequest {
	orgId: string;
	principal: Principal | null;
	name: string;
	email: string;
	country: string;
}

// the way to supply the details the gate asks for; a known Stripe customer is updated too, so the
// next customer.updated agrees with what was saved
export async function saveBillingDetails(
	s: BillingServices,
	request: DetailsRequest
): Promise<{ saved: true }> {
	requireSession(request.principal);
	const name = request.name.trim();
	const email = request.email.trim();
	const country = request.country.trim().toUpperCase();
	if (!name || !email.includes('@') || !COUNTRY.test(country)) {
		throw new ApiError('unprocessable', 'Check the billing details', {
			reason: 'bad_billing_details'
		});
	}
	const account = await s.store.ensureAccount(request.orgId, s.now());
	await s.store.setBillingDetails(request.orgId, { name, email, country }, s.now());
	if (s.stripe !== null && account.stripeCustomerId) {
		await s.stripe.updateCustomer({
			customerId: account.stripeCustomerId,
			name,
			email,
			country
		});
	}
	await s.audit(request.orgId, {
		actor: request.principal?.kind === 'user' ? `user:${request.principal.userId}` : 'user',
		action: 'billing.details.saved',
		target: request.orgId,
		detail: { country }
	});
	return { saved: true };
}

export async function startCheckout(
	s: BillingServices,
	request: CheckoutRequest
): Promise<{ url: string } | { applied: true }> {
	requireSession(request.principal);
	if (s.stripe === null) throw new ApiError('not_built', 'Billing is not available yet');
	const plan = findPlan(request.planId);
	// a hidden price is never confirmed to exist, because the payment page would show it
	if (!plan || plan.disabled || !planPricesVisible(plan, { admin: request.admin })) {
		throw new ApiError('not_found', 'Not found');
	}
	const selfServe = plan.kind === 'managed' || plan.kind === 'self-managed';
	if (!selfServe || (intervalPrice(plan, request.interval) ?? 0) <= 0) {
		throw new ApiError('unprocessable', 'This plan cannot be bought online', {
			reason: 'not_self_serve'
		});
	}
	const account = await s.store.getAccount(request.orgId);
	if (holdsPlanSubscription(account)) {
		throw new ApiError('conflict', 'This organisation already has a subscription', {
			reason: 'already_subscribed'
		});
	}
	requireBillingDetails(account);
	// a running subscription of add-ons alone takes the plan as one more item, so the organisation
	// keeps one subscription and the plan webhook sees the plan and the add-ons together
	if (account?.subscriptionId && SUBSCRIBED.includes(account.status)) {
		try {
			await s.stripe.setSubscriptionItem({
				subscriptionId: account.subscriptionId,
				priceLookupKey: priceLookupKey(plan, request.interval),
				quantity: 1,
				idempotencyKey: request.idempotencyKey
			});
		} catch (error) {
			if (error instanceof IntervalMismatchError) {
				throw new ApiError(
					'unprocessable',
					`Your add-ons bill ${error.held === 'year' ? 'yearly' : 'monthly'}, so the plan bills the same way`,
					{ reason: 'interval_mismatch' }
				);
			}
			throw error;
		}
		return { applied: true };
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
