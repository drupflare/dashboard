import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SitePage from '~/pages/sites/[id]/index.vue';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

function site(kind: string) {
	return {
		id: 'site_1',
		orgId: 'org_personal',
		name: 'quiet-oak-harbor',
		kind,
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: null,
		state: 'active',
		ring: 'R1',
		primaryHostname: 'quiet-oak-harbor.drupflare.app',
		hostnames: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

let cleanup: () => void = () => undefined;
let siteReply: () => Reply;
let opsReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	siteReply = () => ({ body: site('drupal') });
	opsReply = () => ({
		body: {
			items: [
				{
					id: 'op_1',
					type: 'site.create',
					status: 'succeeded',
					updatedAt: '2026-01-01T00:00:00Z'
				}
			],
			nextCursor: null
		}
	});
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/sites/site_1': () => siteReply(),
		'GET /api/v1/sites/site_1/operations': () => opsReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(SitePage, { route: '/sites/site_1' });
	mounted.push(wrapper);
	return wrapper;
}

describe('site page', () => {
	it('shows the header with name, address and state, and the recent operations', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('h1').text()).toBe('quiet-oak-harbor'));
		expect(wrapper.text()).toContain('quiet-oak-harbor.drupflare.app');
		expect(wrapper.text()).toContain('Active');
		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(1));
		expect(wrapper.text()).toContain('site.create');
		expect(wrapper.text()).toContain('Succeeded');
	});

	it('links Open Admin for a Drupal site', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
		const link = wrapper.find('a[href="https://quiet-oak-harbor.drupflare.app/user/login"]');
		expect(link.exists()).toBe(true);
	});

	it('does not show Open Admin for a kind without a known admin path', async () => {
		siteReply = () => ({ body: site('smoke') });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
		expect(wrapper.text()).not.toContain('Open Admin');
	});

	it('shows Site Not Found for a site the person cannot read', async () => {
		siteReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_404' }
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Site Not Found'));
	});
});
