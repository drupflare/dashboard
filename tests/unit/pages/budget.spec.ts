import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import BudgetPage from '~/pages/org/budget.vue';
import { useBudgetStore } from '~/stores/budget';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

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

const ORG = 'org_personal';
const budgetKey = `GET /api/v1/orgs/${ORG}/budget`;
const budgetPut = `PUT /api/v1/orgs/${ORG}/budget`;

const owner = { id: ORG, name: 'Personal', personal: true, role: 'owner' };
const viewer = { id: ORG, name: 'Personal', personal: true, role: 'viewer' };

// the page shows what the server reports; these fixtures are the shapes it can return
const view = (overrides: Record<string, unknown> = {}) => ({
	status: 'ok',
	scope: 'org',
	siteId: null,
	percent: 500,
	enforcement: 'block',
	ownerSet: true,
	allowanceViews: 1000000,
	dollars: { kind: 'unreviewed', reason: 'rate-unreviewed' },
	viewsLowerBound: 120000,
	accounting: 'counted',
	state: 'ok',
	flags: [],
	alertsSent: [],
	enforcementFlag: 'on',
	appliesWithin:
		'A stop takes effect within one lease interval plus one counting flush interval.',
	...overrides
});

// a pooled organization shares its allowance across sites, so the allowance is the pool
const pooled = view({ allowanceViews: 3000000, viewsLowerBound: 1200000 });
const singleSite = view({ allowanceViews: 1000000 });
const shadow = view({ state: 'would-block', flags: ['would-block'], enforcementFlag: 'shadow' });
const stopped = view({ state: 'over-budget', viewsLowerBound: 5000000 });

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(): void {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	};
}

function setup(options: { role?: typeof owner; budget: Reply | (() => Reply) }) {
	cleanup = registerApi({
		'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
		'GET /api/v1/me/organizations': {
			body: { items: [options.role ?? owner], nextCursor: null }
		},
		[budgetKey]: options.budget,
		[budgetPut]: () => ({ body: { ...view(), changed: true } })
	} as Parameters<typeof registerApi>[0]);
}

async function mountPage() {
	const wrapper = await mountSuspended(BudgetPage, { route: '/org/budget' });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useBudgetStore().$reset();
	signIn();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('organization budget page', () => {
	it('shows a pooled organization budget with its state, usage and alerts', async () => {
		setup({ budget: { body: pooled } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Views Counted So Far'));
		expect(wrapper.text()).toContain('Running');
		expect(wrapper.text()).toContain('3,000,000');
		expect(wrapper.text()).toContain('Alerts This Month');
	});

	it('shows a single-site organization budget', async () => {
		setup({ budget: { body: singleSite } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('1,000,000'));
		expect(wrapper.find('input[type="range"]').exists()).toBe(true);
	});

	it('says a shadow budget would stop the site, and stops nothing', async () => {
		setup({ budget: { body: shadow } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Would stop (testing mode)'));
	});

	it('says a stopped organization is stopped at its budget', async () => {
		setup({ budget: { body: stopped } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Stopped at the budget'));
	});

	it('explains a free organization in plain words and offers no controls', async () => {
		setup({ budget: { body: { status: 'not_applicable' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Budgets Start on a Paid Plan'));
		expect(wrapper.find('input[type="range"]').exists()).toBe(false);
	});

	it('shows an error with a retry that reads the budget again', async () => {
		let attempts = 0;
		setup({
			budget: () => {
				attempts += 1;
				// a 5xx is retried by the fetch layer, so the first failure uses a status it does not retry
				return attempts === 1
					? {
							status: 400,
							body: {
								code: 'validation',
								message: 'The budget could not be read',
								details: {},
								requestId: 'req_p1'
							}
						}
					: { body: singleSite };
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the Budget'));
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try Again');
		await retry?.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('input[type="range"]').exists()).toBe(true));
		expect(attempts).toBe(2);
	});

	it('lets a viewer read the budget but not change it', async () => {
		setup({ role: viewer, budget: { body: singleSite } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'Only the owner or a billing member can change this budget.'
			)
		);
		expect(calls.some((call) => call.method === 'PUT')).toBe(false);
	});
});
