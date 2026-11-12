import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SecurityPage from '~/pages/account/security.vue';
import { usePasskeysStore } from '~/stores/passkeys';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi } from '../stores/store-support';

vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn() }));

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	usePasskeysStore().$reset();
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	};
	cleanup = registerApi({
		'GET /api/v1/me/passkeys': {
			body: {
				items: [
					{
						id: 'pk_1',
						name: 'Work Laptop',
						deviceType: 'multiDevice',
						backedUp: true,
						createdAt: '2026-11-01T10:00:00.000Z',
						lastUsedAt: null
					}
				],
				nextCursor: null
			}
		}
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('security page', () => {
	it('lists the passkeys with the add action above them', async () => {
		const wrapper = await mountSuspended(SecurityPage, { route: '/account/security' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Work Laptop'));
		expect(wrapper.text()).toContain('Add a Passkey');
		expect(wrapper.text()).toContain('Never used');
	});
});
