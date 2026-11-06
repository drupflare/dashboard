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

export interface CheckoutInput {
	organizationId: string;
	priceLookupKey: string;
	planLookupKey: string;
	customerId: string | null;
	successUrl: string;
	cancelUrl: string;
	idempotencyKey: string;
}

export interface StripeClient {
	createCheckoutSession(input: CheckoutInput): Promise<{ id: string; url: string }>;
	createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
	// a dispute event names a charge and no customer
	chargeCustomer(chargeId: string): Promise<string | null>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createStripeClient(secretKey: string, fetchFn: FetchLike = fetch): StripeClient {
	const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(fetchFn) });
	return {
		async createCheckoutSession(input) {
			const prices = await stripe.prices.list({
				lookup_keys: [input.priceLookupKey],
				active: true,
				limit: 1
			});
			const price = prices.data[0];
			if (!price) throw new StripeSeamError(`no active price for ${input.priceLookupKey}`);
			const metadata = {
				organization_id: input.organizationId,
				plan: input.planLookupKey
			};
			const session = await stripe.checkout.sessions.create(
				{
					mode: 'subscription',
					line_items: [{ price: price.id, quantity: 1 }],
					client_reference_id: input.organizationId,
					...(input.customerId ? { customer: input.customerId } : {}),
					allow_promotion_codes: true,
					metadata,
					subscription_data: { metadata },
					success_url: input.successUrl,
					cancel_url: input.cancelUrl
				},
				{ idempotencyKey: input.idempotencyKey }
			);
			if (!session.url) throw new StripeSeamError('the checkout session has no url');
			return { id: session.id, url: session.url };
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
	| { method: 'createPortalSession'; input: { customerId: string; returnUrl: string } }
	| { method: 'chargeCustomer'; chargeId: string };

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
