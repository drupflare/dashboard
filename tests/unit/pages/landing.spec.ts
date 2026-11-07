import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import IndexPage from '~/pages/index.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
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
	const wrapper = await mountSuspended(IndexPage, { route: '/' });
	mounted.push(wrapper);
	return wrapper;
}

describe('landing page', () => {
	it('shows the product and a way to start to a signed-out visitor', async () => {
		const wrapper = await mountPage();
		expect(wrapper.find('h1').text()).toBe('Drupal Without the Server');
		expect(wrapper.find('a[href="/login"]').exists()).toBe(true);
		expect(wrapper.find('#how').exists()).toBe(true);
		await vi.waitFor(() => expect(useSessionStore().me).toBe(null));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('sends a signed-in visitor to the sites page', async () => {
		signedIn = true;
		await mountPage();
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sites'));
	});

	it('lists what is not built, so it claims no feature the dashboard lacks', async () => {
		const text = (await mountPage()).text();
		expect(text).toContain('Not Built Yet');
		for (const planned of ['custom domains', 'WordPress', 'Joomla']) {
			expect(text).toContain(planned);
		}
	});
});
