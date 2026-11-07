import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CallbackPage from '~/pages/auth/callback.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
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

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountAt(query: string) {
	const wrapper = await mountSuspended(CallbackPage, { route: `/auth/callback${query}` });
	mounted.push(wrapper);
	return wrapper;
}

describe('auth callback page', () => {
	it('finishes the provider sign-in named by the state and goes to the sites page', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth/github/callback': {
				body: {
					status: 'signed_in',
					user: { id: 'usr_1', email: me.email, displayName: null },
					isNew: false
				}
			},
			'GET /api/v1/me': { body: me }
		});
		await mountAt('?code=abc&state=github.token');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sites'));
		const call = calls.find((c) => c.path === '/api/v1/auth/oauth/github/callback');
		expect(call?.query).toMatchObject({ code: 'abc', state: 'github.token' });
	});

	it('says the account exists when the provider email matches one, and merges nothing', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth/github/callback': {
				body: { status: 'link_required', provider: 'github', email: me.email }
			}
		});
		const wrapper = await mountAt('?code=abc&state=github.token');
		await vi.waitFor(() => expect(wrapper.text()).toContain('already exists'));
		expect(wrapper.text()).toContain(me.email);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows the server message when the sign-in fails', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth/github/callback': {
				status: 401,
				body: {
					code: 'unauthenticated',
					message: 'The sign-in could not be completed',
					details: {},
					requestId: 'req_cb'
				}
			}
		});
		const wrapper = await mountAt('?code=abc&state=github.token');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain(
				'The sign-in could not be completed'
			)
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('asks to start again, without calling the server, when the link is incomplete', async () => {
		cleanup = registerApi({});
		const wrapper = await mountAt('?code=abc&state=nobody.token');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(calls).toHaveLength(0);
	});
});
