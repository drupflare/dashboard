import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ClientsPage from '~/pages/org/clients.vue';
import DelegationsPage from '~/pages/org/delegations.vue';
import TransfersPage from '~/pages/org/transfers.vue';
import { useClientsStore } from '~/stores/clients';
import { useDelegationsStore } from '~/stores/delegations';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useTransfersStore } from '~/stores/transfers';
import { clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_agency';
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

let cleanup: () => void = () => undefined;
let role = 'owner';
const mounted: { unmount: () => void }[] = [];

async function mountPage(page: unknown, route: string, routes: Parameters<typeof registerApi>[0]) {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Agency', personal: false, role }], nextCursor: null }
		},
		...routes
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(page as never, { route });
	mounted.push(wrapper as { unmount: () => void });
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useDelegationsStore().$reset();
	useTransfersStore().$reset();
	useClientsStore().$reset();
	role = 'owner';
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('agency access page', () => {
	it('shows the sent and received sections with their empty lines', async () => {
		const wrapper = await mountPage(DelegationsPage, '/org/delegations', {
			[`GET /api/v1/orgs/${ORG}/delegations`]: { body: { sent: [], received: [] } }
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(wrapper.text()).toContain('No Agency Access Yet');
	});

	it('shows a retry when the list cannot load, and keeps the request id', async () => {
		const wrapper = await mountPage(DelegationsPage, '/org/delegations', {
			[`GET /api/v1/orgs/${ORG}/delegations`]: failure('internal', 'Nope', 'req_77')
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Agency Access'));
		expect(wrapper.text()).toContain('req_77');
	});
});

describe('site transfers page', () => {
	it('shows the empty state when no site is moving', async () => {
		const wrapper = await mountPage(TransfersPage, '/org/transfers', {
			[`GET /api/v1/orgs/${ORG}/transfers`]: { body: { outgoing: [], incoming: [] } }
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(wrapper.text()).toContain('No Transfers Yet');
	});
});

describe('client workspaces page', () => {
	it('lists each client with its sites and the write buttons for an owner', async () => {
		const wrapper = await mountPage(ClientsPage, '/org/clients', {
			[`GET /api/v1/orgs/${ORG}/clients`]: {
				body: {
					items: [
						{
							id: 'cli_1',
							name: 'Acme Library',
							contactName: null,
							contactEmail: null,
							notes: null,
							contractNotes: null,
							siteIds: [],
							createdAt: '2026-11-01T10:00:00.000Z',
							updatedAt: '2026-11-01T10:00:00.000Z'
						}
					]
				}
			}
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(wrapper.text()).toContain('Acme Library');
		expect(wrapper.text()).toContain('Add a Client');
	});

	it('says the role cannot see clients, and makes no client request', async () => {
		role = 'billing';
		const wrapper = await mountPage(ClientsPage, '/org/clients', {});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your Role Cannot See Clients'));
	});
});
