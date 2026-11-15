import Stripe from 'stripe';

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export const STRIPE_SECRET_NAMES = {
	secretKey: 'STRIPE_SECRET_KEY',
	webhookSecret: 'STRIPE_WEBHOOK_SECRET'
} as const;

export class WebhookSignatureError extends Error {
	readonly code = 'WEBHOOK_SIGNATURE';

	constructor(message: string) {
		super(message);
		this.name = 'WebhookSignatureError';
	}
}

export class StripeSeamError extends Error {
	readonly code = 'STRIPE_SEAM';

	constructor(message: string) {
		super(message);
		this.name = 'StripeSeamError';
	}
}

// stripe holds one billing period per subscription, so a new item must match it
export class IntervalMismatchError extends StripeSeamError {
	constructor(
		readonly held: string,
		readonly asked: string
	) {
		super(`the subscription bills ${held}ly and the price bills ${asked}ly`);
		this.name = 'IntervalMismatchError';
	}
}

export type StripeEvent = Stripe.Event;

const subtle = Stripe.createSubtleCryptoProvider();

// the sdk rejects a stale timestamp and accepts a future one; a far-future stamp is refused here
function stampOf(header: string): number | null {
	const match = /(?:^|,)\s*t=(\d+)/.exec(header);
	return match?.[1] === undefined ? null : Number(match[1]);
}

// nothing reads the body as data until the signature has passed: the sdk checks the signature
// over the raw bytes first and only then parses them
export async function verifyWebhook(
	rawBody: string,
	signature: string | null,
	secret: string,
	now: number
): Promise<StripeEvent> {
	if (signature === null || signature === '') {
		throw new WebhookSignatureError('the stripe-signature header is missing');
	}
	if (secret === '') throw new WebhookSignatureError('no webhook secret is configured');
	const stamp = stampOf(signature);
	if (stamp !== null && stamp * 1000 - now > WEBHOOK_TOLERANCE_SECONDS * 1000) {
		throw new WebhookSignatureError('the signature timestamp is in the future');
	}
	try {
		return await Stripe.webhooks.constructEventAsync(
			rawBody,
			signature,
			secret,
			WEBHOOK_TOLERANCE_SECONDS,
			subtle,
			now
		);
	} catch (error) {
		throw new WebhookSignatureError(
			error instanceof Error ? error.message.split('\n')[0] || 'invalid' : 'invalid'
		);
	}
}

// #region client seam

export interface CheckoutLine {
	priceLookupKey: string;
	quantity: number;
}

// a session with no lines buys priceLookupKey once as a subscription; lines replace that one price
// with several, each with its own quantity, and mode picks a subscription or a one-time payment
export interface CheckoutInput {
	organizationId: string;
	priceLookupKey: string;
	planLookupKey: string;
	customerId: string | null;
	successUrl: string;
	cancelUrl: string;
	idempotencyKey: string;
	mode?: 'subscription' | 'payment';
	lines?: CheckoutLine[];
}

export interface SubscriptionItemInput {
	subscriptionId: string;
	priceLookupKey: string;
	// 0 removes the item
	quantity: number;
	idempotencyKey: string;
}

export interface CustomerDetailsInput {
	customerId: string;
	name: string;
	email: string;
	// two-letter country code
	country: string;
}

export interface StripeClient {
	updateCustomer(input: CustomerDetailsInput): Promise<void>;
	createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
	setSubscriptionItem(input: SubscriptionItemInput): Promise<void>;
	createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
	// a dispute event names a charge and no customer
	chargeCustomer(chargeId: string): Promise<string | null>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createStripeClient(secretKey: string, fetchFn: FetchLike = fetch): StripeClient {
	const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(fetchFn) });
	const findPrice = async (lookupKey: string) => {
		const prices = await stripe.prices.list({
			lookup_keys: [lookupKey],
			active: true,
			limit: 1
		});
		const price = prices.data[0];
		if (!price) throw new StripeSeamError(`no active price for ${lookupKey}`);
		const product = typeof price.product === 'string' ? price.product : price.product?.id;
		return { id: price.id, product, interval: price.recurring?.interval ?? null };
	};
	const priceId = async (lookupKey: string) => (await findPrice(lookupKey)).id;
	return {
		async createCheckoutSession(input) {
			const lines = input.lines ?? [{ priceLookupKey: input.priceLookupKey, quantity: 1 }];
			const lineItems = [];
			for (const line of lines) {
				lineItems.push({
					price: await priceId(line.priceLookupKey),
					quantity: line.quantity
				});
			}
			const payment = input.mode === 'payment';
			const metadata = {
				organization_id: input.organizationId,
				plan: input.planLookupKey,
				price_lookup_key: input.priceLookupKey
			};
			const session = await stripe.checkout.sessions.create(
				{
					mode: payment ? 'payment' : 'subscription',
					line_items: lineItems,
					client_reference_id: input.organizationId,
					...(input.customerId
						? { customer: input.customerId }
						: payment
							? { customer_creation: 'always' as const }
							: {}),
					allow_promotion_codes: true,
					billing_address_collection: 'required' as const,
					name_collection: { individual: { enabled: true, optional: false } },
					tax_id_collection: { enabled: true },
					...(input.customerId
						? { customer_update: { name: 'auto' as const, address: 'auto' as const } }
						: {}),
					metadata,
					...(payment ? {} : { subscription_data: { metadata } }),
					success_url: input.successUrl,
					cancel_url: input.cancelUrl
				},
				{ idempotencyKey: input.idempotencyKey }
			);
			if (!session.url) throw new StripeSeamError('the checkout session has no url');
			return { id: session.id, url: session.url };
		},
		async setSubscriptionItem(input) {
			const price = await findPrice(input.priceLookupKey);
			const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
			// the item is matched by product, so a held add-on changes whichever interval it is on
			const item = subscription.items.data.find((one) => {
				const product = one.price.product;
				return (typeof product === 'string' ? product : product?.id) === price.product;
			});
			const options = { idempotencyKey: input.idempotencyKey };
			if (input.quantity === 0) {
				if (item) await stripe.subscriptionItems.del(item.id, {}, options);
			} else if (item) {
				await stripe.subscriptionItems.update(
					item.id,
					{ quantity: input.quantity },
					options
				);
			} else {
				const held = subscription.items.data[0]?.price.recurring?.interval;
				if (held && price.interval && held !== price.interval) {
					throw new IntervalMismatchError(held, price.interval);
				}
				await stripe.subscriptionItems.create(
					{
						subscription: input.subscriptionId,
						price: price.id,
						quantity: input.quantity
					},
					options
				);
			}
		},
		async updateCustomer(input) {
			await stripe.customers.update(input.customerId, {
				name: input.name,
				email: input.email,
				address: { country: input.country }
			});
		},
		async createPortalSession(input) {
			const session = await stripe.billingPortal.sessions.create({
				customer: input.customerId,
				return_url: input.returnUrl
			});
			return { url: session.url };
		},
		async chargeCustomer(chargeId) {
			const charge = await stripe.charges.retrieve(chargeId);
			const customer = charge.customer;
			if (customer === null || customer === undefined) return null;
			return typeof customer === 'string' ? customer : customer.id;
		}
	};
}

// #endregion

// #region fake

export type FakeCall =
	| { method: 'createCheckoutSession'; input: CheckoutInput }
	| { method: 'setSubscriptionItem'; input: SubscriptionItemInput }
	| { method: 'createPortalSession'; input: { customerId: string; returnUrl: string } }
	| { method: 'chargeCustomer'; chargeId: string }
	| { method: 'updateCustomer'; input: CustomerDetailsInput };

export interface FakeStripe extends StripeClient {
	calls: FakeCall[];
	charges: Map<string, string | null>;
}

export function fakeStripeClient(): FakeStripe {
	const calls: FakeCall[] = [];
	const charges = new Map<string, string | null>();
	return {
		calls,
		charges,
		async createCheckoutSession(input) {
			calls.push({ method: 'createCheckoutSession', input });
			return { id: 'cs_test_fake', url: 'https://checkout.example.test/cs_test_fake' };
		},
		async setSubscriptionItem(input) {
			calls.push({ method: 'setSubscriptionItem', input });
		},
		async updateCustomer(input) {
			calls.push({ method: 'updateCustomer', input });
		},
		async createPortalSession(input) {
			calls.push({ method: 'createPortalSession', input });
			return { url: 'https://billing.example.test/session/fake' };
		},
		async chargeCustomer(chargeId) {
			calls.push({ method: 'chargeCustomer', chargeId });
			return charges.get(chargeId) ?? null;
		}
	};
}

// #endregion
