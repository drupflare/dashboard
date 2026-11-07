import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import PublicLayout from '~/layouts/public.vue';
import IndexPage from '~/pages/index.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const unauthenticated = {
	status: 401,
	body: { code: 'unauthenticated', message: 'Sign in', details: {}, requestId: 'req_me' }
};

let signedIn = false;
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	signedIn = false;
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': () => (signedIn ? { body: me } : unauthenticated)
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(PublicLayout, {
		route: '/',
		slots: { default: () => h(IndexPage) }
	});
	mounted.push(wrapper);
	return wrapper;
}

function hint() {
	document.cookie = 'drupflare_in=1; path=/';
	useSessionStore().$reset();
}

describe('landing page', () => {
	it('shows the product and the sign-in buttons to a visitor with no hint', async () => {
		const wrapper = await mountPage();
		expect(wrapper.find('h1').text()).toBe('Managed Drupal Sites on Cloudflare');
		expect(wrapper.find('#how').exists()).toBe(true);
		const nav = wrapper.find('header').text();
		expect(nav).toContain('Sign In');
		expect(nav).toContain('Create a Site');
		expect(nav).not.toContain('Sign Out');
		expect(calls.filter((call) => call.path === '/api/v1/me')).toHaveLength(0);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows Sites and Sign Out on first paint when the hint is set, and stays on the page', async () => {
		hint();
		signedIn = true;
		const wrapper = await mountPage();
		const nav = wrapper.find('header');
		expect(nav.text()).toContain('Sites');
		expect(nav.text()).toContain('Sign Out');
		expect(nav.text()).not.toContain('Create a Site');
		expect(nav.find('a[href="/sites"]').exists()).toBe(true);
		await vi.waitFor(() => expect(useSessionStore().me).toEqual(me));
		expect(wrapper.find('h1').text()).toBe('Managed Drupal Sites on Cloudflare');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('falls back to the signed-out buttons, with no error, when the hint is wrong', async () => {
		hint();
		const wrapper = await mountPage();
		expect(wrapper.find('header').text()).toContain('Sign Out');
		await vi.waitFor(() => expect(useSessionStore().me).toBeNull());
		await vi.waitFor(() => expect(wrapper.find('header').text()).toContain('Sign In'));
		expect(wrapper.find('header').text()).not.toContain('Sign Out');
		expect(useSessionStore().error).toBeNull();
		expect(document.cookie).not.toContain('drupflare_in=1');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('names what the dashboard does today and claims no feature it lacks', async () => {
		const text = (await mountPage()).text();
		for (const built of ['drupflare.app', 'Backups', 'A Record of Every Action']) {
			expect(text).toContain(built);
		}
		for (const planned of ['custom domain', 'WordPress', 'Joomla', 'planned']) {
			expect(text).not.toContain(planned);
		}
	});
});
