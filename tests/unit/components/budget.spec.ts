import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick } from 'vue';
import BudgetAlerts from '~/components/billing/budget/Alerts.vue';
import BudgetForm from '~/components/billing/budget/Form.vue';
import BudgetState from '~/components/billing/budget/State.vue';
import SitePanel from '~/components/site/budget/Panel.vue';
import { useBudgetStore } from '~/stores/budget';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

// the real step-up form needs Turnstile and an email code; the budget only has to hand over and take back control
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

const ORG = 'org_1';
const SITE = 'site_1';
const orgKey = `GET /api/v1/orgs/${ORG}/budget`;
const orgPut = `PUT /api/v1/orgs/${ORG}/budget`;
const siteKey = `GET /api/v1/orgs/${ORG}/sites/${SITE}/budget`;
const sitePut = `PUT /api/v1/orgs/${ORG}/sites/${SITE}/budget`;

// a fixture rate, so the dollar expectations below are computed from it, not from the catalogue
const RATE_PER_MILLION = 5;
const ALLOWANCE = 1_000_000;

const priced = (percent: number) => ({
	kind: 'dollars',
	dollars: ((ALLOWANCE * percent) / 100 / 1_000_000) * RATE_PER_MILLION
});

const view = (overrides: Record<string, unknown> = {}) => ({
	status: 'ok',
	overageBilled: true,
	scope: 'org',
	siteId: null,
	percent: 500,
	enforcement: 'block',
	ownerSet: true,
	allowanceViews: ALLOWANCE,
	dollars: priced(500),
	viewsLowerBound: 250_000,
	accounting: 'counted',
	state: 'ok',
	flags: [],
	alertsSent: [],
	enforcementFlag: 'on',
	appliesWithin:
		'A stop takes effect within one lease interval plus one counting flush interval.',
	...overrides
});

const owner = { id: ORG, name: 'Personal', personal: true, role: 'owner' };
const envelope = (status: number, code: string, message: string, details: unknown = {}): Reply => ({
	status,
	body: { code, message, details, requestId: 'req_b1' }
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useBudgetStore().$reset();
	useOrgStore().$reset();
	useSessionStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

function routes(extra: Record<string, unknown>) {
	cleanup = registerApi(extra as Parameters<typeof registerApi>[0]);
}

type Props = Partial<{
	scope: 'org' | 'site';
	siteId: string;
	reply: ReturnType<typeof view>;
	ceiling: number | null;
	canManage: boolean;
}>;

async function mountForm(props: Props = {}) {
	const wrapper = await mountSuspended(BudgetForm, {
		props: {
			scope: 'org',
			orgId: ORG,
			reply: view(),
			ceiling: null,
			canManage: true,
			...props
		} as never
	});
	mounted.push(wrapper);
	return wrapper;
}

const numberField = (wrapper: { find: (selector: string) => any }) =>
	wrapper.find('input#budget-percent');
const range = (wrapper: { find: (selector: string) => any }) => wrapper.find('input[type="range"]');
const puts = (path: string) => calls.filter((call) => call.method === 'PUT' && call.path === path);
// a save is async, so the body is read once the request has reached the stub
async function lastBody(path: string) {
	await vi.waitFor(() => expect(puts(path).length).toBeGreaterThan(0));
	return puts(path).at(-1)?.body;
}

describe('budget form', () => {
	it('keeps the slider and the number field on one value across 200 positions', async () => {
		routes({ [orgPut]: { body: { ...view(), changed: true } } });
		const wrapper = await mountForm();
		const slider = range(wrapper);
		const seen: number[] = [];
		for (let i = 0; i < 200; i += 1) {
			const position = i / 199;
			(slider.element as HTMLInputElement).value = String(position);
			slider.trigger('input');
			await nextTick();
			const value = Number((numberField(wrapper).element as HTMLInputElement).value);
			seen.push(value);
		}
		expect(seen[0]).toBe(100);
		expect(seen.at(-1)).toBe(1000);
		expect(seen.every((value, i) => i === 0 || value >= (seen[i - 1] ?? -Infinity))).toBe(true);
		expect(puts(`/api/v1/orgs/${ORG}/budget`)).toHaveLength(0);
	});

	it('keeps an exact typed value and saves it as typed', async () => {
		routes({ [orgPut]: { body: { ...view({ percent: 437.3 }), changed: true } } });
		const wrapper = await mountForm();
		await numberField(wrapper).setValue('437.3');
		await numberField(wrapper).trigger('blur');
		await nextTick();
		expect((numberField(wrapper).element as HTMLInputElement).value).toBe('437.3');
		expect(await lastBody(`/api/v1/orgs/${ORG}/budget`)).toEqual({
			percent: 437.3,
			enforcement: 'block'
		});
	});

	it('saves a typed value on enter from the keyboard', async () => {
		routes({ [orgPut]: { body: { ...view({ percent: 350 }), changed: true } } });
		const wrapper = await mountForm();
		await numberField(wrapper).setValue('350');
		await numberField(wrapper).trigger('keydown.enter');
		await nextTick();
		expect(await lastBody(`/api/v1/orgs/${ORG}/budget`)).toMatchObject({ percent: 350 });
	});

	it('says a site budget is clamped to the organization budget and saves the clamped value', async () => {
		routes({
			[sitePut]: {
				body: { ...view({ scope: 'site', siteId: SITE, percent: 300 }), changed: true }
			}
		});
		const wrapper = await mountForm({
			scope: 'site',
			siteId: SITE,
			reply: view({ scope: 'site', siteId: SITE, percent: 200 }),
			ceiling: 300
		});
		await numberField(wrapper).setValue('800');
		await numberField(wrapper).trigger('blur');
		await nextTick();
		expect((numberField(wrapper).element as HTMLInputElement).value).toBe('300');
		expect(wrapper.text()).toContain(
			'The organization budget of 300 percent is the most a site can use.'
		);
		expect(await lastBody(`/api/v1/orgs/${ORG}/sites/${SITE}/budget`)).toEqual({
			percent: 300,
			enforcement: 'block'
		});
	});

	it('states a value outside the range in words and saves nothing', async () => {
		const wrapper = await mountForm();
		await numberField(wrapper).setValue('50');
		await numberField(wrapper).trigger('blur');
		await nextTick();
		expect(wrapper.text()).toContain('The lowest budget is 100 percent');
		expect(puts(`/api/v1/orgs/${ORG}/budget`)).toHaveLength(0);
	});

	it('prices the percent on screen from the saved rate', async () => {
		const wrapper = await mountForm();
		expect(wrapper.text()).toContain('$20.00');
		await numberField(wrapper).setValue('200');
		await nextTick();
		expect(wrapper.text()).toContain('$5.00');
	});

	it('says not billed yet when the rate is unreviewed', async () => {
		const wrapper = await mountForm({
			reply: view({ dollars: { kind: 'unreviewed', reason: 'rate-unreviewed' } })
		});
		expect(wrapper.text()).toContain('Not billed yet.');
	});

	it('says not billed yet while overage billing is off, even with a priced rate', async () => {
		const wrapper = await mountForm({ reply: view({ overageBilled: false }) });
		expect(wrapper.text()).toContain('Not billed yet.');
		expect(wrapper.text()).not.toContain('$20.00');
	});

	it('sends the switch to alerts only as the chosen enforcement', async () => {
		routes({ [orgPut]: { body: { ...view({ enforcement: 'alert' }), changed: true } } });
		const wrapper = await mountForm();
		await wrapper.find('input[type="radio"][value="alert"]').trigger('change');
		await nextTick();
		expect(await lastBody(`/api/v1/orgs/${ORG}/budget`)).toEqual({
			percent: 500,
			enforcement: 'alert'
		});
	});

	it('asks for a fresh sign-in before a raise and saves after it', async () => {
		let attempts = 0;
		routes({
			[orgPut]: () => {
				attempts += 1;
				if (attempts === 1) {
					return envelope(403, 'forbidden', 'Fresh authentication is required', {
						requires: 'step-up'
					});
				}
				return { body: { ...view({ percent: 600 }), changed: true } };
			}
		});
		const wrapper = await mountForm();
		await numberField(wrapper).setValue('600');
		await numberField(wrapper).trigger('blur');
		await vi.waitFor(() =>
			expect(wrapper.find('button[data-step-up-done]').exists()).toBe(true)
		);
		await wrapper.find('button[data-step-up-done]').trigger('click');
		await vi.waitFor(() => expect(attempts).toBe(2));
	});

	it('offers an undo after a lowering and sends the old value back', async () => {
		routes({ [orgPut]: { body: { ...view({ percent: 300 }), changed: true } } });
		const wrapper = await mountForm();
		await numberField(wrapper).setValue('300');
		await numberField(wrapper).trigger('blur');
		await vi.waitFor(() => expect(undoButton(wrapper)).toBeDefined());
		await undoButton(wrapper)?.trigger('click');
		await vi.waitFor(() =>
			expect(puts(`/api/v1/orgs/${ORG}/budget`).at(-1)?.body).toEqual({
				percent: 500,
				enforcement: 'block'
			})
		);
	});

	it('shows the stop choice with its bound, and disables every control for a viewer', async () => {
		const wrapper = await mountForm({ canManage: false });
		expect(wrapper.text()).toContain('Stop the Site at the Limit');
		expect(wrapper.text()).toContain('Send Alerts Only');
		expect(wrapper.text()).toContain('A stop takes effect within one lease interval');
		expect(wrapper.text()).toContain(
			'Only the owner or a billing member can change this budget.'
		);
		expect((numberField(wrapper).element as HTMLInputElement).disabled).toBe(true);
		expect((range(wrapper).element as HTMLInputElement).disabled).toBe(true);
	});
});

const undoButton = (wrapper: { findAll: (selector: string) => any[] }) =>
	wrapper.findAll('button').find((button) => button.text() === 'Undo');

describe('budget state', () => {
	it.each([
		['ok', {}, 'Running'],
		['over-budget', { state: 'over-budget' }, 'Stopped at the budget'],
		[
			'would-block',
			{ state: 'would-block', flags: ['would-block'], enforcementFlag: 'shadow' },
			'Would stop (testing mode)'
		]
	])('says %s in words', async (_name, overrides, text) => {
		const wrapper = await mountSuspended(BudgetState, {
			props: { reply: view(overrides) as never }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain(text);
	});

	it('says the count is unaccounted when no count is available', async () => {
		const wrapper = await mountSuspended(BudgetState, {
			props: { reply: view({ accounting: 'unavailable', viewsLowerBound: null }) as never }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Unaccounted');
		expect(wrapper.text()).toContain('Not available');
	});

	it('says the count is estimated when it is counted', async () => {
		const wrapper = await mountSuspended(BudgetState, { props: { reply: view() as never } });
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Estimated');
	});

	it('draws the usage fill in the brand colour, not the page muted token', async () => {
		const wrapper = await mountSuspended(BudgetState, { props: { reply: view() as never } });
		mounted.push(wrapper);
		expect(wrapper.find('.bg-brand-600').exists()).toBe(true);
		expect(wrapper.find('.bg-muted').exists()).toBe(false);
	});
});

describe('budget store', () => {
	it('keeps the overage flag from the reply as the server sent it', async () => {
		routes({ [orgKey]: { body: view({ overageBilled: false }) } });
		await useBudgetStore().loadOrg(ORG);
		expect(useBudgetStore().org.get(ORG)).toMatchObject({ overageBilled: false });
	});
});

describe('budget alerts', () => {
	it('marks the alerts already sent this month', async () => {
		const wrapper = await mountSuspended(BudgetAlerts, {
			props: { reply: view({ alertsSent: ['allowance-75'] }) as never }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('At 75 percent of included views');
		expect(wrapper.text()).toContain('Sent');
		expect(wrapper.text()).toContain('Not sent yet');
	});

	it('lists no block alert for an alert-only budget', async () => {
		const wrapper = await mountSuspended(BudgetAlerts, {
			props: { reply: view({ enforcement: 'alert' }) as never }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).not.toContain('stops at the budget');
	});
});

describe('site budget panel', () => {
	let siteReply: Reply = { body: {} };

	beforeEach(async () => {
		siteReply = {
			body: view({ scope: 'site', siteId: SITE, percent: 250, ownerSet: false })
		};
		routes({
			'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
			'GET /api/v1/me/organizations': { body: { items: [owner], nextCursor: null } },
			[orgKey]: { body: view() },
			[siteKey]: () => siteReply
		});
		useSessionStore().me = {
			id: 'usr_1',
			email: 'owner@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		};
		await useOrgStore().ensure();
	});

	it('shows the shared default as the placeholder until the site has its own budget', async () => {
		const wrapper = await mountSuspended(SitePanel, {
			props: { siteId: SITE, canManage: true }
		});
		mounted.push(wrapper);
		await settle(wrapper, 'Budget (Percent of Included Views)');
		expect((numberField(wrapper).element as HTMLInputElement).getAttribute('placeholder')).toBe(
			'Using the shared default: 250 percent'
		);
	});

	it('shows the plain explanation and no controls on a free plan', async () => {
		siteReply = { body: { status: 'not_applicable' } };
		const wrapper = await mountSuspended(SitePanel, {
			props: { siteId: SITE, canManage: true }
		});
		mounted.push(wrapper);
		await settle(wrapper, 'Budgets Start on a Paid Plan');
		expect(wrapper.find('input[type="range"]').exists()).toBe(false);
	});
});

async function settle(wrapper: { text: () => string }, text: string): Promise<void> {
	for (let i = 0; i < 100; i += 1) {
		if (wrapper.text().includes(text)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`never showed: ${text}`);
}
