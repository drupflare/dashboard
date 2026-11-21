import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClientView, DelegationView, TransferView } from '~/shared/agency';
import { useClientsStore } from '~/stores/clients';
import { useDelegationsStore } from '~/stores/delegations';
import { useTransfersStore } from '~/stores/transfers';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const ORG = 'org_agency';
const TS = '2026-11-01T10:00:00.000Z';

const delegation = (id: string, over: Partial<DelegationView> = {}): DelegationView => ({
	id,
	clientOrganizationId: 'org_client',
	agencyOrganizationId: ORG,
	role: 'viewer',
	sites: 'all',
	state: 'active',
	createdBy: 'usr_1',
	createdAt: TS,
	expiresAt: null,
	revokedAt: null,
	...over
});

const transfer = (id: string, over: Partial<TransferView> = {}): TransferView => ({
	id,
	siteId: 'site_aaaa1111',
	fromOrganizationId: 'org_client',
	toOrganizationId: ORG,
	state: 'accepted',
	keepDelegationId: null,
	proposedAt: TS,
	expiresAt: '2026-11-15T10:00:00.000Z',
	decidedAt: TS,
	...over
});

const client = (id: string, over: Partial<ClientView> = {}): ClientView => ({
	id,
	name: `client ${id}`,
	contactName: null,
	contactEmail: null,
	notes: null,
	contractNotes: null,
	siteIds: [],
	createdAt: TS,
	updatedAt: TS,
	...over
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useDelegationsStore().$reset();
	useTransfersStore().$reset();
	useClientsStore().$reset();
});

afterEach(() => cleanup());

describe('delegations store', () => {
	it('stays not loaded until the lists are read', () => {
		expect(useDelegationsStore().lists.get(ORG)).toBeUndefined();
	});

	it('loads sent and received lists and keeps them as loaded', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/delegations`]: {
				body: { sent: [], received: [delegation('del_1')] }
			}
		});
		const store = useDelegationsStore();
		await store.load(ORG);
		expect(store.lists.get(ORG)).toMatchObject({
			status: 'ready',
			data: { sent: [], received: [{ id: 'del_1' }] }
		});
	});

	it('keeps an unknown organization as null, not as an empty list', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/delegations`]: { status: 404, body: { code: 'not_found' } }
		});
		await useDelegationsStore().load(ORG);
		expect(useDelegationsStore().lists.get(ORG)).toBeNull();
	});

	it('keeps the failure with its request id, so the page can say what went wrong', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/delegations`]: failure('internal', 'Something broke', 'req_1')
		});
		await useDelegationsStore().load(ORG);
		expect(useDelegationsStore().lists.get(ORG)).toMatchObject({
			status: 'error',
			error: { requestId: 'req_1' }
		});
	});

	it('accepts a batch and then reads the lists again', async () => {
		let reads = 0;
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/delegations`]: () => {
				reads += 1;
				return { body: { sent: [], received: [] } };
			},
			[`POST /api/v1/orgs/${ORG}/delegations/del_1/accept`]: { body: delegation('del_1') }
		});
		const store = useDelegationsStore();
		await store.load(ORG);
		await store.accept(ORG, 'del_1');
		expect(reads).toBe(2);
		expect(calls.some((call) => call.path.endsWith('/del_1/accept'))).toBe(true);
	});
});

describe('transfers store', () => {
	it('completes an accepted transfer and reads the lists again', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/transfers`]: {
				body: { outgoing: [], incoming: [transfer('tr_1')] }
			},
			[`POST /api/v1/orgs/${ORG}/transfers/tr_1/complete`]: {
				body: transfer('tr_1', { state: 'completed' })
			}
		});
		const store = useTransfersStore();
		await store.load(ORG);
		await store.complete(ORG, 'tr_1');
		const reads = calls.filter((call) => call.method === 'GET');
		expect(reads).toHaveLength(2);
	});

	it('keeps an unknown organization as null', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/transfers`]: { status: 404, body: { code: 'not_found' } }
		});
		await useTransfersStore().load(ORG);
		expect(useTransfersStore().lists.get(ORG)).toBeNull();
	});
});

describe('clients store', () => {
	it('loads the client list with its sites', async () => {
		cleanup = registerApi({
			[`GET /api/v1/orgs/${ORG}/clients`]: {
				body: { items: [client('cli_1', { siteIds: ['site_aaaa1111'] })] }
			}
		});
		const store = useClientsStore();
		await store.load(ORG);
		expect(store.lists.get(ORG)).toMatchObject({
			status: 'ready',
			items: [{ id: 'cli_1', siteIds: ['site_aaaa1111'] }]
		});
	});

	it('groups a site under a client through the site route', async () => {
		cleanup = registerApi({
			[`PUT /api/v1/orgs/${ORG}/sites/site_aaaa1111/clients/cli_1`]: {
				body: client('cli_1')
			},
			[`GET /api/v1/orgs/${ORG}/clients`]: { body: { items: [] } }
		});
		await useClientsStore().addSite(ORG, 'site_aaaa1111', 'cli_1');
		expect(calls[0]).toMatchObject({
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/sites/site_aaaa1111/clients/cli_1`
		});
	});

	it('removes a site from a client through the site route', async () => {
		cleanup = registerApi({
			[`DELETE /api/v1/orgs/${ORG}/sites/site_aaaa1111/clients/cli_1`]: {
				body: { deleted: true }
			},
			[`GET /api/v1/orgs/${ORG}/clients`]: { body: { items: [] } }
		});
		await useClientsStore().removeSite(ORG, 'site_aaaa1111', 'cli_1');
		expect(calls[0]).toMatchObject({
			method: 'DELETE',
			path: `/api/v1/orgs/${ORG}/sites/site_aaaa1111/clients/cli_1`
		});
	});
});
