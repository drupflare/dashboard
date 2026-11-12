import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { DOMWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import Plan from '~/components/billing/Plan.vue';
import Plans from '~/components/billing/Plans.vue';
import Status from '~/components/billing/Status.vue';
import type { BillingPlan, PlanEntitlement } from '~/stores/billing';

const base: BillingPlan = {
	id: 'managed-site',
	name: 'Managed Site',
	kind: 'managed',
	lookupKey: 'drupflare_managed_site',
	sites: 1,
	views: 500000,
	support: 'Core',
	disabled: false
};

const button = (wrapper: { findAll: (selector: string) => DOMWrapper<Element>[] }, text: string) =>
	wrapper.findAll('button').find((item) => item.text().includes(text));

describe('billing plan card', () => {
	it('shows no number and the not-published line when the response has no price', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: { plan: base, canSubscribe: true, busy: null }
		});
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});

	it('shows only the monthly and annual values the API returns', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: { plan: { ...base, monthly: 18, annual: 180 }, canSubscribe: true, busy: null }
		});
		expect(wrapper.text()).toContain('$18 a month');
		expect(wrapper.text()).toContain('$180 a year');
		expect(wrapper.text()).not.toContain('Pricing is not published yet.');
	});

	it('shows a null price as absent without a number', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, monthly: null, annual: null },
				canSubscribe: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
	});

	it('shows an admin unreviewed price with the Unreviewed tag', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, monthly: 59, unreviewed: true },
				canSubscribe: false,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Unreviewed');
		expect(wrapper.text()).toContain('$59 a month');
	});

	it('shows no Unreviewed tag for a reviewed price', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, monthly: 18, unreviewed: false },
				canSubscribe: true,
				busy: null
			}
		});
		expect(wrapper.text()).not.toContain('Unreviewed');
	});

	it('emits the interval the button names', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: { plan: { ...base, monthly: 18, annual: 180 }, canSubscribe: true, busy: null }
		});
		await button(wrapper, 'Subscribe Annually')!.trigger('click');
		expect(wrapper.emitted('subscribe')).toEqual([['year']]);
	});

	it('disables every subscribe button while another request is in flight', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, monthly: 18, annual: 180 },
				canSubscribe: true,
				busy: 'other:month'
			}
		});
		expect(button(wrapper, 'Subscribe Monthly')?.attributes('disabled')).toBeDefined();
		expect(button(wrapper, 'Subscribe Annually')?.attributes('disabled')).toBeDefined();
	});

	it('offers no subscribe button for a plan that is not sold online', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, kind: 'institution', monthly: 1249, annual: 14988 },
				canSubscribe: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('This plan is not sold online.');
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});

	it('greys a disabled plan and offers no subscribe button', async () => {
		const wrapper = await mountSuspended(Plan, {
			props: {
				plan: { ...base, disabled: true, monthly: 18, annual: 180 },
				canSubscribe: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Coming Soon');
		expect(wrapper.text()).toContain('This plan is coming soon.');
		expect(wrapper.find('article').classes()).toContain('opacity-60');
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});
});

describe('billing plan list', () => {
	it('says no plans are published when the list is empty', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { plans: [], canBuy: true, subscribed: false, portal: false, busy: null }
		});
		expect(wrapper.text()).toContain('No Plans Yet');
	});

	it('hides subscribe buttons and explains the change path once the org has a subscription', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: {
				plans: [{ ...base, monthly: 18, annual: 180 }],
				canBuy: true,
				subscribed: true,
				portal: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Use Manage Billing to change it.');
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});

	it('says a plan with no billing account changes outside the dashboard, and offers no purchase', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: {
				plans: [{ ...base, monthly: 18, annual: 180 }],
				canBuy: true,
				subscribed: true,
				portal: false,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('not billed through the dashboard');
		expect(wrapper.text()).not.toContain('Manage Billing');
		expect(button(wrapper, 'Subscribe Monthly')).toBeUndefined();
	});

	it('passes the chosen plan id and interval up to the page', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: {
				plans: [{ ...base, monthly: 18, annual: 180 }],
				canBuy: true,
				subscribed: false,
				portal: false,
				busy: null
			}
		});
		await button(wrapper, 'Subscribe Monthly')!.trigger('click');
		expect(wrapper.emitted('subscribe')).toEqual([['managed-site', 'month']]);
	});
});

describe('billing status', () => {
	const entitlement: PlanEntitlement = {
		planId: 'managed-site',
		addOns: [],
		sites: 1,
		views: null,
		billingAccount: true
	};

	it('offers Manage Billing only when subscribed and the viewer may open the portal', async () => {
		const wrapper = await mountSuspended(Status, {
			props: {
				planName: 'Managed Site',
				entitlement,
				addOnNames: [],
				subscribed: true,
				canPortal: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Managed Site');
		await button(wrapper, 'Manage Billing')!.trigger('click');
		expect(wrapper.emitted('manage')).toHaveLength(1);
	});

	it('shows a read-only view with no action for a viewer who may not change billing', async () => {
		const wrapper = await mountSuspended(Status, {
			props: {
				planName: 'Managed Site',
				entitlement,
				addOnNames: [],
				subscribed: true,
				canPortal: false,
				busy: null
			}
		});
		expect(wrapper.text()).toContain(
			'Only organization owners and billing members can change billing.'
		);
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
	});

	it('shows a null limit as not stated and lists add-on names', async () => {
		const wrapper = await mountSuspended(Status, {
			props: {
				planName: 'Managed Site',
				entitlement: { ...entitlement, addOns: ['assurance'] },
				addOnNames: ['Assurance (add-on to Standard)'],
				subscribed: false,
				canPortal: true,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Not Stated');
		expect(wrapper.text()).toContain('Assurance (add-on to Standard)');
		expect(button(wrapper, 'Manage Billing')).toBeUndefined();
	});

	it('names the plan as not listed when the catalogue lacks its id', async () => {
		const wrapper = await mountSuspended(Status, {
			props: {
				planName: null,
				entitlement,
				addOnNames: [],
				subscribed: false,
				canPortal: false,
				busy: null
			}
		});
		expect(wrapper.text()).toContain('Plan Not Listed');
	});
});
