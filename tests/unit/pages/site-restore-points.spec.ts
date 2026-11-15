import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RestorePointsPage from '~/pages/sites/[id]/restore-points.vue';
import { useBackupsStore } from '~/stores/backups';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

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

const pitrLayer = {
	layer: 'pitr',
	windowDays: 30,
	moves: ['The site database at a chosen moment'],
	doesNotMove: ['Uploaded files']
};

const copy = {
	id: 'rp_1',
	layer: 'export',
	createdAt: '2026-11-01T12:00:00.000Z',
	label: null,
	verified: true,
	moves: ['The site database as it stood'],
	doesNotMove: ['Uploaded files']
};

const listPath = '/api/v1/orgs/org_personal/sites/site_1/restore-points';

let cleanup: () => void = () => undefined;
let listReply: () => Reply | Promise<Reply>;
let siteReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useBackupsStore().$reset();
	siteReply = () => ({ body: site });
	listReply = () => ({ body: { items: [copy], nextCursor: null, layers: [pitrLayer] } });
	cleanup = registerApi({
		'GET /api/v1/sites/site_1': () => siteReply(),
		[`GET ${listPath}`]: () => listReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(RestorePointsPage, {
		route: '/sites/site_1/restore-points'
	});
	mounted.push(wrapper);
	return wrapper;
}

describe('restore points page', () => {
	it('lists the saved copies and the moment restore, with its button', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Saved Copy'));
		expect(wrapper.text()).toContain('Point in Time');
		expect(wrapper.text()).toContain('Restore to a Moment');
	});

	it('hides the moment restore button when no moment layer is offered', async () => {
		listReply = () => ({ body: { items: [copy], nextCursor: null, layers: [] } });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Saved Copy'));
		expect(wrapper.text()).not.toContain('Restore to a Moment');
	});

	it('shows the empty state when there are no copies and no moment layer', async () => {
		listReply = () => ({ body: { items: [], nextCursor: null, layers: [] } });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('No Restore Points Yet'));
	});

	it('shows the error with its request ID, and reloads on Try Again', async () => {
		let fail = true;
		listReply = () =>
			fail
				? failure('internal', 'failed', 'req_rp')
				: { body: { items: [copy], nextCursor: null, layers: [] } };
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Restore Points'));
		expect(wrapper.text()).toContain('req_rp');

		fail = false;
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Try Again')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Saved Copy'));
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
