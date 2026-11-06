import { afterEach, describe, expect, it } from 'vitest';
import { API_ROOT, scanRoutes } from '../../../../scripts/gen-openapi';
import stripeHook from '../../../../src/server/api/hooks/stripe.post';
import checkout from '../../../../src/server/api/v1/billing/[orgId]/checkout.post';
import portal from '../../../../src/server/api/v1/billing/[orgId]/portal.post';
import plans from '../../../../src/server/api/v1/billing/plans.get';
import type { Facts } from '../../../../src/server/domain/authorize';
import { setBillingServices } from '../../../../src/server/services/billing';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { actionDef } from '../../../../src/shared/permissions';
import { ORG, facts, fresh, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';
import { checkoutCompleted, event, rig, signed, subscription } from '../services/billing-support';

afterEach(() => {
	resetApiDeps();
	setBillingServices(null);
});

const CHECKOUT = '/api/v1/billing/:orgId/checkout';
const PORTAL = '/api/v1/billing/:orgId/portal';
const HOOK = '/api/hooks/stripe';

const asBillingAdmin = (): Facts => ({
	...facts({ ...member('owner'), ...fresh }),
	platform: { admin: true, access: true, permissions: ['billing_support'] }
});

const ownerWithKey =
	(scopes: string[]) =>
	(input: { principal: { kind: string } }): Facts => ({
		...facts({ ...member('owner'), ...fresh }),
		...(input.principal.kind === 'key' ? { key: { id: 'key-1', scopes } } : {})
	});

const post = (
	handler: Parameters<typeof send>[0],
	route: string,
	path: string,
	json: unknown,
	headers = asUser
) => send(handler, route, { method: 'POST', path, json, headers });

describe('GET /api/v1/billing/plans', () => {
	it('lists plans with no price for a member', async () => {
		setup();
		const reply = await send(plans, '/api/v1/billing/plans', {
			path: '/api/v1/billing/plans',
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const items = (reply.json as { items: Record<string, unknown>[] }).items;
		expect(items.map((item) => item.id)).toContain('managed-site');
		expect(reply.text).not.toMatch(/"(monthly|annual)"/);
	});

	it('lists the prices for a platform admin', async () => {
		setup({ facts: asBillingAdmin });
		const reply = await send(plans, '/api/v1/billing/plans', {
			path: '/api/v1/billing/plans',
			headers: asUser
		});
		const site = (reply.json as { items: Record<string, unknown>[] }).items.find(
			(item) => item.id === 'managed-site'
		);
		expect(site).toMatchObject({ monthly: 18, annual: 180, unreviewed: true });
	});

	it('refuses an anonymous caller', async () => {
		setup();
		const reply = await send(plans, '/api/v1/billing/plans', { path: '/api/v1/billing/plans' });
		expect(reply.status).toBe(401);
	});
});

describe('POST /api/v1/billing/:orgId/checkout', () => {
	const body = { plan: 'managed-site', interval: 'month' };

	it('answers 501 not_built when no Stripe client is configured', async () => {
		setup();
		const reply = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, body);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
		const r = rig({ stripe: null });
		setBillingServices(r.services);
		const again = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, body);
		expect(again.status).toBe(501);
	});

	it('refuses an API key even when the key holds the scope', async () => {
		setup({ facts: ownerWithKey(['billing.manage']) as never });
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(
			checkout,
			CHECKOUT,
			`/api/v1/billing/${ORG}/checkout`,
			body,
			asKey as never
		);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'session' } });
		expect(r.stripe.calls).toEqual([]);
	});

	it('hides an unreviewed price from a member', async () => {
		setup();
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, body);
		expect(reply.status).toBe(404);
		expect(r.stripe.calls).toEqual([]);
	});

	it('opens a checkout for a platform admin and passes the Idempotency-Key through', async () => {
		setup({ facts: asBillingAdmin });
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, body, {
			...asUser,
			'idempotency-key': 'idem-key-12345678'
		} as never);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ url: 'https://checkout.example.test/cs_test_fake' });
		expect(r.stripe.calls[0]).toMatchObject({
			input: { organizationId: ORG, idempotencyKey: 'idem-key-12345678' }
		});
	});

	it('refuses a role without billing access and a malformed body', async () => {
		setup({ role: 'developer' });
		setBillingServices(rig().services);
		const denied = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, body);
		expect(denied.status).toBe(403);
		setup({ role: 'billing' });
		const bad = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, {
			plan: 'managed-site',
			interval: 'week'
		});
		expect(bad.status).toBe(400);
	});
});

describe('POST /api/v1/billing/:orgId/portal', () => {
	it('refuses an API key before the handler runs', async () => {
		const harness = setup({ facts: ownerWithKey(['billing.portal']) as never });
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(
			portal,
			PORTAL,
			`/api/v1/billing/${ORG}/portal`,
			undefined,
			asKey as never
		);
		expect(reply.status).toBe(403);
		expect(harness.denials[0]).toMatchObject({
			reason: 'session_only',
			action: 'billing.portal'
		});
		expect(r.stripe.calls).toEqual([]);
	});

	it('answers 501 not_built without a Stripe client and 404 for an organisation with no customer', async () => {
		setup();
		const first = await post(portal, PORTAL, `/api/v1/billing/${ORG}/portal`, undefined);
		expect(first.status).toBe(501);
		setBillingServices(rig().services);
		const none = await post(portal, PORTAL, `/api/v1/billing/${ORG}/portal`, undefined);
		expect(none.status).toBe(404);
		expect(none.json).toMatchObject({ details: { reason: 'no_billing_account' } });
	});

	it('opens the portal for a customer the organisation owns', async () => {
		setup();
		const r = rig();
		setBillingServices(r.services);
		await r.store.ensureAccount(ORG, 1);
		await r.store.linkCustomer('cus_fixture', ORG);
		await r.store.patchAccount(ORG, { stripeCustomerId: 'cus_fixture' }, 1, 1);
		const reply = await post(portal, PORTAL, `/api/v1/billing/${ORG}/portal`, undefined);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ url: 'https://billing.example.test/session/fake' });
	});
});

describe('POST /api/hooks/stripe', () => {
	const hook = (raw: string, header: string | null) =>
		send(stripeHook, HOOK, {
			method: 'POST',
			path: HOOK,
			raw,
			headers: header === null ? {} : { 'stripe-signature': header }
		});

	it('answers 501 until billing services are installed', async () => {
		const { raw, header } = await signed(event('invoice.paid', {}));
		const reply = await hook(raw, header);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});

	it('answers 400 for a missing, wrong or stale signature and changes nothing', async () => {
		const r = rig();
		setBillingServices(r.services);
		const body = event('customer.subscription.created', subscription({ organizationId: ORG }));
		const wrong = await signed(body, undefined, 'whsec_other');
		const stale = await signed(body, 1_800_000_000_000 - 400_000);
		expect((await hook(wrong.raw, null)).status).toBe(400);
		expect((await hook(wrong.raw, wrong.header)).status).toBe(400);
		expect((await hook(stale.raw, stale.header)).status).toBe(400);
		expect(r.store.accounts.size).toBe(0);
		expect(r.store.events.size).toBe(0);
	});

	it('applies a signed event and acknowledges a replay without applying it twice', async () => {
		const r = rig();
		setBillingServices(r.services);
		await r.store.linkCustomer('cus_fixture', ORG);
		const body = event('customer.subscription.created', subscription());
		const { raw, header } = await signed(body);
		const first = await hook(raw, header);
		expect(first.status).toBe(200);
		expect(first.json).toEqual({ received: true, outcome: 'handled' });
		const replay = await hook(raw, header);
		expect(replay.status).toBe(200);
		expect(replay.json).toEqual({ received: true, duplicate: true });
		expect(r.store.accounts.get(ORG)?.revision).toBe(1);
	});

	it('answers 500 when the handler fails and writes no event row, so Stripe retries', async () => {
		const r = rig({
			audit: async () => {
				throw new Error('boom');
			}
		});
		setBillingServices(r.services);
		const { raw, header } = await signed(
			event('checkout.session.completed', checkoutCompleted())
		);
		const reply = await hook(raw, header);
		expect(reply.status).toBe(500);
		expect(reply.json).toMatchObject({ code: 'internal' });
		expect(r.store.events.size).toBe(0);
		expect(reply.text).not.toContain('boom');
	});

	it('rejects a body over the cap', async () => {
		setBillingServices(rig().services);
		const reply = await hook('x'.repeat(1024 * 1024 + 1), 't=1,v1=ab');
		expect(reply.status).toBe(400);
	});
});

describe('organisation from the authorized resource', () => {
	const mismatched = {
		load: async () => ({
			resource: { orgId: 'org-2' },
			facts: {
				...asBillingAdmin(),
				membership: { orgId: 'org-2', role: 'owner' as const }
			}
		})
	};

	it('answers 404 on checkout when the loaded organisation differs from the path', async () => {
		setup({ deps: mismatched });
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(checkout, CHECKOUT, `/api/v1/billing/${ORG}/checkout`, {
			plan: 'managed-site',
			interval: 'month'
		});
		expect(reply.status).toBe(404);
		expect(r.stripe.calls).toEqual([]);
		expect(r.store.accounts.size).toBe(0);
	});

	it('answers 404 on the portal when the loaded organisation differs from the path', async () => {
		setup({ deps: mismatched });
		const r = rig();
		setBillingServices(r.services);
		await r.store.ensureAccount(ORG, 1);
		await r.store.patchAccount(ORG, { stripeCustomerId: 'cus_fixture' }, 1, 1);
		const reply = await post(portal, PORTAL, `/api/v1/billing/${ORG}/portal`, undefined);
		expect(reply.status).toBe(404);
		expect(r.stripe.calls).toEqual([]);
	});

	it('answers 404 when the loader returns no organisation', async () => {
		setup({
			deps: {
				load: async () => ({ resource: {}, facts: facts({ ...member('owner'), ...fresh }) })
			}
		});
		const r = rig();
		setBillingServices(r.services);
		const reply = await post(portal, PORTAL, `/api/v1/billing/${ORG}/portal`, undefined);
		expect([403, 404]).toContain(reply.status);
		expect(r.stripe.calls).toEqual([]);
	});
});

describe('billing actions', () => {
	it('keeps the portal action session-only and billing roles to owner and billing', () => {
		expect(actionDef('billing.portal')).toMatchObject({
			sessionOnly: true,
			org: ['owner', 'billing']
		});
		expect(actionDef('billing.manage')).not.toHaveProperty('sessionOnly');
	});

	it('is found by the route scan under the billing tag with a known action', async () => {
		const { routes, problems } = await scanRoutes(API_ROOT);
		expect(problems).toEqual([]);
		const billing = routes.filter((route) => route.path.startsWith('/api/v1/billing'));
		expect(billing.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
			'get /api/v1/billing/plans',
			'post /api/v1/billing/{orgId}/checkout',
			'post /api/v1/billing/{orgId}/portal'
		]);
	});
});
