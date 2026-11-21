import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InviteView, MemberView, SiteGrantView } from '~/shared/members';
import { useMembersStore } from '~/stores/members';
import { calls, clearBrowserState, registerApi } from './store-support';

const ORG = 'org_personal';
const SITE = 'site_one';
const membersKey = `GET /api/v1/orgs/${ORG}/members`;
const invitesKey = `GET /api/v1/orgs/${ORG}/invites`;
const grantsKey = `GET /api/v1/orgs/${ORG}/sites/${SITE}/grants`;

const member = (id: string, over: Partial<MemberView> = {}): MemberView => ({
	id,
	userId: `user_${id}`,
	email: `${id}@example.test`,
	displayName: null,
	role: 'viewer',
	joinedAt: '2026-11-01T10:00:00.000Z',
	...over
});

const invite = (id: string): InviteView => ({
	id,
	email: `${id}@example.test`,
	role: 'developer',
	expiresAt: '2026-11-08T10:00:00.000Z',
	createdAt: '2026-11-01T10:00:00.000Z'
});

const grant = (id: string): SiteGrantView => ({
	id,
	userId: `user_${id}`,
	email: `${id}@example.test`,
	displayName: null,
	role: 'viewer',
	inOrganization: false,
	expiresAt: null,
	createdAt: '2026-11-01T10:00:00.000Z'
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useMembersStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('members store', () => {
	it('stays not loaded until the list is read', () => {
		expect(useMembersStore().members.get(ORG)).toBeUndefined();
	});

	it('appends the next page and sends the cursor', async () => {
		cleanup = registerApi({
			[membersKey]: (call) =>
				call.query.cursor === undefined
					? { body: { items: [member('a')], nextCursor: 'a' } }
					: { body: { items: [member('b')], nextCursor: null } }
		});
		const store = useMembersStore();
		await store.loadMembers(ORG);
		await store.loadMoreMembers(ORG);
		expect(store.members.get(ORG)?.items.map((item) => item.id)).toEqual(['a', 'b']);
		expect(calls.map((call) => call.query.cursor)).toEqual([undefined, 'a']);
	});

	it('marks an organization it cannot see as null', async () => {
		cleanup = registerApi({
			[membersKey]: {
				status: 404,
				body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_404' }
			}
		});
		const store = useMembersStore();
		await store.loadMembers(ORG);
		expect(store.members.get(ORG)).toBeNull();
	});

	it('replaces a changed role in place', async () => {
		cleanup = registerApi({
			[membersKey]: { body: { items: [member('a')], nextCursor: null } },
			[`PUT /api/v1/orgs/${ORG}/members/a/role`]: {
				body: member('a', { role: 'developer' })
			}
		});
		const store = useMembersStore();
		await store.loadMembers(ORG);
		await store.changeRole(ORG, 'a', { role: 'developer' });
		expect(store.members.get(ORG)?.items[0]?.role).toBe('developer');
	});

	it('drops a removed member from the list', async () => {
		cleanup = registerApi({
			[membersKey]: { body: { items: [member('a'), member('b')], nextCursor: null } },
			[`DELETE /api/v1/orgs/${ORG}/members/a`]: { status: 204, body: null }
		});
		const store = useMembersStore();
		await store.loadMembers(ORG);
		await store.removeMember(ORG, 'a');
		expect(store.members.get(ORG)?.items.map((item) => item.id)).toEqual(['b']);
	});

	it('keeps the invitation list apart from the member list', async () => {
		cleanup = registerApi({
			[invitesKey]: { body: [invite('i1'), invite('i2')] },
			[`POST /api/v1/orgs/${ORG}/invites/i1/revoke`]: { status: 204, body: null }
		});
		const store = useMembersStore();
		await store.loadInvites(ORG);
		await store.revokeInvite(ORG, 'i1');
		expect(store.invites.get(ORG)?.items.map((item) => item.id)).toEqual(['i2']);
		expect(store.members.get(ORG)).toBeUndefined();
	});

	it('loads site collaborators per site', async () => {
		cleanup = registerApi({ [grantsKey]: { body: [grant('g1')] } });
		const store = useMembersStore();
		await store.loadGrants(ORG, SITE);
		expect(store.grants.get(`${ORG}/${SITE}`)?.items).toEqual([grant('g1')]);
	});
});
