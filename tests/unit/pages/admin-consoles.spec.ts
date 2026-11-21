import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AbusePage from '~/pages/admin/abuse.vue';
import FlagsPage from '~/pages/admin/flags.vue';
import MailPage from '~/pages/admin/mail.vue';
import OrgDetailPage from '~/pages/admin/orgs/[id].vue';
import UsersPage from '~/pages/admin/users.vue';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

const ADMIN_ME = {
	'GET /api/v1/me': {
		body: {
			id: 'usr_admin',
			email: 'admin@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null,
			platformRole: 'admin'
		}
	}
};

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useSessionStore().me = {
		id: 'usr_admin',
		email: 'admin@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null,
		platformRole: 'admin'
	} as never;
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('admin users page', () => {
	it('shows the loading state, then the populated list', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/users': {
				body: {
					items: [
						{
							id: 'usr_1',
							email: 'ada@example.test',
							displayName: 'Ada',
							platformRole: null,
							createdAt: 1
						}
					],
					nextBefore: null
				}
			}
		});
		const wrapper = await mountSuspended(UsersPage, { route: '/admin/users' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('ada@example.test'));
	});

	it('shows the empty state when there are no users', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/users': { body: { items: [], nextBefore: null } }
		});
		const wrapper = await mountSuspended(UsersPage, { route: '/admin/users' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No users yet.'));
	});

	it('shows the error state when the list does not load', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/users': { status: 500, body: { code: 'internal', message: 'Down' } }
		});
		const wrapper = await mountSuspended(UsersPage, { route: '/admin/users' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load This List'));
	});

	it('shows Page Not Found to a person without the admin role', async () => {
		useSessionStore().me = {
			id: 'usr_1',
			email: 'owner@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null,
			platformRole: null
		} as never;
		cleanup = registerApi({
			'GET /api/v1/admin/users': { status: 403, body: { code: 'forbidden', message: 'No' } }
		});
		const wrapper = await mountSuspended(UsersPage, { route: '/admin/users' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
	});
});

describe('admin mail page', () => {
	it('says whether optional mail is paused and shows the sends logged today', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/mail': {
				body: {
					essential: ['login-code'],
					optional: ['ops'],
					notificationsPaused: true,
					today: { sent: 7, failed: 1, skippedPaused: 2, skippedPreference: 3 },
					dailyCap: 100
				}
			}
		});
		const wrapper = await mountSuspended(MailPage, { route: '/admin/mail' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Essential Categories'));
		expect(wrapper.text()).toContain('paused by the platform');
		expect(wrapper.text()).toContain('7 of 100 sent');
		expect(wrapper.text()).toContain('1 failed');
	});
});

describe('admin flags page', () => {
	it('lists every switch with its value and who set it last', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/flags': {
				body: {
					flags: [
						{
							key: 'signups.paused',
							value: true,
							setBy: 'usr_admin',
							setAt: 1_700_000_000_000
						},
						{ key: 'notifications.paused', value: false, setBy: null, setAt: null },
						{ key: 'promotion.stopped', value: false, setBy: null, setAt: null },
						{ key: 'ladder.auto', value: false, setBy: null, setAt: null }
					]
				}
			}
		});
		const wrapper = await mountSuspended(FlagsPage, { route: '/admin/flags' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Pause Sign-ups'));
		expect(wrapper.text()).toContain('usr_admin');
		expect(wrapper.text()).toContain('Never changed');
	});

	it('shows the error state when the switches do not load', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/flags': { status: 500, body: { code: 'internal', message: 'Down' } }
		});
		const wrapper = await mountSuspended(FlagsPage, { route: '/admin/flags' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Switches Could Not Load'));
	});
});

describe('admin abuse page', () => {
	it('shows the queue and the empty state for a view with no reports', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/abuse': { body: { items: [], nextBefore: null } }
		});
		const wrapper = await mountSuspended(AbusePage, { route: '/admin/abuse' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No reports in this view.'));
	});

	it('shows a report with the moves its state allows', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/abuse': {
				body: {
					items: [
						{
							id: 'abuse_1',
							siteId: 'site_1',
							organizationId: 'org_1',
							source: 'report',
							reason: 'phishing page',
							state: 'open',
							reviewer: null,
							notes: null,
							createdAt: 1,
							updatedAt: 1
						}
					],
					nextBefore: null
				}
			}
		});
		const wrapper = await mountSuspended(AbusePage, { route: '/admin/abuse' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('phishing page'));
		expect(wrapper.text()).toContain('Reviewing');
		expect(wrapper.text()).toContain('Dismissed');
	});

	it('suspends the site of a report from the queue', async () => {
		const row = {
			id: 'abuse_1',
			siteId: 'site_1',
			organizationId: 'org_1',
			source: 'report',
			reason: 'phishing page',
			state: 'open',
			reviewer: null,
			notes: null,
			createdAt: 1,
			updatedAt: 1
		};
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/abuse': { body: { items: [row], nextBefore: null } },
			'POST /api/v1/admin/abuse/abuse_1/suspend': { status: 202, body: {} }
		});
		const wrapper = await mountSuspended(AbusePage, { route: '/admin/abuse' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Suspend Site'));
		const button = wrapper.findAll('button').find((b) => b.text() === 'Suspend Site');
		await button?.trigger('click');
		await vi.waitFor(() =>
			expect(calls.some((c) => c.path === '/api/v1/admin/abuse/abuse_1/suspend')).toBe(true)
		);
	});
});

describe('admin organization page', () => {
	it('shows the counts, plan and subscription of one organization', async () => {
		cleanup = registerApi({
			...ADMIN_ME,
			'GET /api/v1/admin/organizations/org_1': {
				body: {
					id: 'org_1',
					name: 'Ada Labs',
					personal: false,
					createdBy: 'usr_1',
					createdAt: 1,
					members: 3,
					sites: { active: 2 },
					plan: null,
					subscription: null
				}
			}
		});
		const wrapper = await mountSuspended(OrgDetailPage, {
			route: '/admin/orgs/org_1',
			params: { id: 'org_1' }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Ada Labs'));
		expect(wrapper.text()).toContain('No billing record yet');
		expect(wrapper.text()).toContain('Not recorded yet');
	});
});
