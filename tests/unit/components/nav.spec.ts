import { NuxtLink } from '#components';
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NavBar from '~/components/NavBar.vue';
import PublicNav from '~/components/PublicNav.vue';
import SideNav from '~/components/SideNav.vue';
import { ADMIN_CONSOLES, ORG_NAV_GROUPS, orgRoleHolds, WORKSPACE_NAV } from '~/shared/navigation';
import { actionDef, ACTIONS, ORG_ROLES, type Action } from '~/shared/permissions';
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

// organization read actions with no side nav entry, and the reason each one has none
const UNLINKED_READS: Record<string, string> = {
	'org.read': 'lists sites; the Sites entry covers it',
	'operation.read': 'activity shows on each site; no organization list yet',
	'node.read': 'nodes are listed under Planes',
	'template.read': 'repository and site create flows read the templates',
	'assessment.read': 'read by the Assess pages',
	'audit.read': 'no page yet',
	'notification.read': 'no page yet',
	'release.read': 'no route uses it yet'
};

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
	beforeEach(() => {
		useOrgStore().items = [personal];
		useOrgStore().currentId = personal.id;
	});

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

	it('links planes as a client route', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		const planes = wrapper
			.findAllComponents(NuxtLink)
			.find((link) => link.props('to') === '/planes');
		expect(planes?.text()).toBe('Planes');
		expect(planes?.props('external')).toBe(false);
	});

	it('links billing as a client route', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		const billing = wrapper
			.findAllComponents(NuxtLink)
			.find((link) => link.props('to') === '/org/billing');
		expect(billing?.text()).toBe('Plan and Invoices');
		expect(billing?.props('external')).toBe(false);
	});

	it('links repositories as a client route', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		const repos = wrapper
			.findAllComponents(NuxtLink)
			.find((link) => link.props('to') === '/repos');
		expect(repos?.text()).toBe('Repositories');
		expect(repos?.props('external')).toBe(false);
	});

	it('links integrations as a client route', async () => {
		useSessionStore().me = me;
		const wrapper = await mount(SideNav);
		const integrations = wrapper
			.findAllComponents(NuxtLink)
			.find((link) => link.props('to') === '/org/integrations');
		expect(integrations?.text()).toBe('Integrations');
		expect(integrations?.props('external')).toBe(false);
	});

	it('links each page the lanes owed under the read action of its data route', () => {
		const org = ORG_NAV_GROUPS.flatMap((group) => group.items);
		const owedOrg: [string, Action][] = [
			['/org/support', 'support-grant.read'],
			['/org/delegations', 'delegation.read'],
			['/org/transfers', 'transfer.read'],
			['/org/clients', 'client.read'],
			['/org/usage', 'usage.read'],
			['/org/budget', 'billing.manage']
		];
		for (const [to, action] of owedOrg) {
			expect(org.find((item) => item.to === to)?.action, to).toBe(action);
		}
		const owedAdmin: [string, Action][] = [
			['/admin/trust', 'admin.trust.read'],
			['/admin/support-grants', 'admin.support-grants.read'],
			['/admin/db', 'admin.db.read']
		];
		for (const [to, action] of owedAdmin) {
			expect(ADMIN_CONSOLES.find((item) => item.to === to)?.action, to).toBe(action);
		}
	});

	it('shows each organization page to the roles that hold its read action, from the catalogue', async () => {
		const items = [...WORKSPACE_NAV, ...ORG_NAV_GROUPS.flatMap((group) => group.items)];
		useSessionStore().me = me;
		for (const role of ORG_ROLES) {
			useOrgStore().items = [{ ...personal, role }];
			const wrapper = await mount(SideNav);
			const shown = new Set(
				wrapper.findAllComponents(NuxtLink).map((link) => link.props('to'))
			);
			for (const item of items) {
				expect(shown.has(item.to), `${role} ${item.to}`).toBe(
					orgRoleHolds(role, item.action)
				);
			}
			wrapper.unmount();
		}
	});

	it('reaches every organization read action from a navigation entry, or names why it has none', () => {
		const linked = new Set<Action>(
			[...WORKSPACE_NAV, ...ORG_NAV_GROUPS.flatMap((group) => group.items)].map(
				(item) => item.action
			)
		);
		for (const action of ACTIONS) {
			const def = actionDef(action);
			if (def.scope !== 'org' || !action.endsWith('.read')) continue;
			expect(linked.has(action) || action in UNLINKED_READS, action).toBe(true);
		}
		for (const action of Object.keys(UNLINKED_READS)) {
			expect(linked.has(action as Action), action).toBe(false);
		}
	});
});
