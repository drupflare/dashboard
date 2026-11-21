import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContactsPage from '~/pages/org/contacts.vue';
import type { ContactView } from '~/shared/contacts';
import { useContactsStore } from '~/stores/contacts';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/contacts`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const technical: ContactView = {
	role: 'technical',
	name: 'Ada Lovelace',
	email: 'ada@example.org',
	verifiedAt: '2026-11-01T00:00:00.000Z',
	notifyOn: true,
	updatedAt: '2026-11-01T00:00:00.000Z'
};
const billing: ContactView = {
	role: 'billing',
	name: 'Pat Lee',
	email: 'pat@example.org',
	verifiedAt: null,
	notifyOn: false,
	updatedAt: '2026-11-01T00:00:00.000Z'
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let items: ContactView[] = [technical, billing];
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${base}`]: { body: { items } },
		[`PUT ${base}/billing`]: { body: billing },
		[`POST ${base}/billing/verify`]: { body: billing },
		[`POST ${base}/technical/test`]: {
			body: { sent: true, message: 'The test was sent to the verified contact.' }
		}
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(ContactsPage, { route: '/org/contacts' });
	mounted.push(wrapper);
	return wrapper;
}

const section = (wrapper: VueWrapper, id: string) =>
	wrapper.find(`section[aria-labelledby="contact-${id}"]`);

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

const buttonIn = (wrapper: VueWrapper, id: string, text: string) =>
	section(wrapper, id)
		.findAll('button')
		.find((button) => button.text() === text);

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useContactsStore().$reset();
	role = 'owner';
	items = [technical, billing];
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('organisation contacts page', () => {
	it('shows a section for each role, with the confirmation or test action that applies', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Technical Contact'));
		expect(section(wrapper, 'technical').text()).toContain('confirmed');
		expect(section(wrapper, 'technical').text()).toContain('Send a Test Notification');
		expect(section(wrapper, 'billing').text()).toContain('not confirmed yet');
		expect(section(wrapper, 'billing').text()).toContain('Send Confirmation');
		expect(section(wrapper, 'legal').text()).toContain('No legal contact is set.');
	});

	it('saves a contact on its own path and says it must be confirmed before a test', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(section(wrapper, 'billing').exists()).toBe(true));
		await section(wrapper, 'billing')
			.find<HTMLInputElement>('input[type="email"]')
			.setValue('ap@example.org');
		await section(wrapper, 'billing').find('form').trigger('submit');
		await vi.waitFor(() => expect(count('PUT', `${base}/billing`)).toBe(1));
		expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
			email: 'ap@example.org'
		});
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'Billing contact saved. Confirm the address before a test can send.'
			)
		);
	});

	it('sends a confirmation link to an unconfirmed contact', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(section(wrapper, 'billing').exists()).toBe(true));
		await buttonIn(wrapper, 'billing', 'Send Confirmation')?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('A confirmation link was sent to the billing contact.')
		);
		expect(count('POST', `${base}/billing/verify`)).toBe(1);
	});

	it('shows the answer of a test notice from the server', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(section(wrapper, 'technical').exists()).toBe(true));
		await buttonIn(wrapper, 'technical', 'Send a Test Notification')?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('The test was sent to the verified contact.')
		);
	});

	it('hides the recovery contact form from an admin, who cannot change it', async () => {
		role = 'admin';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(section(wrapper, 'recovery').exists()).toBe(true));
		expect(section(wrapper, 'recovery').text()).toContain(
			'Changing the recovery contact asks you to sign in again first.'
		);
		expect(section(wrapper, 'recovery').find('input[type="email"]').exists()).toBe(false);
	});

	it('shows the recovery contact form to an owner', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(section(wrapper, 'recovery').exists()).toBe(true));
		expect(section(wrapper, 'recovery').find('input[type="email"]').exists()).toBe(true);
	});

	it('says only admins can see contacts, and asks nothing of a viewer', async () => {
		role = 'viewer';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Only Admins Can See Contacts'));
		expect(count('GET', base)).toBe(0);
	});
});
