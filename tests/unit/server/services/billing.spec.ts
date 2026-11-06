import { afterEach, describe, expect, it } from 'vitest';
import {
	billingFlags,
	billingServices,
	desiredFor,
	entitlementFor,
	entitlementOf,
	handleEvent,
	isBillingAdmin,
	listPlans,
	processWebhook,
	setBillingServices,
	startCheckout,
	startPortal,
	type BillingServices
} from '../../../../src/server/services/billing';
import { ApiError } from '../../../../src/shared/errors';
import { facts, fresh, member } from '../../domain/fixtures';
import { NOW, checkoutCompleted, event, rig, signed, subscription } from './billing-support';

const USER = { kind: 'user', userId: 'user-1' } as const;
const KEY = { kind: 'key', keyId: 'key-1', issuerId: 'user-1' } as const;

afterEach(() => setBillingServices(null));

const handle = (s: BillingServices, type: string, object: unknown, over = {}) =>
	handleEvent(s, event(type, object, over) as never);

const thrown = async (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(error: unknown) => error
	);

async function expectApiError(promise: Promise<unknown>, code: string, details?: object) {
	const error = await thrown(promise);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).code).toBe(code);
	if (details) expect((error as ApiError).details).toMatchObject(details);
}

describe('processWebhook', () => {
	it('refuses a bad or stale signature before any handler or store runs', async () => {
		const r = rig();
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const good = await signed(body);
		const wrong = await signed(body, NOW, 'whsec_other');
		const stale = await signed(body, NOW - 301_000);
		for (const [raw, header] of [
			[good.raw, wrong.header],
			[stale.raw, stale.header],
			[good.raw, null],
			['{not json', good.header]
		] as const) {
			await expectApiError(processWebhook(r.services, raw, header), 'validation');
		}
		expect(r.store.accounts.size).toBe(0);
		expect(r.store.events.size).toBe(0);
		expect(r.audits).toEqual([]);
	});

	it('answers not_built without a webhook secret', async () => {
		const r = rig({ webhookSecret: null });
		const { raw, header } = await signed(event('invoice.paid', {}));
		await expectApiError(processWebhook(r.services, raw, header), 'not_built');
	});

	it('handles a verified event, writes its id after the handler, and treats a replay as a no-op', async () => {
		const r = rig();
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const { raw, header } = await signed(body);
		const first = await processWebhook(r.services, raw, header);
		expect(first).toEqual({ status: 200, body: { received: true, outcome: 'handled' } });
		expect(r.store.events.get(body.id)).toBe('customer.subscription.created');
		const revision = r.store.accounts.get('org-1')?.revision;
		const replay = await processWebhook(r.services, raw, header);
		expect(replay).toEqual({ status: 200, body: { received: true, duplicate: true } });
		expect(r.store.accounts.get('org-1')?.revision).toBe(revision);
		expect(r.audits).toHaveLength(1);
	});

	it('leaves no idempotency row when the handler fails, and the retry completes', async () => {
		let fail = true;
		const r = rig({
			audit: async () => {
				if (fail) throw new Error('audit store down');
			}
		});
		const body = event(
			'customer.subscription.created',
			subscription({ organizationId: 'org-1' })
		);
		const { raw, header } = await signed(body);
		await expect(processWebhook(r.services, raw, header)).rejects.toThrow('audit store down');
		expect(r.store.events.size).toBe(0);
		fail = false;
		const retry = await processWebhook(r.services, raw, header);
		expect(retry.body).toMatchObject({ outcome: 'handled' });
		expect(r.store.events.has(body.id)).toBe(true);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			planId: 'managed-studio',
			entitlementState: 'activated'
		});
	});

	it('acks and logs an event type it does not handle', async () => {
		const r = rig();
		const body = event('payout.paid', { id: 'po_1' });
		const { raw, header } = await signed(body);
		const result = await processWebhook(r.services, raw, header);
		expect(result.body).toEqual({ received: true, outcome: 'unknown_type' });
		expect(r.logs).toEqual([
			{
				message: 'unknown stripe event type',
				detail: { eventId: body.id, type: 'payout.paid' }
			}
		]);
		expect(r.store.events.has(body.id)).toBe(true);
	});
});

describe('checkout.session.completed', () => {
	it('links the customer to the organisation named by the reference and audits it', async () => {
		const r = rig();
		expect(await handle(r.services, 'checkout.session.completed', checkoutCompleted())).toBe(
			'handled'
		);
		expect(r.store.customers.get('cus_fixture')).toBe('org-1');
		expect(r.store.accounts.get('org-1')).toMatchObject({
			stripeCustomerId: 'cus_fixture',
			subscriptionId: 'sub_fixture',
			planId: 'managed-free'
		});
		expect(r.audits[0]).toMatchObject({
			orgId: 'org-1',
			input: {
				action: 'billing.customer.linked',
				actor: expect.stringMatching(/^stripe:evt_/)
			}
		});
	});

	it('refuses a customer that already belongs to another organisation', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await expect(
			handle(r.services, 'checkout.session.completed', checkoutCompleted({ org: 'org-2' }))
		).rejects.toThrow(/already linked/);
	});

	it('ignores a session with no organisation or no customer', async () => {
		const r = rig();
		expect(
			await handle(r.services, 'checkout.session.completed', checkoutCompleted({ org: null }))
		).toBe('ignored');
		expect(
			await handle(r.services, 'checkout.session.completed', {
				...checkoutCompleted(),
				customer: null
			})
		).toBe('ignored');
		expect(r.store.accounts.size).toBe(0);
	});

	it('falls back to the metadata organisation', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', {
			...checkoutCompleted({ org: null }),
			metadata: { organization_id: 'org-9' }
		});
		expect(r.store.customers.get('cus_fixture')).toBe('org-9');
	});
});

describe('customer.subscription events', () => {
	const linked = async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		return r;
	};

	it('activates the plan a running subscription names', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		const account = r.store.accounts.get('org-1');
		expect(account).toMatchObject({
			planId: 'managed-studio',
			status: 'active',
			entitlementState: 'activated',
			subscriptionId: 'sub_fixture'
		});
		expect(entitlementOf(account ?? null).planId).toBe('managed-studio');
		expect(r.audits.at(-1)?.input.action).toBe('billing.entitlement.activated');
	});

	it('moves to a new plan on an update and bumps the revision', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		const before = r.store.accounts.get('org-1')?.revision as number;
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-agency'], interval: 'year' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({ planId: 'managed-agency' });
		expect(r.store.accounts.get('org-1')?.revision).toBe(before + 1);
	});

	it('keeps the plan while a payment is past due and trialing counts as running', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ status: 'trialing' })
		);
		expect(r.store.accounts.get('org-1')?.entitlementState).toBe('activated');
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ status: 'past_due' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'past_due',
			planId: 'managed-studio',
			entitlementState: 'activated'
		});
	});

	it.each(['canceled', 'unpaid', 'incomplete_expired'])(
		'revokes to the free plan when the status is %s',
		async (status) => {
			const r = await linked();
			await handle(r.services, 'customer.subscription.created', subscription());
			await handle(r.services, 'customer.subscription.updated', subscription({ status }));
			expect(r.store.accounts.get('org-1')).toMatchObject({
				planId: 'managed-free',
				entitlementState: 'revoked',
				status
			});
			expect(entitlementOf(r.store.accounts.get('org-1') ?? null).planId).toBe(
				'managed-free'
			);
		}
	);

	it('revokes when the subscription is deleted', async () => {
		const r = await linked();
		await handle(r.services, 'customer.subscription.created', subscription());
		await handle(
			r.services,
			'customer.subscription.deleted',
			subscription({ status: 'canceled' })
		);
		expect(r.store.accounts.get('org-1')?.entitlementState).toBe('revoked');
		expect(r.audits.at(-1)?.input.action).toBe('billing.entitlement.revoked');
	});

	it('stores the status of an incomplete or paused subscription and keeps the plan and state', async () => {
		const r = await linked();
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ status: 'incomplete' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'incomplete',
			planId: 'managed-free',
			entitlementState: 'pending'
		});
		await handle(r.services, 'customer.subscription.updated', subscription());
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ status: 'paused' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'paused',
			planId: 'managed-studio',
			entitlementState: 'activated'
		});
	});

	it('blocks an entitlement with single sign-on until sso.built is true', async () => {
		const r = await linked();
		const sub = subscription({ plans: ['institution-standard'], interval: 'year' });
		await handle(r.services, 'customer.subscription.created', sub);
		const blocked = r.store.accounts.get('org-1');
		expect(blocked).toMatchObject({
			planId: 'institution-standard',
			entitlementState: 'blocked'
		});
		expect(entitlementOf(blocked ?? null).planId).toBe('managed-free');
		const on = rig({ flags: { ssoBuilt: true, overageEnabled: false } });
		await handle(on.services, 'checkout.session.completed', checkoutCompleted());
		await handle(on.services, 'customer.subscription.created', sub);
		expect(on.store.accounts.get('org-1')?.entitlementState).toBe('activated');
	});

	it('takes the assurance add-on on the standard plan only', async () => {
		const r = rig({ flags: { ssoBuilt: true, overageEnabled: false } });
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ plans: ['institution-standard', 'assurance'], interval: 'year' })
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({ addOnIds: ['assurance'] });
		expect(entitlementOf(r.store.accounts.get('org-1') ?? null).assurance).toBe(true);
		await expect(
			handle(
				r.services,
				'customer.subscription.updated',
				subscription({ plans: ['managed-studio', 'assurance'] })
			)
		).rejects.toThrow(/add_on_needs_standard/);
	});

	it('ignores a subscription for a customer it cannot place, and links one that carries the organisation', async () => {
		const r = rig();
		expect(await handle(r.services, 'customer.subscription.created', subscription())).toBe(
			'ignored'
		);
		expect(r.logs[0]?.message).toBe('subscription for an unlinked customer');
		expect(r.store.accounts.size).toBe(0);
		await handle(
			r.services,
			'customer.subscription.created',
			subscription({ organizationId: 'org-5' })
		);
		expect(r.store.customers.get('cus_fixture')).toBe('org-5');
		expect(r.store.accounts.get('org-5')?.planId).toBe('managed-studio');
	});

	it('fails loudly on a price or plan it does not know, so the event stays open', async () => {
		const r = await linked();
		const unknown = subscription();
		unknown.items.data[0]!.price.lookup_key = 'someone_elses_price';
		await expect(handle(r.services, 'customer.subscription.created', unknown)).rejects.toThrow(
			/does not know/
		);
		const noKey = subscription();
		noKey.items.data[0]!.price.lookup_key = null as never;
		await expect(handle(r.services, 'customer.subscription.created', noKey)).rejects.toThrow(
			/does not know/
		);
		await expect(
			handle(
				r.services,
				'customer.subscription.created',
				subscription({ plans: ['managed-site', 'managed-studio'] })
			)
		).rejects.toThrow(/exactly one base plan/);
		await expect(
			handle(
				r.services,
				'customer.subscription.created',
				subscription({ plans: ['gmux-compute'] })
			)
		).rejects.toThrow(/plan_disabled/);
		await expect(
			handle(r.services, 'customer.subscription.created', { id: 'sub_x' })
		).rejects.toThrow();
		expect(r.store.accounts.get('org-1')?.planId).toBe('managed-free');
	});

	it('drops an event older than the last one applied', async () => {
		const r = await linked();
		const t = Math.floor(NOW / 1000);
		await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-agency'] }),
			{ created: t + 10 }
		);
		const outcome = await handle(
			r.services,
			'customer.subscription.updated',
			subscription({ plans: ['managed-site'] }),
			{ created: t + 5 }
		);
		expect(outcome).toBe('ignored');
		expect(r.store.accounts.get('org-1')?.planId).toBe('managed-agency');
		expect(r.logs.at(-1)?.message).toBe('stale subscription event');
	});
});

describe('invoice, charge and customer events', () => {
	const running = async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		return r;
	};
	const later = (s: number) => ({ created: Math.floor(NOW / 1000) + s });

	it('marks a failed payment past due, audits it, and clears it when the invoice is paid', async () => {
		const r = await running();
		await handle(
			r.services,
			'invoice.payment_failed',
			{ id: 'in_1', customer: 'cus_fixture' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			status: 'past_due',
			lastInvoiceId: 'in_1',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input.action).toBe('billing.payment.failed');
		await handle(r.services, 'invoice.paid', { id: 'in_1', customer: 'cus_fixture' }, later(2));
		expect(r.store.accounts.get('org-1')?.status).toBe('active');
	});

	it('records the finalized invoice without touching the status', async () => {
		const r = await running();
		await handle(
			r.services,
			'invoice.finalized',
			{ id: 'in_2', customer: 'cus_fixture' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			lastInvoiceId: 'in_2',
			status: 'active'
		});
	});

	it('ignores an invoice with no customer, an unknown customer, or an older timestamp', async () => {
		const r = await running();
		expect(await handle(r.services, 'invoice.paid', { id: 'in_3', customer: null })).toBe(
			'ignored'
		);
		expect(
			await handle(r.services, 'invoice.paid', { id: 'in_3', customer: 'cus_nobody' })
		).toBe('ignored');
		await handle(r.services, 'customer.subscription.updated', subscription(), later(20));
		expect(
			await handle(
				r.services,
				'invoice.payment_failed',
				{ id: 'in_4', customer: 'cus_fixture' },
				later(5)
			)
		).toBe('ignored');
		expect(r.store.accounts.get('org-1')?.status).toBe('active');
	});

	it('flags a refund for review and leaves the entitlement alone', async () => {
		const r = await running();
		await handle(
			r.services,
			'charge.refunded',
			{ id: 'ch_1', customer: 'cus_fixture', refunded: true },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			reviewReason: 'refunded',
			planId: 'managed-studio',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input.action).toBe('billing.refunded');
		expect(await handle(r.services, 'charge.refunded', { id: 'ch_2', customer: null })).toBe(
			'ignored'
		);
	});

	it('finds the customer of a dispute through the charge and flags the account', async () => {
		const r = await running();
		r.stripe.charges.set('ch_9', 'cus_fixture');
		await handle(
			r.services,
			'charge.dispute.created',
			{ id: 'dp_1', charge: 'ch_9' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')).toMatchObject({
			reviewReason: 'disputed',
			entitlementState: 'activated'
		});
		expect(r.audits.at(-1)?.input).toMatchObject({
			action: 'billing.disputed',
			detail: { disputeId: 'dp_1', chargeId: 'ch_9' }
		});
		expect(
			await handle(r.services, 'charge.dispute.created', { id: 'dp_2', charge: 'ch_none' })
		).toBe('ignored');
		const bare = rig({ stripe: null });
		expect(
			await handle(bare.services, 'charge.dispute.created', { id: 'dp_3', charge: 'ch_9' })
		).toBe('ignored');
	});

	it('copies the billing email from a customer update and ignores one without it', async () => {
		const r = await running();
		await handle(
			r.services,
			'customer.updated',
			{ id: 'cus_fixture', email: 'billing@example.test' },
			later(1)
		);
		expect(r.store.accounts.get('org-1')?.billingEmail).toBe('billing@example.test');
		expect(
			await handle(r.services, 'customer.updated', { id: 'cus_fixture', email: null })
		).toBe('ignored');
		expect(
			await handle(r.services, 'customer.updated', {
				id: 'cus_nobody',
				email: 'x@example.test'
			})
		).toBe('ignored');
		expect(
			await handle(r.services, 'customer.updated', {
				id: 'cus_fixture',
				email: 'old@example.test'
			})
		).toBe('ignored');
	});
});

describe('checkout and portal', () => {
	const request = {
		orgId: 'org-1',
		planId: 'managed-site',
		interval: 'month',
		admin: true,
		principal: USER,
		idempotencyKey: 'idem-1'
	} as const;

	it('refuses an API key', async () => {
		const r = rig();
		await expectApiError(
			startCheckout(r.services, { ...request, principal: KEY }),
			'forbidden',
			{
				requires: 'session'
			}
		);
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: KEY }),
			'forbidden',
			{
				requires: 'session'
			}
		);
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: null }),
			'forbidden'
		);
		expect(r.stripe.calls).toEqual([]);
	});

	it('answers not_built without a Stripe client', async () => {
		const r = rig({ stripe: null });
		await expectApiError(startCheckout(r.services, request), 'not_built');
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: USER }),
			'not_built'
		);
	});

	it('hides an unreviewed price from a non-admin and never reaches Stripe', async () => {
		const r = rig();
		await expectApiError(startCheckout(r.services, { ...request, admin: false }), 'not_found');
		expect(r.stripe.calls).toEqual([]);
	});

	it('opens a checkout for an admin with the price key, the organisation and the idempotency key', async () => {
		const r = rig();
		expect(await startCheckout(r.services, request)).toEqual({
			url: 'https://checkout.example.test/cs_test_fake'
		});
		expect(r.stripe.calls).toEqual([
			{
				method: 'createCheckoutSession',
				input: {
					organizationId: 'org-1',
					priceLookupKey: 'drupflare_managed_site_monthly',
					planLookupKey: 'drupflare_managed_site',
					customerId: null,
					successUrl: 'https://app.example.test/billing?checkout=success',
					cancelUrl: 'https://app.example.test/billing?checkout=cancelled',
					idempotencyKey: 'idem-1'
				}
			}
		]);
	});

	it('refuses plans that cannot be bought online and plans that do not exist', async () => {
		const r = rig();
		await expectApiError(
			startCheckout(r.services, { ...request, planId: 'nope' }),
			'not_found'
		);
		await expectApiError(
			startCheckout(r.services, { ...request, planId: 'gmux-compute' }),
			'not_found'
		);
		for (const planId of [
			'institution-standard',
			'enterprise',
			'managed-free',
			'self-managed-dashboard'
		]) {
			await expectApiError(
				startCheckout(r.services, { ...request, planId }),
				'unprocessable',
				{
					reason: 'not_self_serve'
				}
			);
		}
		await expectApiError(
			startCheckout(r.services, {
				...request,
				planId: 'institution-starter',
				interval: 'month'
			}),
			'unprocessable'
		);
	});

	it('refuses a second subscription and reuses a known customer', async () => {
		const r = rig();
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await startCheckout(r.services, request);
		expect(r.stripe.calls[0]).toMatchObject({ input: { customerId: 'cus_fixture' } });
		await handle(r.services, 'customer.subscription.created', subscription());
		await expectApiError(startCheckout(r.services, request), 'conflict', {
			reason: 'already_subscribed'
		});
	});

	it('opens the portal for a known customer and answers not_found for an organisation without one', async () => {
		const r = rig();
		await expectApiError(
			startPortal(r.services, { orgId: 'org-1', principal: USER }),
			'not_found',
			{
				reason: 'no_billing_account'
			}
		);
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		expect(await startPortal(r.services, { orgId: 'org-1', principal: USER })).toEqual({
			url: 'https://billing.example.test/session/fake'
		});
		expect(r.stripe.calls.at(-1)).toEqual({
			method: 'createPortalSession',
			input: { customerId: 'cus_fixture', returnUrl: 'https://app.example.test/billing' }
		});
	});
});

describe('plan list and admin check', () => {
	it('lists every plan with no price key for a non-admin', () => {
		const items = listPlans(false);
		expect(items.length).toBeGreaterThan(10);
		expect(JSON.stringify(items)).not.toMatch(/"(monthly|annual)"/);
	});

	it('gives an admin the prices', () => {
		const site = listPlans(true).find((p) => p.id === 'managed-site');
		expect(site).toMatchObject({ monthly: 18, annual: 180, unreviewed: true });
	});

	it('treats only a platform admin with Access and billing support as an admin', () => {
		const base = facts({ ...member('owner'), ...fresh });
		expect(isBillingAdmin(null)).toBe(false);
		expect(isBillingAdmin(base)).toBe(false);
		const platform = (over: object) => ({
			...base,
			platform: {
				admin: true,
				access: true,
				permissions: ['billing_support'] as const,
				...over
			}
		});
		expect(isBillingAdmin(platform({}) as never)).toBe(true);
		expect(isBillingAdmin(platform({ admin: false }) as never)).toBe(false);
		expect(isBillingAdmin(platform({ access: false }) as never)).toBe(false);
		expect(isBillingAdmin(platform({ permissions: ['read'] }) as never)).toBe(false);
	});
});

describe('services and desired state', () => {
	it('answers not_built until services are installed', async () => {
		expect(() => billingServices()).toThrow(ApiError);
		const r = rig();
		setBillingServices(r.services);
		expect(billingServices()).toBe(r.services);
	});

	it('reads both flags as off unless they say true', () => {
		expect(billingFlags({})).toEqual({ ssoBuilt: false, overageEnabled: false });
		expect(billingFlags({ SSO_BUILT: 'yes', BILLING_OVERAGE_ENABLED: '1' })).toEqual({
			ssoBuilt: false,
			overageEnabled: false
		});
		expect(billingFlags({ SSO_BUILT: 'true', BILLING_OVERAGE_ENABLED: 'true' })).toEqual({
			ssoBuilt: true,
			overageEnabled: true
		});
	});

	it('reads an organisation with no billing row as free and builds the desired state from the row', async () => {
		const r = rig();
		expect((await entitlementFor(r.services, 'org-x')).planId).toBe('managed-free');
		await handle(r.services, 'checkout.session.completed', checkoutCompleted());
		await handle(r.services, 'customer.subscription.created', subscription());
		const desired = await desiredFor(r.services, 'org-1', [{ siteId: 's1', createdAt: 1 }]);
		expect(desired).toMatchObject({ orgId: 'org-1', revision: 1, overage: null });
		expect(desired.entitlement?.planId).toBe('managed-studio');
	});

	it('refuses to read a row that holds a plan it cannot derive', () => {
		expect(() =>
			entitlementOf({
				planId: 'gmux-compute',
				entitlementState: 'activated',
				addOnIds: []
			} as never)
		).toThrow(/unusable plan/);
	});
});
