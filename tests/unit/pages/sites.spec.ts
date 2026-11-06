import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SitesPage from '~/pages/sites/index.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const sitesKey = `GET /api/v1/orgs/${personal.id}/sites`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

function site(id: string, state: 'active' | 'suspended' = 'active') {
	return {
		id,
		orgId: personal.id,
		name: `Site ${id}`,
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: null,
		state,
		ring: 'R1',
		primaryHostname: `${id}.example.test`,
		hostnames: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

let cleanup: () => void = () => undefined;
let sitesReply: () => Reply | Promise<Reply>;

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
	sitesReply = () => ({ body: { items: [], nextCursor: null } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[sitesKey]: () => sitesReply()
	});
	await useOrgStore().ensure();
});

const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	const wrapper = await mountSuspended(SitesPage, { route: '/sites' });
	mounted.push(wrapper);
	return wrapper;
}

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('sites page', () => {
	it('shows a loading state until the first page arrives', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		sitesReply = async () => {
			await gate;
			return { body: { items: [], nextCursor: null } };
		};

		const wrapper = await mountPage();
		expect(wrapper.text()).toContain('Loading sites...');

		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Sites Yet'));
	});

	it('shows an empty state with a link to create a site', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('No Sites Yet'));
		expect(wrapper.find('a[href="/new"]').exists()).toBe(true);
	});

	it('lists each site in the table and as a card, with status as icon and text', async () => {
		sitesReply = () => ({
			body: { items: [site('site_1'), site('site_2', 'suspended')], nextCursor: null }
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));
		expect(wrapper.findAll('ul > li')).toHaveLength(2);
		expect(wrapper.text()).toContain('Suspended');
		expect(wrapper.html()).toContain('circle-pause');
		expect(wrapper.html()).toContain('circle-check');
	});

	it('shows the error with a request id, then recovers on retry', async () => {
		sitesReply = () => failure('internal', 'Failed', 'req_list');
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Sites'));
		expect(wrapper.text()).toContain('req_list');

		sitesReply = () => ({ body: { items: [site('site_1')], nextCursor: null } });
		await wrapper.find('button').trigger('click');

		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(1));
	});
});
