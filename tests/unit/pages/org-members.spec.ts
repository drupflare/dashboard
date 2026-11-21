import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MembersPage from '~/pages/org/members.vue';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const membersKey = `GET /api/v1/orgs/${ORG}/members`;
const invitesKey = `GET /api/v1/orgs/${ORG}/invites`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const members = {
	items: [
		{
			id: 'mem_1',
			userId: 'usr_1',
			email: 'owner@example.test',
			displayName: 'Ada',
			role: 'owner',
			joinedAt: '2026-02-01T00:00:00.000Z'
		}
	],
	nextCursor: null
};

const invites = {
	items: [
		{
			id: 'inv_1',
			email: 'grace@example.test',
			role: 'viewer',
			expiresAt: '2026-12-01T00:00:00.000Z',
			createdAt: '2026-11-20T00:00:00.000Z'
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
	const wrapper = await mountSuspended(MembersPage, { route: '/org/members' });
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

describe('organization members page', () => {
	it('lists each member and each pending invitation, and reads both for an owner', async () => {
		const wrapper = await mountPage({
			[membersKey]: { body: members },
			[invitesKey]: { body: invites.items }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Ada'));
		expect(wrapper.text()).toContain('owner@example.test');
		await vi.waitFor(() => expect(wrapper.text()).toContain('grace@example.test'));
		expect(
			calls.some((call) => call.method === 'GET' && call.path === invitesKey.slice(4))
		).toBe(true);
	});

	it('shows the error with a request id when the members cannot be read', async () => {
		const wrapper = await mountPage({
			[membersKey]: failure('internal', 'Something broke', 'req_members_1')
		});
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path.endsWith('/members'))).toBe(true)
		);
		await vi.waitFor(() => expect(wrapper.text()).toContain('req_members_1'));
	});
});
