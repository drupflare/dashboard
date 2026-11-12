import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import BillingPage from '~/pages/org/billing.vue';
import { useBillingStore } from '~/stores/billing';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

// the real step-up form needs Turnstile and an email code; the page only has to hand over and take back control
mockComponent('AccountStepUp', {
	emits: ['done', 'cancel'],
	setup(_props: unknown, { emit }: { emit: (event: 'done' | 'cancel') => void }) {
		return () =>
			h(
				'button',
				{ type: 'button', 'data-step-up-done': '', onClick: () => emit('done') },
				'Finish Step Up'
			);
	}
});

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_personal';
const owner = { id: ORG, name: 'Personal', personal: true, role: 'owner' };
const viewer = { id: ORG, name: 'Personal', personal: true, role: 'viewer' };
const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

const priced = {
	id: 'managed-site',
	name: 'Managed Site',
	kind: 'managed',
	lookupKey: 'drupflare_managed_site',
	sites: 1,
	views: 500000,
	support: 'Core',
	disabled: false,
	monthly: 18,
	annual: 180
};
const unpriced = {
	...priced,
	id: 'managed-studio',
	name: 'Managed Studio',
	monthly: undefined,
	annual: undefined
};
const freePlan = {
	planId: 'managed-free',
	addOns: [],
	sites: 3,
	views: 100000,
	billingAccount: false
};
const paidPlan = {
	planId: 'managed-site',
	addOns: [],
	sites: 1,
	views: 500000,
	billingAccount: true
};
const contractPlan = { ...paidPlan, billingAccount: false };

const plansKey = 'GET /api/v1/billing/plans';
const entitlementKey = `GET /api/v1/orgs/${ORG}/entitlement`;
const checkoutKey = `POST /api/v1/billing/${ORG}/checkout`;
const portalKey = `POST /api/v1/billing/${ORG}/portal`;
const envelope = (status: number, code: string, message: string, details: unknown = {}) => ({
	status,
	body: { code, message, details, requestId: 'req_p1' }
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

function setup(options: {
	role?: typeof owner;
	entitlement?: Reply;
	plans?: unknown[];
	checkout?: Reply | (() => Reply);
	portal?: Reply;
}) {
	const routes: Record<string, unknown> = {
		'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
		'GET /api/v1/me/organizations': {
			body: { items: [options.role ?? owner], nextCursor: null }
		},
		[plansKey]: { body: { items: options.plans ?? [priced, unpriced] } },
		[entitlementKey]: options.entitlement ?? { body: freePlan }
	};
	if (options.checkout) routes[checkoutKey] = options.checkout;
	if (options.portal) routes[portalKey] = options.portal;
	cleanup = registerApi(routes as Parameters<typeof registerApi>[0]);
}

async function mountPage() {
	const wrapper = await mountSuspended(BillingPage, { route: '/org/billing' });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: Awaited<ReturnType<typeof mountPage>>, text: string) =>
	wrapper.findAll('button').find((item) => item.text().includes(text));

beforeEach(async () => {
	clearBrowserState();
	navigate.mockReset();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useBillingStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('billing page', () => {
	it('shows the plan, the plans and a subscribe button for an owner on the free plan', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Managed Site'));
		expect(wrapper.text()).toContain('$18 a month');
		expect(button(wrapper, 'Subscribe Monthly')).toBeDefined();
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
	});

	it('shows the pricing line and no number for a plan the response priced nowhere', async () => {
		setup({ plans: [unpriced] });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Managed Studio'));
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
	});

	it('shows the Unreviewed tag beside an admin price', async () => {
		setup({ plans: [{ ...priced, unreviewed: true, monthly: 59 }] });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Unreviewed'));
		expect(wrapper.text()).toContain('$59 a month');
	});

	it('gives a viewer the plan and status read-only, with no action buttons', async () => {
		setup({ role: viewer, entitlement: { body: paidPlan } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Current Plan'));
		expect(wrapper.text()).toContain(
			'Only organization owners and billing members can change billing.'
		);
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
	});

	it('sends the chosen plan and interval to checkout and leaves for the hosted page', async () => {
		setup({ checkout: { body: { url: 'https://checkout.example.test/s/1' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Subscribe Monthly')).toBeDefined());
		await button(wrapper, 'Subscribe Monthly')!.trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/s/1', {
				external: true
			})
		);
		const post = calls.find((call) => call.path === `/api/v1/billing/${ORG}/checkout`);
		expect(post?.body).toEqual({ plan: 'managed-site', interval: 'month' });
	});

	it('opens the portal from Manage Billing for a subscribed owner', async () => {
		setup({
			entitlement: { body: paidPlan },
			portal: { body: { url: 'https://portal.example.test/p/1' } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Manage Billing')).toBeDefined());
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
		await button(wrapper, 'Manage Billing')!.trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://portal.example.test/p/1', {
				external: true
			})
		);
	});

	it('offers neither the portal nor a purchase to a paid plan with no billing account', async () => {
		setup({ entitlement: { body: contractPlan } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Current Plan'));
		expect(wrapper.text()).toContain('not billed through the dashboard');
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});

	it('says billing is not set up, without the raw service message', async () => {
		setup({
			checkout: envelope(501, 'not_built', 'Billing is not available yet')
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Subscribe Monthly')).toBeDefined());
		await button(wrapper, 'Subscribe Monthly')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Billing Is Not Set Up Yet'));
		expect(wrapper.text()).toContain('Nothing is wrong with the site.');
		expect(wrapper.text()).not.toContain('Billing is not available yet');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('asks for a fresh sign-in before checkout when the stored one has run out, then runs it', async () => {
		signIn(null);
		setup({ checkout: { body: { url: 'https://checkout.example.test/s/2' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Subscribe Monthly')).toBeDefined());
		await button(wrapper, 'Subscribe Monthly')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[data-step-up-done]').exists()).toBe(true));
		expect(calls.some((call) => call.path === `/api/v1/billing/${ORG}/checkout`)).toBe(false);

		signIn(soon());
		await wrapper.find('[data-step-up-done]').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/s/2', {
				external: true
			})
		);
	});

	it('asks for a fresh sign-in when the server says a stored one is stale, then retries once', async () => {
		let attempts = 0;
		setup({
			checkout: () => {
				attempts += 1;
				return attempts === 1
					? envelope(403, 'forbidden', 'Fresh authentication is required', {
							requires: 'step-up'
						})
					: { body: { url: 'https://checkout.example.test/s/3' } };
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Subscribe Monthly')).toBeDefined());
		await button(wrapper, 'Subscribe Monthly')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[data-step-up-done]').exists()).toBe(true));
		expect(navigate).not.toHaveBeenCalled();

		await wrapper.find('[data-step-up-done]').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/s/3', {
				external: true
			})
		);
		expect(attempts).toBe(2);
	});

	it('shows a failed plan read as an error with a retry, not as an empty plan', async () => {
		setup({
			entitlement: envelope(500, 'internal', 'Something went wrong on our side. Try again.')
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Your Plan'));
		expect(wrapper.text()).toContain('Try Again');
		expect(wrapper.text()).not.toContain('Subscribe Monthly');
	});
});
