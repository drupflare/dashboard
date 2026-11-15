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

const included = {
	storageGb: 10,
	writes: 3000000,
	backupGb: 10,
	mailSends: 2000,
	containerHours: 5,
	invitees: 100,
	customDomains: 10,
	backupDays: 30
};
const priced = {
	id: 'managed-pro',
	name: 'Managed Pro',
	kind: 'managed',
	plane: 'managed',
	lookupKey: 'drupflare_managed_pro',
	sites: 3,
	sitesUnlimited: false,
	views: 1000000,
	support: 'Core',
	supportHoursPerYear: 2,
	included,
	disabled: false,
	monthly: 35,
	annual: 350
};
const unpriced = {
	...priced,
	id: 'managed-agency',
	name: 'Managed Agency',
	monthly: undefined,
	annual: undefined
};
const freeRow = {
	...priced,
	id: 'managed-free',
	name: 'Managed Free',
	support: 'Community',
	supportHoursPerYear: 0,
	monthly: 0,
	annual: 0
};

const extraSite = {
	id: 'extra-site',
	name: 'Extra Site',
	meter: 'sites',
	lookupKey: 'drupflare_addon_extra_site',
	unit: '1 site above the plan',
	grants: 1,
	planes: ['managed'],
	requires: ['managed-pro'],
	subscription: true,
	packSizes: [],
	available: true,
	availableNote: null,
	monthly: 10,
	annual: 100,
	packs: []
};
const supportHours = {
	id: 'support-hours',
	name: 'Support Hours',
	meter: 'support-hours',
	lookupKey: 'drupflare_addon_support_hours',
	unit: '1 hour of support',
	grants: 12,
	planes: ['self-hosted', 'self-managed', 'managed'],
	requires: null,
	subscription: true,
	packSizes: [1, 5],
	available: true,
	availableNote: null,
	monthly: 130,
	annual: 1300,
	packs: [
		{ units: 1, price: 150 },
		{ units: 5, price: 700 }
	]
};

const baseEntitlement = {
	managedPlanId: 'managed-free',
	plane: 'managed',
	addOns: [],
	storageGb: 1,
	writes: 1000000,
	backupGb: 1,
	mailSends: 0,
	containerHours: 0.5,
	invitees: 5,
	supportHoursPerYear: 0,
	support: 'community'
};
const freePlan = {
	...baseEntitlement,
	planId: 'managed-free',
	sites: 3,
	views: 100000,
	billingAccount: false
};
const paidPlan = {
	...baseEntitlement,
	planId: 'managed-pro',
	managedPlanId: 'managed-pro',
	sites: 3,
	views: 1000000,
	support: 'core',
	billingAccount: true
};
const contractPlan = { ...paidPlan, billingAccount: false };

const plansKey = 'GET /api/v1/billing/plans';
const addOnsKey = 'GET /api/v1/billing/add-ons';
const entitlementKey = `GET /api/v1/orgs/${ORG}/entitlement`;
const checkoutKey = `POST /api/v1/billing/${ORG}/checkout`;
const portalKey = `POST /api/v1/billing/${ORG}/portal`;
const addOnPostKey = `POST /api/v1/billing/${ORG}/add-ons`;
const addOnPutKey = `PUT /api/v1/billing/${ORG}/add-ons/extra-site`;
const detailsKey = `PUT /api/v1/billing/${ORG}/details`;
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
	entitlement?: Reply | (() => Reply);
	plans?: unknown[];
	addOns?: Reply | unknown[];
	checkout?: Reply | (() => Reply);
	portal?: Reply;
	addOnPost?: Reply | (() => Reply);
	addOnPut?: Reply;
	details?: Reply | (() => Reply);
}) {
	const routes: Record<string, unknown> = {
		'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
		'GET /api/v1/me/organizations': {
			body: { items: [options.role ?? owner], nextCursor: null }
		},
		[plansKey]: { body: { items: options.plans ?? [priced, unpriced, freeRow] } },
		[addOnsKey]: Array.isArray(options.addOns)
			? { body: { items: options.addOns } }
			: (options.addOns ?? { body: { items: [extraSite, supportHours] } }),
		[entitlementKey]: options.entitlement ?? { body: freePlan }
	};
	if (options.checkout) routes[checkoutKey] = options.checkout;
	if (options.portal) routes[portalKey] = options.portal;
	if (options.addOnPost) routes[addOnPostKey] = options.addOnPost;
	if (options.addOnPut) routes[addOnPutKey] = options.addOnPut;
	if (options.details) routes[detailsKey] = options.details;
	cleanup = registerApi(routes as Parameters<typeof registerApi>[0]);
}

async function mountPage() {
	const wrapper = await mountSuspended(BillingPage, { route: '/org/billing' });
	mounted.push(wrapper);
	return wrapper;
}

type Page = Awaited<ReturnType<typeof mountPage>>;

const button = (wrapper: Page, text: string) =>
	wrapper.findAll('button').find((item) => item.text().includes(text));
const labelled = (wrapper: Page, label: string) => wrapper.find(`button[aria-label="${label}"]`);

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
	it('shows the plan, the add-ons and the plans for an owner on the free plan', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Managed Pro'));
		expect(wrapper.text()).toContain('Your Plan');
		expect(wrapper.text()).toContain('$35 a month');
		expect(wrapper.text()).toContain('Support Hours');
		expect(wrapper.text()).not.toContain('Extra Site');
		expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true);
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
	});

	it('shows the pricing line and no number for a plan the response priced nowhere', async () => {
		setup({ plans: [unpriced], addOns: [] });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Managed Agency'));
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
	});

	it('shows the Unreviewed tag beside an admin price', async () => {
		setup({ plans: [{ ...priced, unreviewed: true, monthly: 59 }] });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Unreviewed Price'));
		expect(wrapper.text()).toContain('$59 a month');
	});

	it('gives a viewer the plan read-only, with no action buttons', async () => {
		setup({ role: viewer, entitlement: { body: paidPlan } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your Plan'));
		expect(wrapper.text()).toContain(
			'Only organization owners and billing members can change billing.'
		);
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
		expect(button(wrapper, 'Add')).toBeUndefined();
		expect(button(wrapper, 'Buy Pack')).toBeUndefined();
	});

	it('sends the chosen plan and interval to checkout and leaves for the hosted page', async () => {
		setup({ checkout: { body: { url: 'https://checkout.example.test/s/1' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true)
		);
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/s/1', {
				external: true
			})
		);
		const post = calls.find((call) => call.path === `/api/v1/billing/${ORG}/checkout`);
		expect(post?.body).toEqual({ plan: 'managed-pro', interval: 'month' });
	});

	it('checks out for the annual period once Annual is chosen', async () => {
		setup({ checkout: { body: { url: 'https://checkout.example.test/s/y' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Annual')).toBeDefined());
		await button(wrapper, 'Annual')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('$350 a year'));
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
		const post = calls.find((call) => call.path === `/api/v1/billing/${ORG}/checkout`);
		expect(post?.body).toEqual({ plan: 'managed-pro', interval: 'year' });
	});

	it('opens the portal from Manage Billing for a subscribed owner', async () => {
		setup({
			entitlement: { body: paidPlan },
			portal: { body: { url: 'https://portal.example.test/p/1' } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Manage Billing')).toBeDefined());
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
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
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your Plan'));
		expect(wrapper.text()).toContain('not billed through the dashboard');
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('says billing is not set up, without the raw service message', async () => {
		setup({ checkout: envelope(501, 'not_built', 'Billing is not available yet') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true)
		);
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
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
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true)
		);
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
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
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true)
		);
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
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
		expect(wrapper.text()).not.toContain('Subscribe');
	});

	it('shows a failed add-on read as an error with a retry', async () => {
		setup({
			addOns: envelope(500, 'internal', 'Something went wrong on our side. Try again.')
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Add-Ons'));
		expect(wrapper.text()).toContain('Try Again');
	});
});

describe('billing page add-ons', () => {
	it('subscribes to an add-on with a running subscription and waits for the confirmation', async () => {
		setup({
			entitlement: { body: paidPlan },
			addOnPost: { body: { applied: true } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Extra Site').exists()).toBe(true));
		await labelled(wrapper, 'Add Extra Site').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your change was sent.'));
		const post = calls.find((call) => call.path === `/api/v1/billing/${ORG}/add-ons`);
		expect(post?.body).toEqual({
			mode: 'subscription',
			addOn: 'extra-site',
			quantity: 1,
			interval: 'month'
		});
		expect(navigate).not.toHaveBeenCalled();
	});

	it('leaves for the hosted checkout when the add-on needs a new subscription', async () => {
		setup({ addOnPost: { body: { url: 'https://checkout.example.test/a/1' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Support Hours').exists()).toBe(true));
		await labelled(wrapper, 'Add Support Hours').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/a/1', {
				external: true
			})
		);
	});

	it('buys a one-time pack', async () => {
		setup({ addOnPost: { body: { url: 'https://checkout.example.test/a/2' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Buy a Pack of Support Hours').exists()).toBe(true)
		);
		await labelled(wrapper, 'Buy a Pack of Support Hours').trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
		const post = calls.find((call) => call.path === `/api/v1/billing/${ORG}/add-ons`);
		expect(post?.body).toEqual({ mode: 'pack', addOn: 'support-hours', units: 1 });
	});

	it('removes a held add-on through the quantity route', async () => {
		setup({
			entitlement: {
				body: { ...paidPlan, addOns: [{ id: 'extra-site', quantity: 1 }], sites: 4 }
			},
			addOnPut: { body: { applied: true } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('You Have 1'));
		await wrapper.find('input').setValue('0');
		await wrapper.find('input').trigger('blur');
		await vi.waitFor(() => expect(labelled(wrapper, 'Remove Extra Site').exists()).toBe(true));
		await labelled(wrapper, 'Remove Extra Site').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your change was sent.'));
		const put = calls.find((call) => call.method === 'PUT');
		expect(put?.path).toBe(`/api/v1/billing/${ORG}/add-ons/extra-site`);
		expect(put?.body).toEqual({ quantity: 0 });
	});

	it('reads the plan again when Check Again is pressed', async () => {
		let reads = 0;
		setup({
			entitlement: () => {
				reads += 1;
				return { body: reads === 1 ? paidPlan : { ...paidPlan, sites: 4 } };
			},
			addOnPost: { body: { applied: true } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Extra Site').exists()).toBe(true));
		await labelled(wrapper, 'Add Extra Site').trigger('click');
		await vi.waitFor(() => expect(button(wrapper, 'Check Again')).toBeDefined());
		await button(wrapper, 'Check Again')!.trigger('click');
		await vi.waitFor(() => expect(button(wrapper, 'Check Again')).toBeUndefined());
		expect(reads).toBe(2);
		expect(useBillingStore().entitlements.get(ORG)).toMatchObject({ sites: 4 });
	});

	it('shows a refused add-on as a billing error with the request id', async () => {
		setup({
			entitlement: { body: paidPlan },
			addOnPost: envelope(422, 'unprocessable', 'That add-on is not offered on your plan')
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Extra Site').exists()).toBe(true));
		await labelled(wrapper, 'Add Extra Site').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Billing Request Failed'));
		expect(wrapper.text()).toContain('That add-on is not offered on your plan');
		expect(wrapper.text()).toContain('req_p1');
	});

	it('asks for a fresh sign-in before an add-on purchase, then runs it', async () => {
		signIn(null);
		setup({ addOnPost: { body: { url: 'https://checkout.example.test/a/3' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Support Hours').exists()).toBe(true));
		await labelled(wrapper, 'Add Support Hours').trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[data-step-up-done]').exists()).toBe(true));
		expect(calls.some((call) => call.path === `/api/v1/billing/${ORG}/add-ons`)).toBe(false);

		signIn(soon());
		await wrapper.find('[data-step-up-done]').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/a/3', {
				external: true
			})
		);
	});

	it('asks for the billing details, saves them, and runs the purchase again', async () => {
		let saved = false;
		setup({
			addOnPost: () =>
				saved
					? { body: { url: 'https://checkout.example.test/a/4' } }
					: envelope(422, 'unprocessable', 'Add your billing details first', {
							reason: 'billing_details_required',
							missing: ['name', 'email', 'country']
						}),
			details: () => {
				saved = true;
				return { body: { saved: true } };
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(labelled(wrapper, 'Add Support Hours').exists()).toBe(true));
		await labelled(wrapper, 'Add Support Hours').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Add Your Billing Details First'));
		expect(wrapper.text()).not.toContain('Billing Request Failed');
		await wrapper.find('#billing-name').setValue('Ada Owner');
		await wrapper.find('#billing-email').setValue('ada@example.test');
		await wrapper.find('#billing-country').setValue('us');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/a/4', {
				external: true
			})
		);
		expect(calls.find((call) => call.path === `/api/v1/billing/${ORG}/details`)?.body).toEqual({
			name: 'Ada Owner',
			email: 'ada@example.test',
			country: 'US'
		});
	});

	it('shows a plan bought onto the running add-ons subscription as sent', async () => {
		setup({
			checkout: { body: { applied: true } },
			entitlement: {
				body: {
					...freePlan,
					billingAccount: true,
					addOns: [{ id: 'support-hours', quantity: 1 }]
				}
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'Subscribe to Managed Pro').exists()).toBe(true)
		);
		await labelled(wrapper, 'Subscribe to Managed Pro').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your change was sent'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('prices an add-on for the period chosen at the top', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('$130 a month each'));
		await button(wrapper, 'Annual')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('$1,300 a year each'));
	});
});
