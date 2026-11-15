import { mountSuspended } from '@nuxt/test-utils/runtime';
import { flushPromises, type DOMWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AddOns from '~/components/billing/AddOns.vue';
import Current from '~/components/billing/Current.vue';
import Interval from '~/components/billing/Interval.vue';
import Plans from '~/components/billing/Plans.vue';
import type { BillingAddOn, BillingPlan, PlanEntitlement } from '~/stores/billing';

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

const pro: BillingPlan = {
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
	disabled: false
};
const free: BillingPlan = {
	...pro,
	id: 'managed-free',
	name: 'Managed Free',
	support: 'Community',
	supportHoursPerYear: 0
};
const plus: BillingPlan = {
	...pro,
	id: 'self-managed-plus',
	name: 'Self-Managed Plus',
	kind: 'self-managed',
	plane: 'self-managed',
	sites: null,
	sitesUnlimited: true,
	views: null
};
const standard: BillingPlan = {
	...pro,
	id: 'institution-standard',
	name: 'Institution Standard',
	kind: 'institution'
};

const entitlement: PlanEntitlement = {
	planId: 'managed-pro',
	managedPlanId: 'managed-pro',
	plane: 'managed',
	addOns: [],
	sites: 3,
	views: 1000000,
	storageGb: 10,
	writes: 3000000,
	backupGb: 10,
	mailSends: 2000,
	containerHours: 5,
	invitees: 100,
	supportHoursPerYear: 2,
	support: 'core',
	billingAccount: true
};

const addOn = (overrides: Partial<BillingAddOn> = {}): BillingAddOn => ({
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
	packs: [],
	unreviewed: false,
	...overrides
});

const hours = addOn({
	id: 'support-hours',
	name: 'Support Hours',
	meter: 'support-hours',
	unit: '1 hour of support',
	grants: 12,
	planes: ['self-hosted', 'self-managed', 'managed'],
	requires: null,
	monthly: 130,
	annual: 1300,
	packSizes: [1, 5],
	packs: [
		{ units: 1, price: 150 },
		{ units: 5, price: 700 }
	]
});
const core = addOn({
	id: 'support-core',
	name: 'Core Support',
	meter: 'support-level',
	unit: 'Core support, business hours',
	planes: ['self-hosted', 'self-managed', 'managed'],
	requires: ['managed-free'],
	monthly: 29,
	annual: 290
});
const critical = addOn({
	id: 'support-critical',
	name: '24/7 Critical Support',
	meter: 'support-level',
	unit: '24/7 critical support',
	requires: null,
	available: false,
	availableNote: 'Not sold until a second person is on the on-call rotation'
});
const blockAgency = addOn({
	id: 'site-block-agency',
	name: 'Site Block',
	requires: ['managed-agency']
});

const button = (wrapper: { findAll: (selector: string) => DOMWrapper<Element>[] }, text: string) =>
	wrapper.findAll('button').find((item) => item.text().includes(text));

describe('billing interval toggle', () => {
	it('marks the chosen period and emits the other when it is pressed', async () => {
		const wrapper = await mountSuspended(Interval, { props: { modelValue: 'month' } });
		expect(button(wrapper, 'Monthly')?.attributes('aria-pressed')).toBe('true');
		expect(button(wrapper, 'Annual')?.attributes('aria-pressed')).toBe('false');
		await button(wrapper, 'Annual')!.trigger('click');
		expect(wrapper.emitted('update:modelValue')).toEqual([['year']]);
	});
});

describe('billing current plan', () => {
	const props = {
		plan: pro,
		entitlement,
		addOns: [],
		interval: 'month' as const,
		subscribed: true,
		canPortal: true,
		busy: null
	};

	it('names the plan and the plane and shows the price for the chosen period', async () => {
		const month = await mountSuspended(Current, {
			props: { ...props, plan: { ...pro, monthly: 35, annual: 350 } }
		});
		expect(month.text()).toContain('Managed Pro');
		expect(month.text()).toContain('Managed');
		expect(month.text()).toContain('$35 a month');
		const year = await mountSuspended(Current, {
			props: { ...props, plan: { ...pro, monthly: 35, annual: 350 }, interval: 'year' }
		});
		expect(year.text()).toContain('$350 a year');
	});

	it('shows no number when the response carries no price, and Free for a zero price', async () => {
		const hidden = await mountSuspended(Current, { props });
		expect(hidden.text()).not.toContain('$');
		const zero = await mountSuspended(Current, {
			props: { ...props, plan: { ...free, monthly: 0, annual: 0 } }
		});
		expect(zero.text()).toContain('Free');
	});

	it('reads each limit in plain units', async () => {
		const wrapper = await mountSuspended(Current, { props });
		const text = wrapper.text();
		expect(text).toContain('1 million');
		expect(text).toContain('3 million');
		expect(text).toContain('10 GB');
		expect(text).toContain('5 hours');
		expect(text).toContain('Core, 2 hours a year');
	});

	it('shows a null limit as not stated', async () => {
		const wrapper = await mountSuspended(Current, {
			props: {
				...props,
				entitlement: { ...entitlement, sites: null, views: null, supportHoursPerYear: null }
			}
		});
		expect(wrapper.text()).toContain('Not Stated');
		expect(wrapper.text()).toContain('Core');
	});

	it('offers Manage Billing only when there is a billing account and the viewer may open it', async () => {
		const wrapper = await mountSuspended(Current, { props });
		await button(wrapper, 'Manage Billing')!.trigger('click');
		expect(wrapper.emitted('manage')).toHaveLength(1);

		const none = await mountSuspended(Current, { props: { ...props, subscribed: false } });
		expect(button(none, 'Manage Billing')).toBeUndefined();

		const viewer = await mountSuspended(Current, { props: { ...props, canPortal: false } });
		expect(button(viewer, 'Manage Billing')).toBeUndefined();
		expect(viewer.text()).toContain(
			'Only organization owners and billing members can change billing.'
		);
	});

	it('says sites on the customer own account are not counted on another plane', async () => {
		const own = await mountSuspended(Current, {
			props: { ...props, plan: plus, entitlement: { ...entitlement, plane: 'self-managed' } }
		});
		expect(own.text()).toContain('Self-Managed');
		expect(own.text()).toContain('not counted');
		const managed = await mountSuspended(Current, { props });
		expect(managed.text()).not.toContain('not counted');
	});

	it('shows the Unreviewed tag only beside an admin price', async () => {
		const flagged = await mountSuspended(Current, {
			props: { ...props, plan: { ...pro, monthly: 35, annual: 350, unreviewed: true } }
		});
		expect(flagged.text()).toContain('Unreviewed Price');
		const reviewed = await mountSuspended(Current, {
			props: { ...props, plan: { ...pro, monthly: 35, annual: 350, unreviewed: false } }
		});
		expect(reviewed.text()).not.toContain('Unreviewed');
	});

	it('lists the packs bought under the add-on names', async () => {
		const wrapper = await mountSuspended(Current, {
			props: {
				...props,
				addOns: [hours],
				entitlement: { ...entitlement, credits: { 'support-hours': 5 } }
			}
		});
		expect(wrapper.text()).toContain('Packs You Bought');
		expect(wrapper.text()).toContain('Support Hours: 5');
	});

	it('names the plan as not listed when the catalogue lacks its id', async () => {
		const wrapper = await mountSuspended(Current, { props: { ...props, plan: undefined } });
		expect(wrapper.text()).toContain('Plan Not Listed');
	});
});

describe('billing plan list', () => {
	const props = {
		plans: [pro, free],
		currentPlanId: 'managed-free',
		interval: 'month' as const,
		canBuy: true,
		subscribed: false,
		portal: false,
		busy: null
	};

	it('says no plans are published when the list is empty', async () => {
		const wrapper = await mountSuspended(Plans, { props: { ...props, plans: [] } });
		expect(wrapper.text()).toContain('No Plans Yet');
	});

	it('shows no number and the not-published line when the response has no price', async () => {
		const wrapper = await mountSuspended(Plans, { props });
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('shows the price of the chosen period and what a year saves', async () => {
		const priced = { ...pro, monthly: 35, annual: 350 };
		const month = await mountSuspended(Plans, { props: { ...props, plans: [priced] } });
		expect(month.text()).toContain('$35 a month');
		expect(month.text()).not.toContain('Saves');
		const year = await mountSuspended(Plans, {
			props: { ...props, plans: [priced], interval: 'year' }
		});
		expect(year.text()).toContain('$350 a year');
		expect(year.text()).toContain('Saves $70 a year');
	});

	it('describes a plan in plain words', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [pro, plus], currentPlanId: 'managed-pro' }
		});
		expect(wrapper.text()).toContain('3 sites, 1 million views a month, Core support');
		expect(wrapper.text()).toContain('Unlimited sites, Traffic on your Cloudflare plan');
	});

	it('marks the current plan and lists its plane first', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [pro, plus], currentPlanId: 'self-managed-plus' }
		});
		const text = wrapper.text();
		expect(text).toContain('Current Plan');
		expect(text.indexOf('Self-Managed')).toBeLessThan(text.indexOf('Managed Pro'));
	});

	it('shows Free for a zero price and offers no purchase', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...free, monthly: 0, annual: 0 }], currentPlanId: 'x' }
		});
		expect(wrapper.text()).toContain('Free');
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('hides subscribe buttons and explains the change path once the org has a subscription', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: {
				...props,
				plans: [{ ...pro, monthly: 35, annual: 350 }],
				subscribed: true,
				portal: true
			}
		});
		expect(wrapper.text()).toContain('Use Manage Billing to change it.');
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('says a plan with no billing account changes outside the dashboard', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: {
				...props,
				plans: [{ ...pro, monthly: 35, annual: 350 }],
				subscribed: true,
				portal: false
			}
		});
		expect(wrapper.text()).toContain('not billed through the dashboard');
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('passes the chosen plan id and interval up to the page', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, monthly: 35, annual: 350 }], interval: 'year' }
		});
		await wrapper.find('button[aria-label="Subscribe to Managed Pro"]').trigger('click');
		expect(wrapper.emitted('subscribe')).toEqual([['managed-pro', 'year']]);
	});

	it('disables every subscribe button while another request is in flight', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, monthly: 35, annual: 350 }], busy: 'other:month' }
		});
		expect(button(wrapper, 'Subscribe')?.attributes('disabled')).toBeDefined();
	});

	it('offers no purchase to a viewer who may not buy', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, monthly: 35, annual: 350 }], canBuy: false }
		});
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('offers a contract plan a contact link instead of a purchase', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [standard], currentPlanId: 'managed-free' }
		});
		expect(wrapper.text()).toContain('Pricing on request');
		expect(wrapper.find('a[aria-label="Contact Us About Institution Standard"]').exists()).toBe(
			true
		);
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('greys a plan that is coming soon and offers no purchase', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, disabled: true, monthly: 35, annual: 350 }] }
		});
		expect(wrapper.text()).toContain('Coming Soon');
		expect(wrapper.find('li').classes()).toContain('opacity-60');
		expect(button(wrapper, 'Subscribe')).toBeUndefined();
	});

	it('shows the Unreviewed tag beside an admin price only', async () => {
		const wrapper = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, monthly: 35, annual: 350, unreviewed: true }] }
		});
		expect(wrapper.text()).toContain('Unreviewed Price');
		const reviewed = await mountSuspended(Plans, {
			props: { ...props, plans: [{ ...pro, monthly: 35, annual: 350, unreviewed: false }] }
		});
		expect(reviewed.text()).not.toContain('Unreviewed');
	});
});

describe('billing add-on list', () => {
	const props = {
		addOns: [addOn(), hours, core, critical, blockAgency],
		entitlement,
		interval: 'month' as const,
		canBuy: true,
		busy: null
	};

	it('lists only what the plane and the plan can use', async () => {
		const managed = await mountSuspended(AddOns, { props });
		expect(managed.text()).toContain('Extra Site');
		expect(managed.text()).toContain('Support Hours');
		expect(managed.text()).not.toContain('Site Block');
		expect(managed.text()).not.toContain('Core Support');

		const onFree = await mountSuspended(AddOns, {
			props: { ...props, entitlement: { ...entitlement, planId: 'managed-free' } }
		});
		expect(onFree.text()).not.toContain('Extra Site');
		expect(onFree.text()).toContain('Core Support');
	});

	it('says so when nothing is offered', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: { ...props, addOns: [blockAgency] }
		});
		expect(wrapper.text()).toContain('No Add-Ons for This Plan');
	});

	it('shows the unit price and subscribes with the default quantity', async () => {
		const wrapper = await mountSuspended(AddOns, { props: { ...props, addOns: [addOn()] } });
		expect(wrapper.text()).toContain('$10 a month each');
		expect(wrapper.text()).toContain('Each unit is 1 site above the plan.');
		await wrapper.find('button[aria-label="Add Extra Site"]').trigger('click');
		expect(wrapper.emitted('subscribe')).toEqual([['extra-site', 1]]);
	});

	it('prices the chosen period', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: { ...props, addOns: [addOn()], interval: 'year' }
		});
		expect(wrapper.text()).toContain('$100 a year each');
		expect(wrapper.text()).toContain('Annual Subscription');
	});

	it('shows what the organization holds and changes the quantity through the held row', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: {
				...props,
				addOns: [addOn()],
				entitlement: { ...entitlement, addOns: [{ id: 'extra-site', quantity: 2 }] }
			}
		});
		expect(wrapper.text()).toContain('You Have 2');
		const update = wrapper.find('button[aria-label="Update Extra Site"]');
		expect(update.attributes('disabled')).toBeDefined();
		await wrapper.find('input').setValue('4');
		await wrapper.find('input').trigger('blur');
		await flushPromises();
		await wrapper.find('button[aria-label="Update Extra Site"]').trigger('click');
		expect(wrapper.emitted('change')).toEqual([['extra-site', 4]]);
	});

	it('removes a held add-on at quantity zero', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: {
				...props,
				addOns: [addOn()],
				entitlement: { ...entitlement, addOns: [{ id: 'extra-site', quantity: 1 }] }
			}
		});
		await wrapper.find('input').setValue('0');
		await wrapper.find('input').trigger('blur');
		await flushPromises();
		await wrapper.find('button[aria-label="Remove Extra Site"]').trigger('click');
		expect(wrapper.emitted('change')).toEqual([['extra-site', 0]]);
	});

	it('gives a support level no quantity, adds it once and removes it', async () => {
		const free = { ...entitlement, planId: 'managed-free' };
		const add = await mountSuspended(AddOns, {
			props: { ...props, addOns: [core], entitlement: free }
		});
		expect(add.find('input').exists()).toBe(false);
		await add.find('button[aria-label="Add Core Support"]').trigger('click');
		expect(add.emitted('subscribe')).toEqual([['support-core', 1]]);

		const held = await mountSuspended(AddOns, {
			props: {
				...props,
				addOns: [core],
				entitlement: { ...free, addOns: [{ id: 'support-core', quantity: 1 }] }
			}
		});
		expect(held.text()).toContain('Added');
		await held.find('button[aria-label="Remove Core Support"]').trigger('click');
		expect(held.emitted('change')).toEqual([['support-core', 0]]);
	});

	it('sells a one-time pack by the first listed size', async () => {
		const wrapper = await mountSuspended(AddOns, { props: { ...props, addOns: [hours] } });
		expect(wrapper.text()).toContain('One-Time Pack');
		await wrapper.find('button[aria-label="Buy a Pack of Support Hours"]').trigger('click');
		expect(wrapper.emitted('pack')).toEqual([['support-hours', 1]]);
	});

	it('names a single pack size without a picker', async () => {
		const container = addOn({
			id: 'container-hours',
			name: 'Container Hours',
			meter: 'container-hours',
			planes: ['self-managed', 'managed'],
			requires: null,
			subscription: false,
			monthly: null,
			annual: null,
			packSizes: [1],
			packs: [{ units: 1, price: 10 }]
		});
		const wrapper = await mountSuspended(AddOns, { props: { ...props, addOns: [container] } });
		expect(wrapper.text()).toContain('1 unit, $10');
		expect(wrapper.find('button[aria-label="Add Container Hours"]').exists()).toBe(false);
		await wrapper.find('button[aria-label="Buy a Pack of Container Hours"]').trigger('click');
		expect(wrapper.emitted('pack')).toEqual([['container-hours', 1]]);
	});

	it('explains an add-on that is not on sale and offers no control', async () => {
		const wrapper = await mountSuspended(AddOns, { props: { ...props, addOns: [critical] } });
		expect(wrapper.text()).toContain('Not available yet.');
		expect(wrapper.text()).toContain('on-call rotation');
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('says pricing is not published and offers no control when the price is hidden', async () => {
		const hidden = addOn({ monthly: undefined, annual: undefined, packs: undefined });
		const wrapper = await mountSuspended(AddOns, { props: { ...props, addOns: [hidden] } });
		expect(wrapper.text()).toContain('Pricing is not published yet.');
		expect(wrapper.text()).not.toContain('$');
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('shows a viewer the prices and no control', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: { ...props, addOns: [addOn()], canBuy: false }
		});
		expect(wrapper.text()).toContain('$10 a month each');
		expect(wrapper.findAll('button')).toHaveLength(0);
	});

	it('disables every control while another request is in flight', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: { ...props, addOns: [addOn(), hours], busy: 'addon:other:sub' }
		});
		for (const control of wrapper.findAll('button')) {
			expect(control.attributes('disabled')).toBeDefined();
		}
	});

	it('shows the Unreviewed tag beside an admin price', async () => {
		const wrapper = await mountSuspended(AddOns, {
			props: { ...props, addOns: [addOn({ unreviewed: true })] }
		});
		expect(wrapper.text()).toContain('Unreviewed Price');
	});
});
