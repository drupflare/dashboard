import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LadderPage from '~/pages/admin/ladder.vue';
import { useAdminLadderStore } from '~/stores/admin-ladder';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi } from '../stores/store-support';

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useAdminLadderStore().$reset();
	useSessionStore().me = {
		id: 'usr_admin',
		email: 'admin@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null,
		platformRole: 'admin'
	} as never;
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('admin ladder page', () => {
	it('lists every catalogue row with its reason and the current switches', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': {
				body: {
					id: 'usr_admin',
					email: 'admin@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: null,
					platformRole: 'admin'
				}
			},
			'GET /api/v1/admin/ladder': {
				body: {
					rows: [
						{
							repairId: 'bridge.asyncify_called',
							source: 'worker host tripwire',
							severity: 'critical',
							handle: '/recycle',
							automation: 'auto-with-guard',
							canRunToday: false,
							reason: 'No route on the site worker for this repair yet. It refuses to run.'
						}
					],
					switches: [{ scope: 'global', scopeId: '', auto: true, updatedAt: 1 }]
				}
			}
		});
		const wrapper = await mountSuspended(LadderPage, { route: '/admin/ladder' });
		mounted.push(wrapper);

		await vi.waitFor(() => expect(wrapper.text()).toContain('bridge.asyncify_called'));
		expect(wrapper.text()).toContain('No route on the site worker for this repair yet.');
		expect(wrapper.text()).toContain('global: On');
	});

	it('shows Page Not Found to a person without the admin role', async () => {
		useSessionStore().me = {
			id: 'usr_1',
			email: 'owner@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null,
			platformRole: null
		} as never;
		cleanup = registerApi({
			'GET /api/v1/admin/ladder': { status: 403, body: { code: 'forbidden', message: 'No' } }
		});
		const wrapper = await mountSuspended(LadderPage, { route: '/admin/ladder' });
		mounted.push(wrapper);

		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
		expect(wrapper.text()).not.toContain('Repair Ladder');
	});
});
