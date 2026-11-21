import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import inviteAccept from '../../../../src/server/api/v1/invites/accept.post';
import inviteRevoke from '../../../../src/server/api/v1/orgs/[orgId]/invites/[inviteId]/revoke.post';
import inviteCreate from '../../../../src/server/api/v1/orgs/[orgId]/invites/index.post';
import memberRemove from '../../../../src/server/api/v1/orgs/[orgId]/members/[memberId].delete';
import memberRole from '../../../../src/server/api/v1/orgs/[orgId]/members/[memberId]/role.put';
import membersList from '../../../../src/server/api/v1/orgs/[orgId]/members/index.get';
import grantCreate from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/grants/index.post';
import { createUser } from '../../../../src/server/db/repos/identity';
import {
	addMember,
	listMembers,
	listPendingInvites
} from '../../../../src/server/db/repos/organization';
import { setMembersServices, type InviteMail } from '../../../../src/server/services/members';
import { setSiteGrantServices } from '../../../../src/server/services/site-grants';
import { resetApiDeps, type Loaded, type LoadInput } from '../../../../src/server/utils/define-api';
import { DEPT, facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asKey, asOtherUser, asUser, send, setup } from '../fixtures/harness';
import { sqliteClient } from '../fixtures/sqlite-client';

const MEMBERS = '/api/v1/orgs/:orgId/members';
const INVITES = '/api/v1/orgs/:orgId/invites';
const ACCEPT = '/api/v1/invites/accept';
const GRANTS = '/api/v1/orgs/:orgId/sites/:id/grants';

let db: CollegeDBClient;
let owner: { id: string };
let other: { id: string; email: string };
let inviteMail: Mock<InviteMail>;

// the bearer key is issued by the owner; the cookies name the two signed-in people
function identities() {
	return {
		resolvePrincipal: async (credential: { kind: string; cookies?: Record<string, string> }) =>
			credential.kind === 'bearer'
				? { kind: 'key' as const, keyId: 'key-1', issuerId: owner.id }
				: {
						kind: 'user' as const,
						userId: credential.cookies?.session === 'token-b' ? other.id : owner.id
					}
	};
}

const SITE_IN = `site_${'f'.repeat(20)}`;
const SITE_OUT = `site_${'9'.repeat(20)}`;

// the harness knows only short site ids; these are the ids the site route validates
function live(role: 'owner' | 'admin' | 'viewer' = 'owner') {
	return setup({
		role,
		deps: {
			...identities(),
			load: async (input: LoadInput): Promise<Loaded | null> => {
				const resource: Loaded['resource'] = {};
				if (input.scope === 'site') {
					const orgId =
						input.params.id === SITE_IN
							? ORG
							: input.params.id === SITE_OUT
								? OTHER_ORG
								: null;
					if (orgId === null) return null;
					Object.assign(resource, { orgId, siteId: input.params.id, departmentId: DEPT });
				} else if (input.scope === 'organization') {
					const orgId = input.params.orgId;
					if (orgId !== ORG && orgId !== OTHER_ORG) return null;
					Object.assign(resource, { orgId, departmentId: DEPT });
				}
				const key =
					input.principal.kind === 'key'
						? { key: { id: 'key-1', scopes: ['member.read'] } }
						: {};
				return { resource, facts: facts({ ...member(role), ...fresh, ...key }) };
			}
		}
	});
}

// the invite link is the only place the token leaves the server
function tokenFromMail(): string {
	const call = inviteMail.mock.calls.at(-1);
	const url = (call?.[1] as { acceptUrl: string }).acceptUrl;
	return url.slice(url.indexOf('/invite/') + '/invite/'.length);
}

beforeEach(async () => {
	({ client: db } = sqliteClient());
	owner = await createUser(db, { email: 'owner@example.test' });
	other = await createUser(db, { email: 'invitee@example.test' });
	await addMember(db, ORG, { userId: owner.id, role: 'owner' });
	inviteMail = vi.fn<InviteMail>(async () => undefined);
	setMembersServices({
		getDb: async () => db,
		audit: async () => undefined,
		inviteMail,
		baseUrl: 'https://app.example.test',
		now: Date.now
	});
	setSiteGrantServices({ getDb: async () => db, audit: async () => undefined, now: Date.now });
});

afterEach(() => {
	setMembersServices(null);
	setSiteGrantServices(null);
	resetApiDeps();
});

describe('members', () => {
	it('refuses the member list of another organisation before it reads anything', async () => {
		live();
		const reply = await send(membersList, MEMBERS, {
			path: `/api/v1/orgs/${OTHER_ORG}/members`,
			headers: asUser
		});
		expect([403, 404]).toContain(reply.status);
		expect(reply.text).not.toContain('owner@example.test');
	});

	it('lists only the members of the organisation in the path', async () => {
		live();
		const stranger = await createUser(db, { email: 'stranger@example.test' });
		await addMember(db, OTHER_ORG, { userId: stranger.id, role: 'viewer' });
		const reply = await send(membersList, MEMBERS, {
			path: `/api/v1/orgs/${ORG}/members`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const emails = (reply.json as { items: { email: string }[] }).items.map(
			(item) => item.email
		);
		expect(emails).toEqual(['owner@example.test']);
	});

	it('refuses to demote the last owner through the role route', async () => {
		live();
		const ownerMember = (await listMembers(db, ORG, { limit: 10 })).items[0]!;
		const reply = await send(memberRole, '/api/v1/orgs/:orgId/members/:memberId/role', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/members/${ownerMember.id}/role`,
			headers: asUser,
			json: { role: 'admin' }
		});
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'last_owner' } });
		expect((await listMembers(db, ORG, { limit: 10 })).items[0]!.role).toBe('owner');
	});

	it('refuses an admin who gives the admin role to someone', async () => {
		live('admin');
		const target = await createUser(db, { email: 'viewer@example.test' });
		const added = await addMember(db, ORG, { userId: target.id, role: 'viewer' });
		const reply = await send(memberRole, '/api/v1/orgs/:orgId/members/:memberId/role', {
			method: 'PUT',
			path: `/api/v1/orgs/${ORG}/members/${added.id}/role`,
			headers: asUser,
			json: { role: 'admin' }
		});
		expect(reply.status).toBe(403);
	});

	it('removes a member and answers 204', async () => {
		live();
		const target = await createUser(db, { email: 'viewer@example.test' });
		const added = await addMember(db, ORG, { userId: target.id, role: 'viewer' });
		const reply = await send(memberRemove, '/api/v1/orgs/:orgId/members/:memberId', {
			method: 'DELETE',
			path: `/api/v1/orgs/${ORG}/members/${added.id}`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(204);
		const ids = (await listMembers(db, ORG, { limit: 10 })).items.map((m) => m.id);
		expect(ids).not.toContain(added.id);
	});

	it('refuses to remove the last owner', async () => {
		live();
		const ownerMember = (await listMembers(db, ORG, { limit: 10 })).items[0]!;
		const reply = await send(memberRemove, '/api/v1/orgs/:orgId/members/:memberId', {
			method: 'DELETE',
			path: `/api/v1/orgs/${ORG}/members/${ownerMember.id}`,
			headers: asUser,
			json: {}
		});
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'last_owner' } });
	});
});

describe('invites', () => {
	it('refuses an invitation from a viewer', async () => {
		live('viewer');
		const reply = await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'new@example.test', role: 'viewer' }
		});
		expect(reply.status).toBe(403);
		expect(inviteMail).not.toHaveBeenCalled();
	});

	it('refuses an admin who invites an admin, and never offers the owner role', async () => {
		live('admin');
		const asAdmin = await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'new@example.test', role: 'admin' }
		});
		expect(asAdmin.status).toBe(403);
		const asOwner = await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'new@example.test', role: 'owner' }
		});
		expect(asOwner.status).toBe(400);
		expect(inviteMail).not.toHaveBeenCalled();
	});

	it('mails the link and keeps the token out of the reply', async () => {
		live();
		const reply = await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'new@example.test', role: 'viewer' }
		});
		expect(reply.status).toBe(201);
		expect(reply.text).not.toContain('dfi_');
		expect(inviteMail).toHaveBeenCalledTimes(1);
		expect(tokenFromMail()).toMatch(new RegExp(`^dfi_${ORG}\\.`));
	});

	it('stops the link when the invitation is revoked', async () => {
		live();
		await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'invitee@example.test', role: 'viewer' }
		});
		const token = tokenFromMail();
		const [invite] = await listPendingInvites(db, ORG);
		const revoked = await send(inviteRevoke, '/api/v1/orgs/:orgId/invites/:inviteId/revoke', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites/${invite!.id}/revoke`,
			headers: asUser,
			json: {}
		});
		expect(revoked.status).toBe(204);
		const reply = await send(inviteAccept, ACCEPT, {
			method: 'POST',
			path: ACCEPT,
			headers: asOtherUser,
			json: { token }
		});
		expect(reply.status).toBe(404);
	});

	it('refuses acceptance by an API key and leaves the invitation pending', async () => {
		live();
		await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'invitee@example.test', role: 'viewer' }
		});
		const reply = await send(inviteAccept, ACCEPT, {
			method: 'POST',
			path: ACCEPT,
			headers: asKey,
			json: { token: tokenFromMail() }
		});
		expect([401, 403]).toContain(reply.status);
		expect(await listPendingInvites(db, ORG)).toHaveLength(1);
	});

	it('joins the person once; a second accept of the same link finds nothing', async () => {
		live();
		await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'invitee@example.test', role: 'viewer' }
		});
		const token = tokenFromMail();
		const first = await send(inviteAccept, ACCEPT, {
			method: 'POST',
			path: ACCEPT,
			headers: asOtherUser,
			json: { token }
		});
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ organizationId: ORG, role: 'viewer' });
		const second = await send(inviteAccept, ACCEPT, {
			method: 'POST',
			path: ACCEPT,
			headers: asOtherUser,
			json: { token }
		});
		expect(second.status).toBe(404);
		const joined = (await listMembers(db, ORG, { limit: 10 })).items.filter(
			(m) => m.userId === other.id
		);
		expect(joined).toHaveLength(1);
	});

	it('refuses a link opened by an address it was not sent to', async () => {
		live();
		await send(inviteCreate, INVITES, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/invites`,
			headers: asUser,
			json: { email: 'someone-else@example.test', role: 'viewer' }
		});
		const reply = await send(inviteAccept, ACCEPT, {
			method: 'POST',
			path: ACCEPT,
			headers: asOtherUser,
			json: { token: tokenFromMail() }
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { reason: 'email_mismatch' } });
		expect(await listPendingInvites(db, ORG)).toHaveLength(1);
	});
});

describe('site grants', () => {
	const grant = (path: string, json: unknown, headers: Record<string, string> = asUser) =>
		send(grantCreate, GRANTS, { method: 'POST', path, headers, json });

	it('refuses a site of another organisation under this organisation path', async () => {
		live();
		const reply = await grant(`/api/v1/orgs/${ORG}/sites/${SITE_OUT}/grants`, {
			email: 'invitee@example.test',
			role: 'viewer',
			expiry: 'never'
		});
		expect([403, 404]).toContain(reply.status);
	});

	it('refuses a grant from an API key, which holds no site grant scope', async () => {
		live();
		const reply = await grant(
			`/api/v1/orgs/${ORG}/sites/${SITE_IN}/grants`,
			{ email: 'invitee@example.test', role: 'viewer', expiry: 'never' },
			asKey
		);
		expect(reply.status).toBe(403);
	});

	it('refuses an address with no account yet', async () => {
		live();
		const reply = await grant(`/api/v1/orgs/${ORG}/sites/${SITE_IN}/grants`, {
			email: 'nobody@example.test',
			role: 'viewer',
			expiry: 'never'
		});
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'no_account' } });
	});

	it('grants an existing account once and points a second grant at the change route', async () => {
		live();
		const body = { email: 'invitee@example.test', role: 'viewer', expiry: 'never' };
		const first = await grant(`/api/v1/orgs/${ORG}/sites/${SITE_IN}/grants`, body);
		expect(first.status).toBe(201);
		const second = await grant(`/api/v1/orgs/${ORG}/sites/${SITE_IN}/grants`, body);
		expect(second.status).toBe(409);
		expect(second.json).toMatchObject({ details: { reason: 'already_granted' } });
	});
});
