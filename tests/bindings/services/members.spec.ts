import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { createUser } from '../../../src/server/db/repos/identity';
import {
	addMember,
	createApiKey,
	createOrganization,
	getApiKey,
	getMember
} from '../../../src/server/db/repos/organization';
import {
	acceptInvite,
	actorOf,
	changeRole,
	type InviteMailInput,
	inviteMember,
	type MembersServices,
	previewInvite,
	removeOrgMember
} from '../../../src/server/services/members';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const email = (tag: string) => `${tag}-${crypto.randomUUID()}@example.test`;

function services() {
	const mails: { to: string; input: InviteMailInput }[] = [];
	const deps: MembersServices = {
		getDb: async () => db,
		audit: vi.fn(async () => undefined),
		inviteMail: async (to, input) => {
			mails.push({ to, input });
		},
		baseUrl: 'https://app.test',
		now: Date.now
	};
	return { deps, mails };
}

async function organisation(role: 'owner' | 'admin' = 'owner') {
	const founder = await createUser(db, { email: email('founder') });
	const org = await createOrganization(db, {
		name: 'Members Test',
		personal: false,
		createdBy: founder.id
	});
	const member = await addMember(db, org.id, { userId: founder.id, role });
	return { orgId: org.id, user: founder, member };
}

describe('member rules', () => {
	it('refuses to invite an owner and lets an owner invite an admin', async () => {
		const { deps } = services();
		const { orgId, user } = await organisation();
		const actor = actorOf({ kind: 'user', userId: user.id }, 'owner');
		await expect(
			inviteMember(deps, orgId, actor, { email: email('o'), role: 'owner' }, 'Owner')
		).rejects.toMatchObject({ code: 'forbidden' });
		await expect(
			inviteMember(deps, orgId, actor, { email: email('a'), role: 'admin' }, 'Owner')
		).resolves.toMatchObject({ role: 'admin' });
	});

	it('refuses an admin who tries to invite an admin', async () => {
		const { deps } = services();
		const { orgId, user } = await organisation('admin');
		const actor = actorOf({ kind: 'user', userId: user.id }, 'admin');
		await expect(
			inviteMember(deps, orgId, actor, { email: email('b'), role: 'admin' }, 'Admin')
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('keeps the last owner from being demoted or removed', async () => {
		const { deps } = services();
		const { orgId, user, member } = await organisation();
		const actor = actorOf({ kind: 'user', userId: user.id }, 'owner');
		await expect(changeRole(deps, orgId, actor, member.id, 'viewer')).rejects.toMatchObject({
			code: 'conflict'
		});
		await expect(removeOrgMember(deps, orgId, actor, member.id)).rejects.toMatchObject({
			code: 'conflict'
		});
		expect(await getMember(db, orgId, user.id)).not.toBeNull();
	});

	it('refuses an admin who tries to remove an owner', async () => {
		const { deps } = services();
		const { orgId, user: owner } = await organisation();
		const admin = await createUser(db, { email: email('adm') });
		const adminRow = await addMember(db, orgId, { userId: admin.id, role: 'admin' });
		await expect(
			removeOrgMember(
				deps,
				orgId,
				actorOf({ kind: 'user', userId: admin.id }, 'admin'),
				(await getMember(db, orgId, owner.id))!.id
			)
		).rejects.toMatchObject({ code: 'forbidden' });
		expect(adminRow.role).toBe('admin');
	});

	it('revokes the keys a removed member made, so a later re-invite does not bring them back', async () => {
		const { deps } = services();
		const { orgId, user: owner } = await organisation();
		const dev = await createUser(db, { email: email('dev') });
		const devRow = await addMember(db, orgId, { userId: dev.id, role: 'developer' });
		const key = await createApiKey(db, orgId, {
			name: 'ci',
			keyHash: crypto.randomUUID(),
			scopes: ['site.read'],
			createdBy: dev.id,
			expiresAt: null
		});
		const ownerKey = await createApiKey(db, orgId, {
			name: 'owner ci',
			keyHash: crypto.randomUUID(),
			scopes: ['site.read'],
			createdBy: owner.id,
			expiresAt: null
		});
		await removeOrgMember(
			deps,
			orgId,
			actorOf({ kind: 'user', userId: owner.id }, 'owner'),
			devRow.id
		);
		expect((await getApiKey(db, orgId, key.id))?.revokedAt).not.toBeNull();
		expect((await getApiKey(db, orgId, ownerKey.id))?.revokedAt).toBeNull();
	});
});

describe('invitations', () => {
	it('lets only the invited address accept, and only once', async () => {
		const { deps, mails } = services();
		const { orgId, user: owner } = await organisation();
		const address = email('invitee');
		await inviteMember(
			deps,
			orgId,
			actorOf({ kind: 'user', userId: owner.id }, 'owner'),
			{ email: address, role: 'developer' },
			'Owner'
		);
		const token = new URL(mails[0]!.input.acceptUrl).pathname.replace('/invite/', '');
		const stranger = await createUser(db, { email: email('stranger') });
		const invitee = await createUser(db, { email: address });

		expect((await previewInvite(deps, token, stranger.id)).emailMatches).toBe(false);
		await expect(
			acceptInvite(deps, token, { kind: 'user', userId: stranger.id })
		).rejects.toMatchObject({ code: 'forbidden' });

		expect((await previewInvite(deps, token, invitee.id)).emailMatches).toBe(true);
		await expect(
			acceptInvite(deps, token, { kind: 'user', userId: invitee.id })
		).resolves.toEqual({ organizationId: orgId, role: 'developer' });
		await expect(
			acceptInvite(deps, token, { kind: 'user', userId: invitee.id })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses a token that does not name an invitation', async () => {
		const { deps } = services();
		await expect(previewInvite(deps, 'not-a-token', crypto.randomUUID())).rejects.toMatchObject(
			{
				code: 'not_found'
			}
		);
	});
});
