import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CodeHistoryPage from '~/pages/sites/[id]/code-history.vue';
import { useReleasesStore } from '~/stores/releases';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const site = {
	id: 'site_1',
	orgId: 'org_personal',
	name: 'quiet-oak-harbor',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'quiet-oak-harbor.drupflare.app',
	hostnames: [],
	admin: { username: 'admin', email: 'owner@example.test', password: 'available' },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

const row = (overrides: object) => ({
	id: 'rev_1',
	kind: 'release',
	release: 'rel-new',
	version: '1.1.0',
	note: null,
	createdAt: 1_790_000_000_000,
	current: false,
	...overrides
});

const base = '/api/v1/orgs/org_personal/sites/site_1';

let cleanup: () => void = () => undefined;
let listReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useReleasesStore().$reset();
	listReply = () => ({
		body: {
			items: [
				row({ id: 'rev_2', release: 'rel-new', version: '1.1.0', current: true }),
				row({ id: 'rev_1', release: 'rel-old', version: '1.0.0' })
			]
		}
	});
	cleanup = registerApi({
		'GET /api/v1/sites/site_1': { body: site },
		[`GET ${base}/revisions`]: () => listReply(),
		[`GET ${base}/rollback-check`]: (call) => ({
			body: {
				siteId: 'site_1',
				release: call.query.release,
				allowed: true,
				reason: null,
				offers: []
			}
		})
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(CodeHistoryPage, { route: '/sites/site_1/code-history' });
	mounted.push(wrapper);
	return wrapper;
}

describe('code history page', () => {
	it('lists the releases, marks the one running and offers a roll back on the others', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Release 1.1.0'));
		expect(wrapper.text()).toContain('Release 1.0.0');
		expect(wrapper.text()).toContain('Running Now');
		const rollBacks = wrapper
			.findAll('button')
			.filter((button) => button.text() === 'Roll Back');
		expect(rollBacks).toHaveLength(1);
	});

	it('opens the roll back check for the release that was chosen', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Release 1.0.0'));
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Roll Back')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Roll Back the Code'));
		expect(calls.find((call) => call.path === `${base}/rollback-check`)?.query).toEqual({
			release: 'rel-old'
		});
	});

	it('shows an edit with its note and no roll back', async () => {
		listReply = () => ({
			body: {
				items: [
					row({
						id: 'rev_3',
						kind: 'edit',
						release: null,
						version: null,
						note: 'Fixed a template'
					})
				]
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Fixed a template'));
		expect(wrapper.text()).not.toContain('Roll Back');
	});

	it('shows the empty state for a site with no history', async () => {
		listReply = () => ({ body: { items: [] } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No History Yet'));
	});

	it('shows the error with its request ID', async () => {
		listReply = () => failure('internal', 'failed', 'req_hist');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the History'));
		expect(wrapper.text()).toContain('req_hist');
	});
});
