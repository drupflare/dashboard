import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPage from '~/pages/admin.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const me = (platformRole: 'admin' | null) => ({
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	platformRole,
	via: 'session',
	stepUpUntil: null
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage(role: 'admin' | null) {
	cleanup = registerApi({
		'GET /api/v1/me': { body: me(role) },
		'GET /api/v1/admin/overview': {
			body: { users: 4, organizations: 2, sites: { active: 3 }, operations: { succeeded: 5 } }
		},
		'GET /api/v1/admin/users': {
			body: {
				items: [
					{
						id: 'u1',
						email: 'ada@example.test',
						displayName: 'Ada',
						platformRole: 'admin',
						createdAt: Date.UTC(2026, 10, 6, 12, 30)
					}
				],
				nextBefore: null
			}
		}
	});
	const wrapper = await mountSuspended(AdminPage, { route: '/admin' });
	mounted.push(wrapper);
	await useSessionStore().ensure();
	await wrapper.vm.$nextTick();
	return wrapper;
}

describe('admin page states', () => {
	it('shows skeletons while the account is unknown and while the totals load', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': { body: me('admin') },
			'GET /api/v1/admin/overview': async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return {
					body: { users: 4, organizations: 2, sites: { active: 3 }, operations: {} }
				};
			}
		});
		const wrapper = await mountSuspended(AdminPage);
		mounted.push(wrapper);
		const loading = wrapper.find('[role="status"]');
		expect(loading.text()).toBe('Loading the admin area');
		expect(loading.findAll('.animate-pulse').length).toBeGreaterThan(5);
		expect(wrapper.text()).not.toContain('Loading...');

		await useSessionStore().ensure();
		await vi.waitFor(() =>
			expect(wrapper.find('[role="status"]').text()).toBe('Loading the totals')
		);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Sites by State'));
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
	});

	it('shows a table skeleton while a list tab loads', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': { body: me('admin') },
			'GET /api/v1/admin/overview': {
				body: { users: 1, organizations: 1, sites: {}, operations: {} }
			},
			'GET /api/v1/admin/users': async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				return { body: { items: [], nextBefore: null } };
			}
		});
		const wrapper = await mountSuspended(AdminPage, { route: '/admin' });
		mounted.push(wrapper);
		await useSessionStore().ensure();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Sites by State'));
		const tab = wrapper.findAll('[role="tab"]').find((t) => t.text().includes('Users'));
		await tab?.trigger('mousedown', { button: 0 });
		await vi.waitFor(() =>
			expect(wrapper.find('[role="status"]').text()).toBe('Loading the list')
		);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No users yet.'));
	});

	it('shows the not-found state, with no skeleton, to a signed-out visitor', async () => {
		useSessionStore().me = null;
		const wrapper = await mountSuspended(AdminPage);
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
		expect(wrapper.find('[role="status"]').exists()).toBe(false);
	});
});

describe('admin page', () => {
	it('shows the totals to an admin', async () => {
		const wrapper = await mountPage('admin');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Sites by State'));
		expect(wrapper.text()).toContain('Organizations');
		expect(wrapper.text()).toContain('active');
	});

	it('shows nothing of the admin area to a person without the role', async () => {
		const wrapper = await mountPage(null);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
		expect(wrapper.text()).not.toContain('Sites by State');
		expect(calls.some((call) => call.path.startsWith('/api/v1/admin'))).toBe(false);
	});

	it('loads a list tab and formats the dates in UTC', async () => {
		const wrapper = await mountPage('admin');
		const tab = wrapper.findAll('[role="tab"]').find((t) => t.text().includes('Users'));
		await tab?.trigger('mousedown', { button: 0 });
		await vi.waitFor(() => expect(wrapper.text()).toContain('ada@example.test'));
		expect(wrapper.text()).toContain('2026-11-06 12:30');
	});
});
