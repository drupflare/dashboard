import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import {
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
}

function recordingFetch(answers: Record<string, unknown>) {
	const seen: Seen[] = [];
	const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		seen.push({
			method: request.method,
			url,
			body: new URLSearchParams(await request.text())
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
	data: [{ id: 'price_fixture', object: 'price', lookup_key: 'drupflare_managed_site_monthly' }]
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
		expect(fake.calls.map((call) => call.method)).toEqual([
			'createCheckoutSession',
			'createPortalSession',
			'chargeCustomer',
			'chargeCustomer'
		]);
	});
});
