import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmPage from '~/pages/contacts/confirm.vue';
import { useContactsStore } from '~/stores/contacts';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const token = 'x'.repeat(40);
const confirmPath = '/api/v1/contacts/confirm';

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountAt(route: string) {
	const wrapper = await mountSuspended(ConfirmPage, { route });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useContactsStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('contact confirmation page', () => {
	it('confirms the address from the link in the mail', async () => {
		cleanup = registerApi({ [`POST ${confirmPath}`]: { body: { verified: true } } });
		const wrapper = await mountAt(`/contacts/confirm?token=${token}`);
		await vi.waitFor(() =>
			expect(wrapper.find('[role="status"]').text()).toBe(
				'This address is confirmed. You can close this page.'
			)
		);
		expect(calls.find((call) => call.path === confirmPath)?.body).toEqual({ token });
	});

	it('says the link is no longer valid when the server refuses it', async () => {
		cleanup = registerApi({
			[`POST ${confirmPath}`]: {
				status: 400,
				body: {
					code: 'validation',
					message: 'This link is no longer valid. Ask for a new one.',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountAt(`/contacts/confirm?token=${token}`);
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('This link is no longer valid.')
		);
	});

	it('does not call the server for a token too short to be a real link', async () => {
		cleanup = registerApi({ [`POST ${confirmPath}`]: { body: { verified: true } } });
		const wrapper = await mountAt('/contacts/confirm?token=short');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(calls.some((call) => call.path === confirmPath)).toBe(false);
	});

	it('says the link is no longer valid when the page has no token', async () => {
		cleanup = registerApi({ [`POST ${confirmPath}`]: { body: { verified: true } } });
		const wrapper = await mountAt('/contacts/confirm');
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true));
		expect(calls.some((call) => call.path === confirmPath)).toBe(false);
	});
});
