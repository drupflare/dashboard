import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProcurementPage from '~/pages/org/procurement.vue';
import type { ProcurementView } from '~/shared/procurement';
import { useOrgStore } from '~/stores/org';
import { useProcurementStore } from '~/stores/procurement';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/procurement`;
const me = {
	id: 'usr_1',
	email: 'member@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const record: ProcurementView = {
	id: 'pr_1',
	kind: 'quote',
	reference: 'Q-1042',
	signatory: null,
	amount: '1200',
	issuedOn: '2026-03-02',
	dueOn: null,
	notes: null,
	createdAt: '2026-03-02T00:00:00.000Z',
	updatedAt: '2026-03-02T00:00:00.000Z'
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let items: ProcurementView[] = [record];
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${base}`]: { body: { items } },
		[`POST ${base}`]: { status: 201, body: record },
		[`PUT ${base}/pr_1`]: { body: record }
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(ProcurementPage, { route: '/org/procurement' });
	mounted.push(wrapper);
	return wrapper;
}

// the form labels wrap their control, so the control is found from its label text
const control = (wrapper: VueWrapper, label: string) =>
	wrapper
		.findAll('label')
		.find((node) => node.text().startsWith(label))!
		.find<HTMLInputElement>('input, select, textarea');

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useProcurementStore().$reset();
	role = 'owner';
	items = [record];
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('procurement page', () => {
	it('lists the records as typed and links the CSV export of the organisation', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Quote Q-1042'));
		expect(wrapper.text()).toContain('1200, 2026-03-02');
		expect(wrapper.find(`a[href="${base}/export"]`).text()).toBe('Download as CSV');
	});

	it('records a document with only the required fields, and leaves the optional ones out', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Add a Record'));
		await control(wrapper, 'Reference').setValue('PO-7');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(count('POST', base)).toBe(1));
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
			kind: 'po',
			reference: 'PO-7'
		});
	});

	it('loads a record into the form and changes it through its id', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Quote Q-1042'));
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Edit Q-1042')
			?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Edit a Record'));
		expect(control(wrapper, 'Reference').element.value).toBe('Q-1042');

		await control(wrapper, 'Reference').setValue('Q-1042-R');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(count('PUT', `${base}/pr_1`)).toBe(1));
		expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
			kind: 'quote',
			reference: 'Q-1042-R'
		});
	});

	it('shows the records to an admin without the form, since an admin cannot record them', async () => {
		role = 'admin';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Quote Q-1042'));
		expect(wrapper.text()).not.toContain('Add a Record');
	});

	it('says the records are for owners, admins and billing, and asks nothing of a viewer', async () => {
		role = 'viewer';
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Only Owners, Admins and Billing Can See Procurement')
		);
		expect(count('GET', base)).toBe(0);
		expect(wrapper.find('form').exists()).toBe(false);
	});

	it('says there are no records yet when the list is empty', async () => {
		items = [];
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No procurement records yet.'));
	});
});
