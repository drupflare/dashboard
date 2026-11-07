import { mountSuspended } from '@nuxt/test-utils/runtime';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrgSwitcher from '~/components/OrgSwitcher.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { clearBrowserState, registerApi } from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const agency = { id: 'org_agency', name: 'Agency', personal: false, role: 'admin' };

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me/organizations': { body: { items: [personal, agency], nextCursor: null } }
	});
});

afterEach(() => {
	cleanup();
});

describe('OrgSwitcher', () => {
	it('loads the organizations itself when the page did not', async () => {
		const wrapper = await mountSuspended(OrgSwitcher);
		await vi.waitFor(() =>
			expect(wrapper.findAll('option').map((option) => option.text())).toEqual([
				'Personal',
				'Agency'
			])
		);
	});

	it('lists the organizations and drops a stored id that is no longer one of them', async () => {
		document.cookie = 'drupflare_org=org_removed; path=/';
		await useOrgStore().ensure();

		const wrapper = await mountSuspended(OrgSwitcher);
		await flushPromises();

		expect(wrapper.findAll('option').map((option) => option.text())).toEqual([
			'Personal',
			'Agency'
		]);
		expect((wrapper.find('select').element as HTMLSelectElement).value).toBe('org_personal');
	});
});
