import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Admin from '~/components/site/Admin.vue';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_a';
const SITE = 'site_1';
const PASSWORD = 'Pw-Test-9c1e-admin';
const SIGN_IN = 'https://quiet-otter.drupflare.app/user/login';
const statePath = `GET /api/v1/orgs/${ORG}/sites/${SITE}/first-run-secret`;
const revealPath = `POST /api/v1/orgs/${ORG}/sites/${SITE}/first-run-secret`;

let cleanup: () => void = () => undefined;
let stateReply: () => Reply;
let revealReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

const state = (value: string) => ({ body: { kind: 'admin-password', state: value } });

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	stateReply = () => state('available');
	revealReply = () => ({ body: { kind: 'admin-password', value: PASSWORD } });
	cleanup = registerApi({
		[statePath]: () => stateReply(),
		[revealPath]: () => revealReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountAdmin(props: Partial<{ username: string | null; email: string | null }> = {}) {
	const wrapper = await mountSuspended(Admin, {
		props: {
			orgId: ORG,
			siteId: SITE,
			signInUrl: SIGN_IN,
			username: 'admin',
			email: 'owner@example.edu',
			...props
		}
	});
	mounted.push(wrapper);
	return wrapper;
}

const forgot = 'use "Forgot password" on the site\'s sign-in page';

describe('site admin sign-in', () => {
	it('shows the heading, the username, the email and the sign-in link', async () => {
		const wrapper = await mountAdmin();

		expect(wrapper.find('h2').text()).toBe('Admin Sign-In');
		expect(wrapper.text()).toContain('admin');
		expect(wrapper.text()).toContain('owner@example.edu');
		const link = wrapper.find(`a[href="${SIGN_IN}"]`);
		expect(link.exists()).toBe(true);
		expect(link.text()).toBe('Open Sign-In Page');
		expect(link.attributes('rel')).toContain('noopener');
	});

	it('shows a skeleton until the password state arrives', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		cleanup();
		cleanup = registerApi({
			[statePath]: async () => {
				await gate;
				return state('expired');
			}
		});
		const wrapper = await mountAdmin();

		expect(wrapper.find('[role="status"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('can no longer be shown');
		expect(wrapper.text()).not.toContain('Reveal Password');
		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('can no longer be shown'));
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
	});

	it('reveals an available password once and gives no recovery line while it can be shown', async () => {
		const wrapper = await mountAdmin();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Reveal Password'));
		expect(wrapper.text()).not.toContain(PASSWORD);
		expect(wrapper.text()).not.toContain('Forgot password');
		const reveal = wrapper.findAll('button').find((b) => b.text().trim() === 'Reveal Password');
		await reveal?.trigger('click');

		await vi.waitFor(() => expect(wrapper.text()).toContain(PASSWORD));
		expect(wrapper.text()).toContain('will not be shown again');
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('says a revealed password was shown once and is not stored, and names the recovery', async () => {
		stateReply = () => state('revealed');
		const wrapper = await mountAdmin();

		await vi.waitFor(() => expect(wrapper.text()).toContain('shown once and is not stored'));
		expect(wrapper.text()).not.toContain('Reveal Password');
		expect(wrapper.text()).toContain(forgot);
		expect(wrapper.text()).toContain('owner@example.edu');
		expect(wrapper.text()).toContain('not tested that the email arrives');
	});

	it('says an expired password can no longer be shown, and names the recovery', async () => {
		stateReply = () => state('expired');
		const wrapper = await mountAdmin();

		await vi.waitFor(() => expect(wrapper.text()).toContain('can no longer be shown'));
		expect(wrapper.text()).not.toContain('Reveal Password');
		expect(wrapper.text()).toContain(forgot);
	});

	it('says an unknown state predates the dashboard record, names the recovery and handles no email', async () => {
		stateReply = () => state('unknown');
		const wrapper = await mountAdmin({ username: null, email: null });

		await vi.waitFor(() => expect(wrapper.text()).toContain('created before the dashboard'));
		expect(wrapper.text()).not.toContain('Reveal Password');
		expect(wrapper.text()).toContain('Not Recorded');
		expect(wrapper.text()).toContain(forgot);
		expect(wrapper.text()).toContain('the admin address');
	});

	it('reads a 404 as a site with no password record', async () => {
		stateReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_404' }
		});
		const wrapper = await mountAdmin();

		await vi.waitFor(() => expect(wrapper.text()).toContain('created before the dashboard'));
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it('reports a failed state read with its request id and tries again', async () => {
		stateReply = () => ({
			status: 500,
			body: { code: 'internal', message: 'Failed', details: {}, requestId: 'req_state' }
		});
		const wrapper = await mountAdmin();

		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Could Not Load the Password State')
		);
		expect(wrapper.text()).toContain('req_state');
		expect(wrapper.text()).not.toContain('Forgot password');

		stateReply = () => state('expired');
		const retry = wrapper.findAll('button').find((b) => b.text().trim() === 'Try Again');
		await retry?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('can no longer be shown'));
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});
});
