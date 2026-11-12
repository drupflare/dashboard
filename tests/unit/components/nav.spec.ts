import { NuxtLink } from '#components';
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NavBar from '~/components/NavBar.vue';
import PublicNav from '~/components/PublicNav.vue';
import SideNav from '~/components/SideNav.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore, type Me } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const me: Me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		'POST /api/v1/auth/logout': { status: 204, body: undefined }
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mount(component: Parameters<typeof mountSuspended>[0]) {
	const wrapper = await mountSuspended(component);
	mounted.push(wrapper);
	return wrapper;
}

function hint() {
	document.cookie = 'drupflare_in=1; path=/';
	useSessionStore().$reset();
}

describe('NavBar', () => {
	it('shows no sign-out button and no switcher when nothing says the visitor is signed in', async () => {
		const wrapper = await mount(NavBar);
		await flushPromises();
		expect(wrapper.text()).not.toContain('Sign Out');
		expect(wrapper.find('select').exists()).toBe(false);
	});

	it('shows Sign Out from the hint before /me answers, with a skeleton for the switcher', async () => {
		hint();
		const wrapper = await mount(NavBar);
		expect(useSessionStore().me).toBeUndefined();
		expect(wrapper.text()).toContain('Sign Out');
		await vi.waitFor(() => expect(wrapper.findAll('option')).toHaveLength(1));
	});

	it('hides Sign Out once /me says the hint was wrong', async () => {
		hint();
		useSessionStore().me = null;
		const wrapper = await mount(NavBar);
		expect(wrapper.text()).not.toContain('Sign Out');
		expect(calls).toHaveLength(0);
	});

	it('signs out and goes to sign in', async () => {
		hint();
		const wrapper = await mount(NavBar);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
		expect(useSessionStore().hinted).toBe(false);
	});
});

describe('PublicNav', () => {
	it('offers Sign In and Create a Site without a hint', async () => {
		const wrapper = await mount(PublicNav);
		expect(wrapper.text()).toContain('Sign In');
		expect(wrapper.text()).toContain('Create a Site');
		expect(wrapper.text()).not.toContain('Sign Out');
		expect(calls).toHaveLength(0);
	});

	it('offers Sites and Sign Out with a hint, and Sign Out ends the session', async () => {
		hint();
		const wrapper = await mount(PublicNav);
		expect(wrapper.find('a[href="/sites"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Create a Site');

		const signOut = wrapper.findAll('button').find((button) => button.text() === 'Sign Out');
		expect(signOut).toBeDefined();
		await signOut?.trigger('click');
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path === '/api/v1/auth/logout')).toBe(true)
		);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Create a Site'));
		expect(calls.some((call) => call.path === '/api/v1/auth/logout')).toBe(true);
	});
});

describe('SideNav', () => {
	it('links the admin area as a full page load, never a client route', async () => {
		useSessionStore().me = { ...me, platformRole: 'admin' };
		const wrapper = await mount(SideNav);
		expect(wrapper.find('a[href="/admin"]').exists()).toBe(true);
		const links = wrapper.findAllComponents(NuxtLink);
		const externalOf = (to: string) =>
			links.find((link) => link.props('to') === to)?.props('external');
		expect(externalOf('/admin')).toBe(true);
		expect(externalOf('/sites')).toBe(false);
		expect(externalOf('/account')).toBe(false);
	});

	it('shows no admin link to a person without the role', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		expect(wrapper.find('a[href="/admin"]').exists()).toBe(false);
	});

	it('links billing as a client route', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		const billing = wrapper
			.findAllComponents(NuxtLink)
			.find((link) => link.props('to') === '/org/billing');
		expect(billing?.text()).toBe('Billing');
		expect(billing?.props('external')).toBe(false);
	});
});
