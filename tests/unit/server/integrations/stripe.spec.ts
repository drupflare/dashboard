import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
	IntervalMismatchError,
	STRIPE_SECRET_NAMES,
	StripeSeamError,
	WEBHOOK_TOLERANCE_SECONDS,
	WebhookSignatureError,
	createStripeClient,
	fakeStripeClient,
	verifyWebhook
} from '../../../../src/server/integrations/stripe';

const SECRET = 'whsec_fixture_secret';
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', created: 1 });

async function sign(body: string, atMs: number, secret = SECRET): Promise<string> {
	return Stripe.webhooks.generateTestHeaderStringAsync({
		timestamp: Math.floor(atMs / 1000),
		payload: body,
		secret,
		cryptoProvider: Stripe.createSubtleCryptoProvider()
	});
}

const refused = async (promise: Promise<unknown>) => {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(WebhookSignatureError);
	return error as WebhookSignatureError;
};

describe('verifyWebhook', () => {
	it('returns the event for a signature made over the raw body', async () => {
		const event = await verifyWebhook(BODY, await sign(BODY, NOW), SECRET, NOW);
		expect(event.id).toBe('evt_1');
		expect(event.type).toBe('invoice.paid');
	});

	it('uses a five minute tolerance', () => {
		expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
	});

	it('accepts an event at the edge of the tolerance and refuses one second past it', async () => {
		const edge = await sign(BODY, NOW - 300_000);
		expect((await verifyWebhook(BODY, edge, SECRET, NOW)).id).toBe('evt_1');
		await refused(verifyWebhook(BODY, await sign(BODY, NOW - 301_000), SECRET, NOW));
	});

	it('refuses a timestamp from the future past the tolerance', async () => {
		await refused(verifyWebhook(BODY, await sign(BODY, NOW + 301_000), SECRET, NOW));
		expect((await verifyWebhook(BODY, await sign(BODY, NOW + 60_000), SECRET, NOW)).id).toBe(
			'evt_1'
		);
	});

	it('refuses a missing header, a blank secret, a wrong secret and a changed body', async () => {
		const header = await sign(BODY, NOW);
		await refused(verifyWebhook(BODY, null, SECRET, NOW));
		await refused(verifyWebhook(BODY, '', SECRET, NOW));
		await refused(verifyWebhook(BODY, header, '', NOW));
		await refused(verifyWebhook(BODY, await sign(BODY, NOW, 'whsec_other'), SECRET, NOW));
		await refused(verifyWebhook(`${BODY} `, header, SECRET, NOW));
		await refused(verifyWebhook(BODY, 'garbage', SECRET, NOW));
	});

	it('fails on the signature before it looks at the body', async () => {
		const error = await refused(verifyWebhook('{not json', await sign(BODY, NOW), SECRET, NOW));
		expect(error.message).not.toMatch(/JSON|token/i);
	});

	it('refuses a signed body that is not JSON', async () => {
		const body = 'not json';
		await refused(verifyWebhook(body, await sign(body, NOW), SECRET, NOW));
	});

	it('names the two secrets main must set', () => {
		expect(STRIPE_SECRET_NAMES).toEqual({
			secretKey: 'STRIPE_SECRET_KEY',
			webhookSecret: 'STRIPE_WEBHOOK_SECRET'
		});
	});
});

// #region client over a recording fetch

interface Seen {
	method: string;
	url: URL;
	body: URLSearchParams;
	idempotency: string | null;
}

function recordingFetch(answers: Record<string, unknown>) {
	const seen: Seen[] = [];
	const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		seen.push({
			method: request.method,
			url,
			body: new URLSearchParams(await request.text()),
			idempotency: request.headers.get('idempotency-key')
		});
		const answer = answers[`${request.method} ${url.pathname}`];
		if (answer === undefined)
			throw new Error(`no fixture for ${request.method} ${url.pathname}`);
		return new Response(JSON.stringify(answer), {
			status: 200,
			headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' }
		});
	};
	return { seen, fetchFn };
}

const PRICE_LIST = {
	object: 'list',
	url: '/v1/prices',
	has_more: false,
	data: [
		{
			id: 'price_fixture',
			object: 'price',
			product: 'prod_fixture',
			lookup_key: 'drupflare_managed_site_monthly'
		}
	]
};

const SESSION = {
	id: 'cs_fixture',
	object: 'checkout.session',
	url: 'https://checkout.example.test/c/pay/cs_fixture'
};

const INPUT = {
	organizationId: 'org-1',
	priceLookupKey: 'drupflare_managed_site_monthly',
	planLookupKey: 'drupflare_managed_site',
	customerId: null,
	successUrl: 'https://app.example.test/ok',
	cancelUrl: 'https://app.example.test/no',
	idempotencyKey: 'idem-1'
};

describe('createStripeClient', () => {
	it('looks the price up by key and opens a subscription checkout for the organisation', async () => {
		const { seen, fetchFn } = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': SESSION
		});
		const client = createStripeClient('sk_test_fixture', fetchFn);
		expect(await client.createCheckoutSession(INPUT)).toEqual({
			id: 'cs_fixture',
			url: SESSION.url
		});
		expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([
			'GET /v1/prices',
			'POST /v1/checkout/sessions'
		]);
		expect(seen[0]?.url.searchParams.getAll('lookup_keys[0]')).toEqual([
			'drupflare_managed_site_monthly'
		]);
		const form = seen[1]?.body as URLSearchParams;
		expect(form.get('mode')).toBe('subscription');
		expect(form.get('client_reference_id')).toBe('org-1');
		expect(form.get('line_items[0][price]')).toBe('price_fixture');
		expect(form.get('metadata[organization_id]')).toBe('org-1');
		expect(form.get('subscription_data[metadata][organization_id]')).toBe('org-1');
		expect(form.has('customer')).toBe(false);
	});

	it('collects the billing address, a name and an optional tax id, and saves them to a known customer', async () => {
		const { seen, fetchFn } = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': SESSION
		});
		const client = createStripeClient('sk_test_fixture', fetchFn);
		await client.createCheckoutSession(INPUT);
		const fresh = seen.at(-1)?.body as URLSearchParams;
		expect(fresh.get('billing_address_collection')).toBe('required');
		expect(fresh.get('name_collection[individual][enabled]')).toBe('true');
		expect(fresh.get('name_collection[individual][optional]')).toBe('false');
		expect(fresh.get('tax_id_collection[enabled]')).toBe('true');
		expect(fresh.has('customer_update[address]')).toBe(false);
		await client.createCheckoutSession({ ...INPUT, customerId: 'cus_1' });
		const known = seen.at(-1)?.body as URLSearchParams;
		expect(known.get('billing_address_collection')).toBe('required');
		expect(known.get('customer_update[address]')).toBe('auto');
		expect(known.get('customer_update[name]')).toBe('auto');
	});

	it('updates the contact and country on a customer', async () => {
		const { seen, fetchFn } = recordingFetch({ 'POST /v1/customers/cus_1': { id: 'cus_1' } });
		await createStripeClient('sk_test_fixture', fetchFn).updateCustomer({
			customerId: 'cus_1',
			name: 'Ada Owner',
			email: 'ada@example.test',
			country: 'US'
		});
		const form = seen[0]?.body as URLSearchParams;
		expect(form.get('name')).toBe('Ada Owner');
		expect(form.get('email')).toBe('ada@example.test');
		expect(form.get('address[country]')).toBe('US');
	});

	it('reuses a known customer', async () => {
		const { seen, fetchFn } = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': SESSION
		});
		await createStripeClient('sk_test_fixture', fetchFn).createCheckoutSession({
			...INPUT,
			customerId: 'cus_1'
		});
		expect(seen[1]?.body.get('customer')).toBe('cus_1');
	});

	it('opens a subscription checkout with a quantity on each line', async () => {
		const { seen, fetchFn } = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': SESSION
		});
		await createStripeClient('sk_test_fixture', fetchFn).createCheckoutSession({
			...INPUT,
			mode: 'subscription',
			lines: [
				{ priceLookupKey: 'a', quantity: 3 },
				{ priceLookupKey: 'b', quantity: 1 }
			]
		});
		expect(seen.filter((s) => s.method === 'GET')).toHaveLength(2);
		const form = seen.at(-1)?.body as URLSearchParams;
		expect(form.get('mode')).toBe('subscription');
		expect(form.get('line_items[0][quantity]')).toBe('3');
		expect(form.get('line_items[1][quantity]')).toBe('1');
		expect(form.get('subscription_data[metadata][organization_id]')).toBe('org-1');
	});

	it('opens a one-time payment checkout that creates a customer when none is known', async () => {
		const { seen, fetchFn } = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': SESSION
		});
		const client = createStripeClient('sk_test_fixture', fetchFn);
		await client.createCheckoutSession({ ...INPUT, mode: 'payment' });
		const form = seen.at(-1)?.body as URLSearchParams;
		expect(form.get('mode')).toBe('payment');
		expect(form.get('customer_creation')).toBe('always');
		expect(form.get('metadata[price_lookup_key]')).toBe(INPUT.priceLookupKey);
		expect([...form.keys()].some((key) => key.startsWith('subscription_data'))).toBe(false);
		await client.createCheckoutSession({ ...INPUT, mode: 'payment', customerId: 'cus_1' });
		const known = seen.at(-1)?.body as URLSearchParams;
		expect(known.get('customer')).toBe('cus_1');
		expect(known.has('customer_creation')).toBe(false);
	});

	describe('setSubscriptionItem', () => {
		const SUBSCRIPTION = {
			id: 'sub_1',
			object: 'subscription',
			items: {
				object: 'list',
				has_more: false,
				data: [
					{
						id: 'si_1',
						object: 'subscription_item',
						quantity: 1,
						price: {
							id: 'price_annual_elsewhere',
							object: 'price',
							product: 'prod_fixture'
						}
					},
					{
						id: 'si_other',
						object: 'subscription_item',
						quantity: 1,
						price: { id: 'price_other', object: 'price', product: 'prod_other' }
					}
				]
			}
		};
		const input = (quantity: number) => ({
			subscriptionId: 'sub_1',
			priceLookupKey: 'drupflare_managed_site_monthly',
			quantity,
			idempotencyKey: 'idem-9'
		});
		const rig = (subscription: unknown = SUBSCRIPTION) =>
			recordingFetch({
				'GET /v1/prices': PRICE_LIST,
				'GET /v1/subscriptions/sub_1': subscription,
				'POST /v1/subscription_items/si_1': { id: 'si_1', object: 'subscription_item' },
				'DELETE /v1/subscription_items/si_1': {
					id: 'si_1',
					object: 'subscription_item',
					deleted: true
				},
				'POST /v1/subscription_items': { id: 'si_2', object: 'subscription_item' }
			});
		const writes = (seen: Seen[]) =>
			seen.filter((s) => s.method !== 'GET').map((s) => `${s.method} ${s.url.pathname}`);

		it('changes the quantity of an item the subscription already holds, on whichever interval', async () => {
			const { seen, fetchFn } = rig();
			await createStripeClient('sk_test_fixture', fetchFn).setSubscriptionItem(input(4));
			expect(writes(seen)).toEqual(['POST /v1/subscription_items/si_1']);
			expect(seen.at(-1)?.body.get('quantity')).toBe('4');
			expect(seen.at(-1)?.body.has('proration_behavior')).toBe(false);
			expect(seen.at(-1)?.idempotency).toBe('idem-9');
		});

		it('adds the item when the subscription does not hold it', async () => {
			const { seen, fetchFn } = rig({
				...SUBSCRIPTION,
				items: { ...SUBSCRIPTION.items, data: [] }
			});
			await createStripeClient('sk_test_fixture', fetchFn).setSubscriptionItem(input(2));
			expect(writes(seen)).toEqual(['POST /v1/subscription_items']);
			expect(seen.at(-1)?.body.get('subscription')).toBe('sub_1');
			expect(seen.at(-1)?.body.get('price')).toBe('price_fixture');
			expect(seen.at(-1)?.body.get('quantity')).toBe('2');
		});

		it('refuses a new item whose price bills on another interval than the subscription', async () => {
			const priced = (interval: string) => ({
				...PRICE_LIST,
				data: [{ ...PRICE_LIST.data[0], recurring: { interval } }]
			});
			const monthly = {
				...SUBSCRIPTION,
				items: {
					...SUBSCRIPTION.items,
					data: [
						{
							id: 'si_plan',
							object: 'subscription_item',
							quantity: 1,
							price: {
								id: 'price_plan',
								object: 'price',
								product: 'prod_plan',
								recurring: { interval: 'month' }
							}
						}
					]
				}
			};
			const mismatch = recordingFetch({
				'GET /v1/prices': priced('year'),
				'GET /v1/subscriptions/sub_1': monthly
			});
			await expect(
				createStripeClient('sk_test_fixture', mismatch.fetchFn).setSubscriptionItem(
					input(1)
				)
			).rejects.toBeInstanceOf(IntervalMismatchError);
			expect(writes(mismatch.seen)).toEqual([]);
		});

		it('removes the item at quantity 0 and does nothing when it is not held', async () => {
			const held = rig();
			await createStripeClient('sk_test_fixture', held.fetchFn).setSubscriptionItem(input(0));
			expect(writes(held.seen)).toEqual(['DELETE /v1/subscription_items/si_1']);
			const absent = rig({ ...SUBSCRIPTION, items: { ...SUBSCRIPTION.items, data: [] } });
			await createStripeClient('sk_test_fixture', absent.fetchFn).setSubscriptionItem(
				input(0)
			);
			expect(writes(absent.seen)).toEqual([]);
		});
	});

	it('trips each seam error once', async () => {
		const none = recordingFetch({ 'GET /v1/prices': { ...PRICE_LIST, data: [] } });
		await expect(
			createStripeClient('sk_test_fixture', none.fetchFn).createCheckoutSession(INPUT)
		).rejects.toBeInstanceOf(StripeSeamError);
		const bare = recordingFetch({
			'GET /v1/prices': PRICE_LIST,
			'POST /v1/checkout/sessions': { ...SESSION, url: null }
		});
		await expect(
			createStripeClient('sk_test_fixture', bare.fetchFn).createCheckoutSession(INPUT)
		).rejects.toBeInstanceOf(StripeSeamError);
	});

	it('opens a portal session for the customer', async () => {
		const { seen, fetchFn } = recordingFetch({
			'POST /v1/billing_portal/sessions': {
				id: 'bps_1',
				object: 'billing_portal.session',
				url: 'https://billing.example.test/p/session'
			}
		});
		const result = await createStripeClient('sk_test_fixture', fetchFn).createPortalSession({
			customerId: 'cus_1',
			returnUrl: 'https://app.example.test/billing'
		});
		expect(result.url).toBe('https://billing.example.test/p/session');
		expect(seen[0]?.body.get('customer')).toBe('cus_1');
		expect(seen[0]?.body.get('return_url')).toBe('https://app.example.test/billing');
	});

	it('reads the customer off a charge, whether it is an id, an object or absent', async () => {
		const charge = (customer: unknown) =>
			recordingFetch({ 'GET /v1/charges/ch_1': { id: 'ch_1', object: 'charge', customer } });
		const read = (customer: unknown) =>
			createStripeClient('sk_test_fixture', charge(customer).fetchFn).chargeCustomer('ch_1');
		expect(await read('cus_1')).toBe('cus_1');
		expect(await read({ id: 'cus_2', object: 'customer' })).toBe('cus_2');
		expect(await read(null)).toBeNull();
	});
});

// #endregion

describe('fakeStripeClient', () => {
	it('records every call and answers from its table', async () => {
		const fake = fakeStripeClient();
		fake.charges.set('ch_1', 'cus_1');
		expect(await fake.createCheckoutSession(INPUT)).toMatchObject({ id: 'cs_test_fake' });
		expect(
			await fake.createPortalSession({ customerId: 'cus_1', returnUrl: 'x' })
		).toHaveProperty('url');
		expect(await fake.chargeCustomer('ch_1')).toBe('cus_1');
		expect(await fake.chargeCustomer('ch_2')).toBeNull();
		await fake.setSubscriptionItem({
			subscriptionId: 'sub_1',
			priceLookupKey: 'k',
			quantity: 0,
			idempotencyKey: 'i'
		});
		expect(fake.calls.map((call) => call.method)).toEqual([
			'createCheckoutSession',
			'createPortalSession',
			'chargeCustomer',
			'chargeCustomer',
			'setSubscriptionItem'
		]);
	});
});
