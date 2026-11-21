import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CollaboratorsPage from '~/pages/sites/[id]/collaborators.vue';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const SITE = 'site_ffffffffffffffffffff';
const grantsPath = `/api/v1/orgs/${ORG}/sites/${SITE}/grants`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const grants = {
	items: [
		{
			id: 'grt_1',
			userId: 'usr_2',
			email: 'grace@example.test',
			displayName: null,
			role: 'maintainer',
			inOrganization: false,
			expiresAt: null,
			createdAt: '2026-11-01T00:00:00.000Z'
		}
	],
	nextCursor: null
};

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountPage(routes: Parameters<typeof registerApi>[0]) {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: {
				items: [{ id: ORG, name: 'Campus', personal: false, role: 'owner' }],
				nextCursor: null
			}
		},
		...routes
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(CollaboratorsPage, {
		route: `/sites/${SITE}/collaborators`
	});
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useMembersStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	vi.restoreAllMocks();
});

describe('site collaborators page', () => {
	it('lists the people with a role on the site in the path', async () => {
		const wrapper = await mountPage({ [`GET ${grantsPath}`]: { body: grants.items } });
		await vi.waitFor(() => expect(wrapper.text()).toContain('grace@example.test'));
	});

	it('shows the error with a request id when the grants cannot be read', async () => {
		const wrapper = await mountPage({
			[`GET ${grantsPath}`]: failure('internal', 'Something broke', 'req_grants_1')
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('req_grants_1'));
	});
});
