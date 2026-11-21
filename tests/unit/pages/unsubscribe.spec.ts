import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UnsubscribePage from '~/pages/unsubscribe/[token].vue';
import { useNotificationPreferencesStore } from '~/stores/notification-preferences';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const route = '/api/v1/unsubscribe';
const token = 'abc.def'.repeat(6);

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountAt(path: string) {
	const wrapper = await mountSuspended(UnsubscribePage, { route: path });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useNotificationPreferencesStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('unsubscribe page', () => {
	it('asks first and sends nothing until the button is pressed', async () => {
		cleanup = registerApi({
			[`POST ${route}`]: { body: { unsubscribed: true, category: 'ops' } }
		});
		const wrapper = await mountAt(`/unsubscribe/${token}`);
		expect(wrapper.text()).toContain('Confirm that you want to stop this kind of email');
		expect(calls.some((call) => call.path === route)).toBe(false);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[role="status"]').text()).toContain('Done.'));
		expect(calls.find((call) => call.path === route)?.query).toEqual({ token });
	});

	it('says the link is no longer valid when the server refuses it', async () => {
		cleanup = registerApi({
			[`POST ${route}`]: {
				status: 400,
				body: { code: 'validation', message: 'Old', details: {}, requestId: 'req_1' }
			}
		});
		const wrapper = await mountAt(`/unsubscribe/${token}`);
		await wrapper.find('button').trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('This link is no longer valid.')
		);
	});
});
