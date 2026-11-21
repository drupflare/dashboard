import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClientCard from '~/components/agency/client/Card.vue';
import ClientSelect from '~/components/agency/client/Select.vue';
import DelegationForm from '~/components/agency/delegation/Form.vue';
import DelegationList from '~/components/agency/delegation/List.vue';
import TransferFlow from '~/components/agency/transfer/Flow.vue';
import TransferPropose from '~/components/agency/transfer/Propose.vue';
import type { ClientView, DelegationView, TransferView } from '~/shared/agency';
import { useClientsStore } from '~/stores/clients';
import { useOrgStore } from '~/stores/org';
import { useTransfersStore } from '~/stores/transfers';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

let cleanup: () => void = () => undefined;

const TS = '2026-11-01T10:00:00.000Z';
const mounted: { unmount: () => void }[] = [];

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	document.body.replaceChildren();
});

const client: ClientView = {
	id: 'cli_1',
	name: 'Acme Library',
	contactName: 'Pat Lee',
	contactEmail: 'pat@example.org',
	notes: 'Incidents go to the library desk.',
	contractNotes: null,
	siteIds: ['site_aaaa1111'],
	createdAt: TS,
	updatedAt: TS
};

describe('client card', () => {
	it('shows the contact and the sites, and says what is not set', async () => {
		const wrapper = await mountSuspended(ClientCard, {
			props: { client, canManage: true, canGroup: true }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Acme Library');
		expect(wrapper.text()).toContain('pat@example.org');
		expect(wrapper.text()).toContain('site_aaaa1111');
		expect(wrapper.text()).toContain('Not set');
	});

	it('emits edit and removeSite from its buttons', async () => {
		const wrapper = await mountSuspended(ClientCard, {
			props: { client, canManage: true, canGroup: true }
		});
		mounted.push(wrapper);
		await wrapper
			.find('button[aria-label="Remove site_aaaa1111 from Acme Library"]')
			.trigger('click');
		expect(wrapper.emitted('removeSite')).toEqual([['site_aaaa1111']]);
		const edit = wrapper.findAll('button').find((b) => b.text() === 'Edit Client');
		await edit?.trigger('click');
		expect(wrapper.emitted('edit')).toHaveLength(1);
	});

	it('hides the write buttons from a role that cannot change clients', async () => {
		const wrapper = await mountSuspended(ClientCard, {
			props: { client, canManage: false, canGroup: false }
		});
		mounted.push(wrapper);
		expect(wrapper.findAll('button')).toHaveLength(0);
	});
});

const transfer = (over: Partial<TransferView>): TransferView => ({
	id: 'tr_1',
	siteId: 'site_aaaa1111',
	fromOrganizationId: 'org_a',
	toOrganizationId: 'org_b',
	state: 'proposed',
	keepDelegationId: null,
	proposedAt: TS,
	expiresAt: '2026-11-15T10:00:00.000Z',
	decidedAt: null,
	...over
});

const flowProps = (side: 'outgoing' | 'incoming', over: Partial<TransferView> = {}) => ({
	transfer: transfer(over),
	side,
	canAnswer: true,
	canCancel: true,
	canComplete: true
});

describe('transfer flow', () => {
	it('answers a proposal on the receiving side with accept and decline', async () => {
		const wrapper = await mountSuspended(TransferFlow, { props: flowProps('incoming') });
		mounted.push(wrapper);
		const accept = wrapper.findAll('button').find((b) => b.text() === 'Accept Transfer');
		const decline = wrapper.findAll('button').find((b) => b.text() === 'Decline Transfer');
		expect(accept && decline).toBeTruthy();
		await accept?.trigger('click');
		await decline?.trigger('click');
		expect(wrapper.emitted('accept')).toHaveLength(1);
		expect(wrapper.emitted('decline')).toHaveLength(1);
	});

	it('offers cancel to the sending side only, while the proposal is open', async () => {
		const wrapper = await mountSuspended(TransferFlow, { props: flowProps('outgoing') });
		mounted.push(wrapper);
		expect(wrapper.text()).not.toContain('Accept Transfer');
		const cancel = wrapper.findAll('button').find((b) => b.text() === 'Cancel Transfer');
		await cancel?.trigger('click');
		expect(wrapper.emitted('cancel')).toHaveLength(1);
	});

	it('offers complete to the receiving side once the transfer is accepted', async () => {
		const wrapper = await mountSuspended(TransferFlow, {
			props: flowProps('incoming', { state: 'accepted', decidedAt: TS })
		});
		mounted.push(wrapper);
		const complete = wrapper.findAll('button').find((b) => b.text() === 'Complete Transfer');
		await complete?.trigger('click');
		expect(wrapper.emitted('complete')).toHaveLength(1);
	});

	it('says plainly when a proposal expired', async () => {
		const wrapper = await mountSuspended(TransferFlow, {
			props: flowProps('incoming', { state: 'expired' })
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Expired before an answer. Propose the transfer again.');
	});
});

const delegation = (over: Partial<DelegationView>): DelegationView => ({
	id: 'del_1',
	clientOrganizationId: 'org_client',
	agencyOrganizationId: 'org_agency',
	role: 'maintainer',
	sites: 'all',
	state: 'pending',
	createdBy: 'usr_1',
	createdAt: TS,
	expiresAt: null,
	revokedAt: null,
	...over
});

describe('delegation list', () => {
	it('offers accept on a pending delegation received by this agency', async () => {
		const wrapper = await mountSuspended(DelegationList, {
			props: {
				items: [delegation({})],
				direction: 'received',
				canAccept: true,
				canRevoke: true
			}
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Waiting for Acceptance');
		const accept = wrapper.findAll('button').find((b) => b.text() === 'Accept Access');
		await accept?.trigger('click');
		expect(wrapper.emitted('accept')).toEqual([['del_1']]);
	});

	it('does not offer accept on a delegation the client sent', async () => {
		const wrapper = await mountSuspended(DelegationList, {
			props: {
				items: [delegation({ state: 'pending' })],
				direction: 'sent',
				canAccept: true,
				canRevoke: false
			}
		});
		mounted.push(wrapper);
		expect(wrapper.findAll('button')).toHaveLength(0);
	});
});

describe('delegation form', () => {
	it('sends every site when All Sites is on, and the chosen role', async () => {
		const wrapper = await mountSuspended(DelegationForm, {
			props: { busy: false, error: null }
		});
		mounted.push(wrapper);
		await wrapper.find('input[type="text"]').setValue('org_agency');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toEqual([
			[{ agencyOrganizationId: 'org_agency', role: 'viewer', sites: 'all', expiresAt: null }]
		]);
	});

	it('refuses an empty agency and does not emit', async () => {
		const wrapper = await mountSuspended(DelegationForm, {
			props: { busy: false, error: null }
		});
		mounted.push(wrapper);
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toBeUndefined();
		expect(wrapper.text()).toContain('Check the agency organization ID.');
	});
});

describe('site transfer panel', () => {
	const ORG_A = 'org_a';
	const SITE = 'site_aaaa1111';
	const proposed = (over: Partial<TransferView> = {}): TransferView => ({
		id: 'tr_1',
		siteId: SITE,
		fromOrganizationId: ORG_A,
		toOrganizationId: 'org_b',
		state: 'proposed',
		keepDelegationId: null,
		proposedAt: TS,
		expiresAt: '2026-11-15T10:00:00.000Z',
		decidedAt: null,
		...over
	});
	const transfersPath = `/api/v1/orgs/${ORG_A}/transfers`;
	const button = (label: string) =>
		[...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

	beforeEach(() => {
		clearBrowserState();
		useTransfersStore().$reset();
		useOrgStore().$reset();
	});

	afterEach(() => cleanup());

	it('proposes a transfer to the receiving organization ID and reloads the list', async () => {
		cleanup = registerApi({
			[`GET ${transfersPath}`]: { body: { outgoing: [], incoming: [] } },
			[`POST /api/v1/orgs/${ORG_A}/sites/${SITE}/transfers`]: {
				status: 201,
				body: proposed()
			}
		});
		const wrapper = await mountSuspended(TransferPropose, {
			props: { orgId: ORG_A, siteId: SITE, siteName: 'quiet-oak' },
			attachTo: document.body
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(button('Transfer This Site')).toBeDefined());
		button('Transfer This Site')?.click();
		await vi.waitFor(() =>
			expect(document.body.querySelector('#transfer-receiver')).not.toBeNull()
		);
		const input = document.body.querySelector<HTMLInputElement>('#transfer-receiver')!;
		input.value = 'org_b';
		input.dispatchEvent(new Event('input'));
		await vi.waitFor(() => expect(button('Propose Transfer')?.disabled).toBe(false));
		button('Propose Transfer')?.click();
		await vi.waitFor(() =>
			expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
				toOrganizationId: 'org_b'
			})
		);
	});

	it('shows the pending handover and offers Complete only where the person can accept', async () => {
		cleanup = registerApi({
			[`GET ${transfersPath}`]: {
				body: {
					outgoing: [proposed({ state: 'accepted', decidedAt: TS })],
					incoming: []
				}
			}
		});
		useOrgStore().items = [
			{ id: ORG_A, name: 'Sender', personal: false, role: 'admin' },
			{ id: 'org_b', name: 'Receiver', personal: false, role: 'owner' }
		];
		const wrapper = await mountSuspended(TransferPropose, {
			props: { orgId: ORG_A, siteId: SITE, siteName: 'quiet-oak' }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Accepted'));
		expect(wrapper.text()).toContain('Complete Transfer');
	});

	it('hides Complete from a sender who cannot accept at the receiving organization', async () => {
		cleanup = registerApi({
			[`GET ${transfersPath}`]: {
				body: {
					outgoing: [proposed({ state: 'accepted', decidedAt: TS })],
					incoming: []
				}
			}
		});
		useOrgStore().items = [
			{ id: ORG_A, name: 'Sender', personal: false, role: 'admin' },
			{ id: 'org_b', name: 'Receiver', personal: false, role: 'viewer' }
		];
		const wrapper = await mountSuspended(TransferPropose, {
			props: { orgId: ORG_A, siteId: SITE, siteName: 'quiet-oak' }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Accepted'));
		expect(wrapper.text()).not.toContain('Complete Transfer');
	});

	it('shows a proposal waiting for an answer with Cancel Transfer', async () => {
		cleanup = registerApi({
			[`GET ${transfersPath}`]: { body: { outgoing: [proposed()], incoming: [] } }
		});
		const wrapper = await mountSuspended(TransferPropose, {
			props: { orgId: ORG_A, siteId: SITE, siteName: 'quiet-oak' }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Waiting for Answer'));
		expect(wrapper.text()).toContain('Cancel Transfer');
		expect(wrapper.text()).not.toContain('Transfer This Site');
	});
});

describe('site client select', () => {
	const ORG_A = 'org_a';
	const SITE = 'site_aaaa1111';
	const clientsPath = `/api/v1/orgs/${ORG_A}/clients`;
	const client = (id: string, siteIds: string[]): ClientView => ({
		id,
		name: `client ${id}`,
		contactName: null,
		contactEmail: null,
		notes: null,
		contractNotes: null,
		siteIds,
		createdAt: TS,
		updatedAt: TS
	});

	beforeEach(() => {
		clearBrowserState();
		useClientsStore().$reset();
	});

	afterEach(() => cleanup());

	it('shows No Client for a site that no client holds', async () => {
		cleanup = registerApi({
			[`GET ${clientsPath}`]: { body: { items: [client('cli_1', [])] } }
		});
		const wrapper = await mountSuspended(ClientSelect, {
			props: { orgId: ORG_A, siteId: SITE }
		});
		mounted.push(wrapper);
		await vi.waitFor(() =>
			expect(wrapper.findComponent({ name: 'USelect' }).props('modelValue')).toBe('none')
		);
	});

	it('groups the site under a client it is not in yet', async () => {
		cleanup = registerApi({
			[`GET ${clientsPath}`]: { body: { items: [client('cli_1', [])] } },
			[`PUT /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_1`]: {
				body: client('cli_1', [SITE])
			}
		});
		const wrapper = await mountSuspended(ClientSelect, {
			props: { orgId: ORG_A, siteId: SITE }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(useClientsStore().lists.get(ORG_A)?.status).toBe('ready'));
		wrapper.findComponent({ name: 'USelect' }).vm.$emit('update:modelValue', 'cli_1');
		await vi.waitFor(() =>
			expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
				`PUT /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_1`
			)
		);
	});

	it('takes the site off its old client before it joins the new one', async () => {
		cleanup = registerApi({
			[`GET ${clientsPath}`]: {
				body: { items: [client('cli_1', [SITE]), client('cli_2', [])] }
			},
			[`DELETE /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_1`]: {
				body: { deleted: true }
			},
			[`PUT /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_2`]: {
				body: client('cli_2', [SITE])
			}
		});
		const wrapper = await mountSuspended(ClientSelect, {
			props: { orgId: ORG_A, siteId: SITE }
		});
		mounted.push(wrapper);
		await vi.waitFor(() =>
			expect(wrapper.findComponent({ name: 'USelect' }).props('modelValue')).toBe('cli_1')
		);
		wrapper.findComponent({ name: 'USelect' }).vm.$emit('update:modelValue', 'cli_2');
		await vi.waitFor(() =>
			expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(
				expect.arrayContaining([
					`DELETE /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_1`,
					`PUT /api/v1/orgs/${ORG_A}/sites/${SITE}/clients/cli_2`
				])
			)
		);
		const order = calls.map((call) => call.method);
		expect(order.indexOf('DELETE')).toBeLessThan(order.indexOf('PUT'));
	});
});
