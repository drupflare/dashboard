import { clearNuxtState } from '#app';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewPage from '~/pages/new/index.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const templates = {
	items: [
		{
			id: 'drupal',
			name: 'Drupal',
			category: 'cms',
			free: true,
			enabled: true,
			comingSoon: null
		},
		{
			id: 'wordpress',
			name: 'WordPress',
			category: 'cms',
			free: true,
			enabled: false,
			comingSoon: 'Coming Soon'
		},
		{
			id: 'bring-your-own',
			name: 'Bring Your Own',
			category: 'workers',
			free: false,
			enabled: true,
			comingSoon: null
		}
	]
};
const createKey = `POST /api/v1/orgs/${personal.id}/sites`;

let cleanup: () => void = () => undefined;
let createReply: () => Reply | Promise<Reply>;
let planReply: () => Reply;
let templatesReply: () => Reply | Promise<Reply>;
const paidPlan = { planId: 'site', features: { customCode: true } };
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	clearNuxtState('onboarding-draft');
	useSessionStore().$reset();
	useOrgStore().$reset();
	createReply = () => ({ status: 202, body: { id: 'op_new', targetIds: ['site_new'] } });
	planReply = () => ({ body: paidPlan });
	templatesReply = () => ({ body: templates });
	cleanup = registerApi({
		[`GET /api/v1/orgs/${personal.id}/entitlement`]: () => planReply(),
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		'GET /api/v1/templates': () => templatesReply(),
		[createKey]: () => createReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(NewPage, { route: '/new' });
	mounted.push(wrapper);
	await vi.waitFor(() => expect(wrapper.find('h2').exists()).toBe(true));
	return wrapper;
}

type Clickable = { text(): string; trigger(event: string): Promise<unknown> };

function clickButton(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	const button = wrapper.findAll('button').find((b) => b.text().trim() === label);
	if (!button) throw new Error(`no button labelled ${label}`);
	return button.trigger('click');
}

describe('create a site, step one', () => {
	it('selects Managed and disables Self-Managed and Self-Hosted as Coming Soon', async () => {
		const wrapper = await mountPage();

		expect(wrapper.find<HTMLInputElement>('#plane-managed').element.checked).toBe(true);
		expect(wrapper.find<HTMLInputElement>('#plane-self-managed').element.disabled).toBe(true);
		expect(wrapper.find<HTMLInputElement>('#plane-self-hosted').element.disabled).toBe(true);
		expect(wrapper.text()).toContain('Coming Soon');
	});

	it('moves through the steps with Skip and Next and shows the step in a live region', async () => {
		const wrapper = await mountPage();

		expect(wrapper.find('[role="status"]').text()).toContain('Step 1 of 3: Hosting');
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Step 2 of 3: Template'));

		await vi.waitFor(() => expect(wrapper.find('#template-drupal').exists()).toBe(true));
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Step 3 of 3: Name and Create'));
		expect(wrapper.find<HTMLInputElement>('#site-name').element.value).toMatch(
			/^[a-z]+-[a-z]+-[a-z]+$/
		);
	});
});

describe('create a site, step two', () => {
	it('shows a grid-shaped skeleton until the templates arrive', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		templatesReply = async () => {
			await gate;
			return { body: templates };
		};
		const wrapper = await mountPage();
		await clickButton(wrapper, 'Skip');

		await vi.waitFor(() => expect(wrapper.text()).toContain('Loading templates'));
		expect(wrapper.findAll('.animate-pulse').length).toBeGreaterThan(3);
		expect(wrapper.text()).not.toContain('Loading templates...');

		release();
		await vi.waitFor(() => expect(wrapper.find('#template-drupal').exists()).toBe(true));
		expect(wrapper.text()).not.toContain('Loading templates');
	});

	it('disables WordPress and marks Bring Your Own as paid', async () => {
		const wrapper = await mountPage();
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() => expect(wrapper.find('#template-wordpress').exists()).toBe(true));

		expect(wrapper.find<HTMLInputElement>('#template-wordpress').element.disabled).toBe(true);
		expect(wrapper.find<HTMLInputElement>('#template-drupal').element.disabled).toBe(false);
		expect(wrapper.find<HTMLInputElement>('#template-bring-your-own').element.disabled).toBe(
			false
		);
		expect(wrapper.text()).toContain('Paid');
	});

	it('disables Bring Your Own with the reason when the plan lacks custom code', async () => {
		planReply = () => ({
			body: { planId: 'managed-free', features: { customCode: false } }
		});
		const wrapper = await mountPage();
		await clickButton(wrapper, 'Skip');

		await vi.waitFor(() =>
			expect(
				wrapper.find<HTMLInputElement>('#template-bring-your-own').element.disabled
			).toBe(true)
		);
		expect(wrapper.text()).toContain('Needs a Paid Plan');
		expect(wrapper.find<HTMLInputElement>('#template-drupal').element.disabled).toBe(false);
	});

	it('leaves Bring Your Own choosable when the plan cannot be read, so the server decides', async () => {
		planReply = () => failure('internal', 'Failed', 'req_plan_read');
		const wrapper = await mountPage();
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() =>
			expect(wrapper.find('#template-bring-your-own').exists()).toBe(true)
		);
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path.endsWith('/entitlement'))).toBe(true)
		);

		expect(wrapper.find<HTMLInputElement>('#template-bring-your-own').element.disabled).toBe(
			false
		);
	});
});

describe('create a site, step three', () => {
	async function reachNameStep() {
		const wrapper = await mountPage();
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() => expect(wrapper.find('#template-drupal').exists()).toBe(true));
		await clickButton(wrapper, 'Skip');
		await vi.waitFor(() => expect(wrapper.find('#site-name').exists()).toBe(true));
		return wrapper;
	}

	it('shows the rule error beside the name and the address preview', async () => {
		const wrapper = await reachNameStep();
		const input = wrapper.find<HTMLInputElement>('#site-name');

		await input.setValue('Bad Name');
		await input.trigger('blur');

		expect(wrapper.find('#site-name-error').text()).toMatch(/Use 3 to 63/);
		expect(wrapper.find('#site-name').attributes('aria-invalid')).toBe('true');
		expect(wrapper.text()).toContain('Bad Name.drupflare.app');
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
	});

	it('posts one create with the draft name and the same Idempotency-Key on a double click', async () => {
		const wrapper = await reachNameStep();
		await wrapper.find('#site-name').setValue('quiet-oak-harbor');

		// happy-dom does not turn a submit button click into a submit event, so the form is submitted directly
		const form = wrapper.find('form');
		await Promise.all([form.trigger('submit'), form.trigger('submit')]);

		await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
		const [create] = calls.filter((c) => c.method === 'POST');
		expect(create?.body).toEqual({ kind: 'drupal', name: 'quiet-oak-harbor' });
		expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('shows the server reason and stays on the name step when the plan refuses the kind', async () => {
		createReply = () => ({
			status: 403,
			body: {
				code: 'forbidden',
				message: 'Your plan does not include this kind of site',
				details: {},
				requestId: 'req_plan'
			}
		});
		const wrapper = await reachNameStep();

		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('Your plan does not include')
		);
		expect(wrapper.find('#site-name').exists()).toBe(true);
	});

	it('shows a server failure without leaving the step', async () => {
		createReply = () => failure('internal', 'Failed', 'req_x');
		const wrapper = await reachNameStep();

		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(wrapper.find('#site-name').exists()).toBe(true);
	});
});
