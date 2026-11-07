import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '~/pages/account.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

let signedIn = true;
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	signedIn = true;
	useSessionStore().$reset();
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': () =>
			signedIn
				? { body: me }
				: {
						status: 401,
						body: {
							code: 'unauthenticated',
							message: 'Sign in',
							details: {},
							requestId: 'r'
						}
					},
		'GET /api/v1/me/identities': { body: { items: [], nextCursor: null } },
		'GET /api/v1/auth/oauth': { body: { providers: ['github', 'cloudflare'] } },
		'POST /api/v1/auth/logout': () => {
			signedIn = false;
			return { status: 204, body: null };
		}
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(AccountPage, { route: '/account' });
	mounted.push(wrapper);
	await useSessionStore().ensure();
	await wrapper.vm.$nextTick();
	return wrapper;
}

describe('account page states', () => {
	it('shows skeletons while the account is unknown, then the content', async () => {
		const wrapper = await mountSuspended(AccountPage);
		mounted.push(wrapper);
		const loading = wrapper.find('[role="status"]');
		expect(loading.text()).toBe('Loading your account');
		expect(loading.findAll('.animate-pulse').length).toBeGreaterThan(5);
		expect(wrapper.text()).not.toContain('Loading...');
		expect(wrapper.text()).not.toContain('Appearance');

		await useSessionStore().ensure();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Appearance'));
		expect(wrapper.text()).not.toContain('Loading your account');
	});

	it('shows an empty state with a way back to sign in when signed out', async () => {
		useSessionStore().me = null;
		const wrapper = await mountSuspended(AccountPage);
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('You Are Signed Out'));
		expect(wrapper.find('a[href="/login"]').exists()).toBe(true);
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Appearance');
	});
});

describe('account page', () => {
	it('shows the signed-in email and the three theme choices', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('owner@example.test'));
		const themes = wrapper
			.findAll('input[name="theme"]')
			.map((input) => input.attributes('value'));
		expect(themes).toEqual(['system', 'light', 'dark']);
	});

	it('changes the theme preference when a choice is picked', async () => {
		const wrapper = await mountPage();
		await wrapper.find('#theme-dark').setValue();
		expect(useColorMode().preference).toBe('dark');
		await wrapper.find('#theme-system').setValue();
		expect(useColorMode().preference).toBe('system');
	});

	it('signs out and goes to the sign-in page', async () => {
		const wrapper = await mountPage();
		const button = wrapper.findAll('button').find((b) => b.text().includes('Sign Out'));
		await button?.trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
	});
});
