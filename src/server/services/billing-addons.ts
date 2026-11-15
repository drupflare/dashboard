import { ApiError } from '../../shared/errors';
import {
	addOnOffered,
	findAddOn,
	findPlan,
	intervalPrice,
	packLookupKey,
	planPricesVisible,
	priceLookupKey,
	type AddOn,
	type Interval
} from '../../shared/plans';
import type { Principal } from '../domain/authorize';
import { IntervalMismatchError } from '../integrations/stripe';
import {
	SUBSCRIBED,
	billingServices,
	entitlementFor,
	requireBillingDetails,
	requireSession,
	type BillingServices
} from './billing';

export const MAX_ADD_ON_QUANTITY = 100;

interface Caller {
	orgId: string;
	admin: boolean;
	principal: Principal | null;
	idempotencyKey: string;
}

export type AddOnPurchase =
	| { mode: 'subscription'; addOn: string; quantity: number; interval: Interval }
	| { mode: 'pack'; addOn: string; units: number };

export type AddOnPurchaseRequest = Caller & AddOnPurchase;

export interface AddOnQuantityRequest extends Omit<Caller, 'admin'> {
	addOn: string;
	quantity: number;
}

export type AddOnPurchaseResult = { url: string } | { applied: true };

const notFound = () => new ApiError('not_found', 'Not found');

function refuse(message: string, reason: string): ApiError {
	return new ApiError('unprocessable', message, { reason });
}

function validQuantity(value: number, min: number): boolean {
	return Number.isInteger(value) && value >= min && value <= MAX_ADD_ON_QUANTITY;
}

const badQuantity = () =>
	refuse(`The quantity must be a whole number from 1 to ${MAX_ADD_ON_QUANTITY}`, 'bad_quantity');

// an add-on that does not exist, is not on sale or has a hidden price all read as absent, so the
// payment page can never confirm one
function sellable(id: string, admin: boolean): AddOn {
	const addOn = findAddOn(id);
	if (!addOn || !addOn.available || !planPricesVisible(addOn, { admin })) throw notFound();
	return addOn;
}

async function requireOffered(s: BillingServices, orgId: string, addOn: AddOn): Promise<void> {
	const entitlement = await entitlementFor(s, orgId);
	const plan = findPlan(entitlement.planId);
	if (!plan || !addOnOffered(addOn, plan)) {
		throw refuse('This add-on is not offered on the current plan', 'add_on_not_offered');
	}
}

function running(account: { subscriptionId: string | null; status: string } | null) {
	return account?.subscriptionId && SUBSCRIBED.includes(account.status)
		? account.subscriptionId
		: null;
}

// nothing here writes an entitlement: the subscription webhook is the only writer, so a purchase
// that is refused, abandoned or replayed changes no quantity
export async function startAddOnPurchase(
	s: BillingServices,
	request: AddOnPurchaseRequest
): Promise<AddOnPurchaseResult> {
	requireSession(request.principal);
	if (s.stripe === null) throw new ApiError('not_built', 'Billing is not available yet');
	const addOn = sellable(request.addOn, request.admin);
	await requireOffered(s, request.orgId, addOn);
	const account = await s.store.getAccount(request.orgId);
	const session = {
		organizationId: request.orgId,
		planLookupKey: addOn.lookupKey,
		customerId: account?.stripeCustomerId ?? null,
		successUrl: `${s.baseUrl}/billing?checkout=success`,
		cancelUrl: `${s.baseUrl}/billing?checkout=cancelled`,
		idempotencyKey: request.idempotencyKey
	};

	if (request.mode === 'pack') {
		const pack = addOn.packs.find((one) => one.units === request.units);
		if (!pack || (pack.price.value ?? 0) <= 0) {
			throw refuse('This pack size is not on sale', 'bad_pack');
		}
		requireBillingDetails(account);
		const key = packLookupKey(addOn, pack.units);
		const { url } = await s.stripe.createCheckoutSession({
			...session,
			priceLookupKey: key,
			mode: 'payment',
			lines: [{ priceLookupKey: key, quantity: 1 }]
		});
		return { url };
	}

	if (!validQuantity(request.quantity, 1)) throw badQuantity();
	if ((intervalPrice(addOn, request.interval) ?? 0) <= 0) {
		throw refuse('This add-on is not sold as a subscription', 'not_a_subscription');
	}
	requireBillingDetails(account);
	const key = priceLookupKey(addOn, request.interval);
	const subscriptionId = running(account);
	if (subscriptionId !== null) {
		try {
			await s.stripe.setSubscriptionItem({
				subscriptionId,
				priceLookupKey: key,
				quantity: request.quantity,
				idempotencyKey: request.idempotencyKey
			});
		} catch (error) {
			if (error instanceof IntervalMismatchError) {
				throw refuse(
					`Your plan bills ${error.held === 'year' ? 'yearly' : 'monthly'}, so add-ons bill the same way`,
					'interval_mismatch'
				);
			}
			throw error;
		}
		return { applied: true };
	}
	const { url } = await s.stripe.createCheckoutSession({
		...session,
		priceLookupKey: key,
		mode: 'subscription',
		lines: [{ priceLookupKey: key, quantity: request.quantity }]
	});
	return { url };
}

export async function setAddOnQuantity(
	s: BillingServices,
	request: AddOnQuantityRequest
): Promise<{ applied: true }> {
	requireSession(request.principal);
	if (s.stripe === null) throw new ApiError('not_built', 'Billing is not available yet');
	const account = await s.store.getAccount(request.orgId);
	const addOn = findAddOn(request.addOn);
	// an add-on the organisation does not hold reads as absent, whatever the id is
	if (!addOn || !account?.addOns.some((holding) => holding.id === addOn.id)) throw notFound();
	if (!validQuantity(request.quantity, 0)) {
		throw refuse(
			`The quantity must be a whole number from 0 to ${MAX_ADD_ON_QUANTITY}`,
			'bad_quantity'
		);
	}
	// a held add-on that is no longer on sale can be removed but not grown
	if (request.quantity > 0 && !addOn.available) {
		throw refuse('This add-on is no longer on sale', 'not_available');
	}
	const subscriptionId = running(account);
	if (subscriptionId === null) {
		throw refuse('This organisation has no running subscription to change', 'no_subscription');
	}
	await s.stripe.setSubscriptionItem({
		subscriptionId,
		// the item is matched by product, so the interval it was bought on does not matter
		priceLookupKey: priceLookupKey(addOn, 'month'),
		quantity: request.quantity,
		idempotencyKey: request.idempotencyKey
	});
	return { applied: true };
}

// units bought in packs per meter, zeros left out; an organisation reads as having none while
// billing is not installed
export async function creditsOf(orgId: string): Promise<Record<string, number>> {
	let s: BillingServices;
	try {
		s = billingServices();
	} catch (error) {
		if (error instanceof ApiError && error.code === 'not_built') return {};
		throw error;
	}
	const balances = await s.store.creditBalances(orgId);
	return Object.fromEntries(Object.entries(balances).filter(([, units]) => units > 0));
}
