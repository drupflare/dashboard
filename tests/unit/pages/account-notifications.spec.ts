import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationsPage from '~/pages/account/notifications.vue';
import type { PreferencesView } from '~/shared/notification-preferences';
import { useNotificationPreferencesStore } from '~/stores/notification-preferences';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const path = '/api/v1/me/notifications';

const view = (ops: boolean): PreferencesView => ({
	switches: [
		{
			category: 'ops',
			label: 'Operations Updates',
			description: 'Findings and results.',
			available: true,
			enabled: ops
		},
		{
			category: 'digest',
			label: 'Daily Summary',
			description: 'Send me a daily summary instead of one email per event.',
			available: false,
			enabled: false
		}
	],
	essential: [
		{
			label: 'Stop Alerts: When a Site Reaches Its Budget',
			description: 'A site at a hard budget stops serving visitors.'
		}
	]
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useNotificationPreferencesStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(NotificationsPage);
	mounted.push(wrapper);
	return wrapper;
}

describe('notifications page', () => {
	it('shows each optional switch, the unavailable summary, and the always-on mail without a switch', async () => {
		cleanup = registerApi({ [`GET ${path}`]: { body: view(false) } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Operations Updates'));
		const switches = wrapper.findAll('input[role="switch"]');
		expect(switches).toHaveLength(1);
		expect((switches[0]?.element as HTMLInputElement).checked).toBe(false);
		expect(wrapper.text()).toContain('Not available yet');
		expect(wrapper.text()).toContain('Stop Alerts: When a Site Reaches Its Budget');
		expect(wrapper.text()).toContain('Always on');
	});

	it('sends the change when a switch is turned on', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: { body: view(false) },
			[`PUT ${path}`]: { body: view(true) }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[role="switch"]').exists()).toBe(true));
		await wrapper.find('input[role="switch"]').setValue(true);
		await vi.waitFor(() =>
			expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
				preferences: { ops: true }
			})
		);
	});

	it('shows the refusal text when a change is not accepted', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: { body: view(false) },
			[`PUT ${path}`]: {
				status: 400,
				body: {
					code: 'validation',
					message: 'Not accepted',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[role="switch"]').exists()).toBe(true));
		await wrapper.find('input[role="switch"]').setValue(true);
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').text()).toBe('Not accepted'));
	});
});
