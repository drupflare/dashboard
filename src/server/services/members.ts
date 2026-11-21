import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	canAssignRole,
	canManageMember,
	INVITE_TTL_DAYS,
	INVITE_TTL_MS,
	type InviteAccepted,
	type InvitePreview,
	type InviteView,
	type MemberPage,
	type MemberView
} from '../../shared/members';
import type { OrgRole } from '../../shared/permissions';
import { DuplicateRowError } from '../db/collegedb';
import { removeUserDepartmentMembers } from '../db/repos/departments';
import { getUserByEmail, getUserById, normalizeEmail, type User } from '../db/repos/identity';
import {
	addMember,
	countOwners,
	createInvite,
	findPendingInviteByHash,
	getInvite,
	getMember,
	getMemberById,
	getOrganization,
	listMembers,
	listPendingInvites,
	removeMember,
	revokeApiKeysCreatedBy,
	rotateInvite,
	setInviteState,
	setMemberRole,
	type Invite
} from '../db/repos/organization';
import type { Principal } from '../domain/authorize';
import type { AuditInput } from './audit';
import { randomToken, sha256Hex } from './crypto';
import { principalActor } from './owner-tokens';

export interface InviteMailInput {
	inviterName: string;
	orgName: string;
	acceptUrl: string;
	expiresInDays: number;
}

export type InviteMail = (to: string, input: InviteMailInput) => Promise<void>;

export interface MembersServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	inviteMail: InviteMail;
	baseUrl: string;
	now: () => number;
}

let installed: MembersServices | null = null;

export function setMembersServices(services: MembersServices | null): void {
	installed = services;
}

export function membersServices(): MembersServices {
	if (installed === null) throw new ApiError('not_built', 'Members are not available yet');
	return installed;
}

// the organisation travels in the token so the lookup stays in one shard; the hash is the real key
const TOKEN_PREFIX = 'dfi_';

export interface Actor {
	principal: Principal;
	role: OrgRole;
	userId: string;
}

const ROLE_ABOVE = 'Your role does not reach that member or that role';

function inviteToken(orgId: string, secret: string): string {
	return `${TOKEN_PREFIX}${orgId}.${secret}`;
}

export function parseInviteToken(token: string): { orgId: string } | null {
	if (!token.startsWith(TOKEN_PREFIX)) return null;
	const body = token.slice(TOKEN_PREFIX.length);
	const at = body.lastIndexOf('.');
	if (at <= 0 || at === body.length - 1) return null;
	return { orgId: body.slice(0, at) };
}

function memberView(
	member: { id: string; userId: string; role: OrgRole; createdAt: number },
	user: User | null
): MemberView {
	return {
		id: member.id,
		userId: member.userId,
		email: user?.email ?? '',
		displayName: user?.displayName ?? null,
		role: member.role,
		joinedAt: new Date(member.createdAt).toISOString()
	};
}

function inviteView(invite: Invite): InviteView {
	return {
		id: invite.id,
		email: invite.email,
		role: invite.role,
		expiresAt: new Date(invite.expiresAt).toISOString(),
		createdAt: new Date(invite.createdAt).toISOString()
	};
}

// #region members

export async function listOrgMembers(
	deps: MembersServices,
	orgId: string,
	options: { after?: string; limit: number }
): Promise<MemberPage> {
	const db = await deps.getDb();
	const page = await listMembers(db, orgId, options);
	const items = await Promise.all(
		page.items.map(async (member) => memberView(member, await getUserById(db, member.userId)))
	);
	return { items, nextCursor: page.nextCursor };
}

export async function changeRole(
	deps: MembersServices,
	orgId: string,
	actor: Actor,
	memberId: string,
	role: OrgRole
): Promise<MemberView> {
	const db = await deps.getDb();
	const member = await getMemberById(db, orgId, memberId);
	if (member === null) throw new ApiError('not_found', 'Not found');
	if (!canManageMember(actor.role, member.role) || !canAssignRole(actor.role, role)) {
		throw new ApiError('forbidden', ROLE_ABOVE);
	}
	if (member.role === role) {
		return memberView(member, await getUserById(db, member.userId));
	}
	if (member.role === 'owner' && (await countOwners(db, orgId)) <= 1) {
		throw new ApiError('conflict', 'An organization needs at least one owner', {
			reason: 'last_owner'
		});
	}
	await setMemberRole(db, orgId, member.id, role);
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'member.role_changed',
		target: member.id,
		detail: { from: member.role, to: role }
	});
	return memberView({ ...member, role }, await getUserById(db, member.userId));
}

export async function removeOrgMember(
	deps: MembersServices,
	orgId: string,
	actor: Actor,
	memberId: string
): Promise<void> {
	const db = await deps.getDb();
	const member = await getMemberById(db, orgId, memberId);
	if (member === null) throw new ApiError('not_found', 'Not found');
	if (!canManageMember(actor.role, member.role)) throw new ApiError('forbidden', ROLE_ABOVE);
	if (member.role === 'owner' && (await countOwners(db, orgId)) <= 1) {
		throw new ApiError('conflict', 'An organization needs at least one owner', {
			reason: 'last_owner'
		});
	}
	await removeMember(db, orgId, member.id);
	await removeUserDepartmentMembers(db, orgId, member.userId);
	// a key works through the person who made it, so a removed member's keys would come back to
	// life if the same person were invited again
	const keys = await revokeApiKeysCreatedBy(db, orgId, member.userId, deps.now());
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'member.removed',
		target: member.id,
		detail: { role: member.role, keysRevoked: keys }
	});
}

// #endregion

// #region invites

async function sendInvite(
	deps: MembersServices,
	db: CollegeDBClient,
	orgId: string,
	invite: { email: string; expiresAt: number },
	secret: string,
	inviterName: string
): Promise<void> {
	const org = await getOrganization(db, orgId);
	await deps.inviteMail(invite.email, {
		inviterName,
		orgName: org?.name ?? '',
		acceptUrl: `${deps.baseUrl}/invite/${inviteToken(orgId, secret)}`,
		expiresInDays: INVITE_TTL_DAYS
	});
}

export async function listOrgInvites(deps: MembersServices, orgId: string): Promise<InviteView[]> {
	const db = await deps.getDb();
	return (await listPendingInvites(db, orgId)).map(inviteView);
}

export async function inviteMember(
	deps: MembersServices,
	orgId: string,
	actor: Actor,
	input: { email: string; role: OrgRole },
	inviterName: string
): Promise<InviteView> {
	if (!canAssignRole(actor.role, input.role)) throw new ApiError('forbidden', ROLE_ABOVE);
	const db = await deps.getDb();
	const user = await getUserByEmail(db, input.email);
	if (user && (await getMember(db, orgId, user.id))) {
		throw new ApiError('conflict', 'That person is already a member of this organization');
	}
	const now = deps.now();
	if ((await listPendingInvites(db, orgId)).some((invite) => invite.email === input.email)) {
		throw new ApiError('conflict', 'That email already has a pending invitation', {
			reason: 'already_invited'
		});
	}
	const secret = randomToken();
	const invite = await createInvite(db, orgId, {
		email: input.email,
		role: input.role,
		tokenHash: await sha256Hex(inviteToken(orgId, secret)),
		invitedBy: actor.userId,
		expiresAt: now + INVITE_TTL_MS
	});
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'invite.created',
		target: invite.id,
		detail: { role: invite.role }
	});
	await sendInvite(deps, db, orgId, invite, secret, inviterName);
	return inviteView(invite);
}

async function pendingInvite(db: CollegeDBClient, orgId: string, id: string): Promise<Invite> {
	const invite = await getInvite(db, orgId, id);
	if (invite === null) throw new ApiError('not_found', 'Not found');
	if (invite.state !== 'pending') {
		throw new ApiError('conflict', 'This invitation is no longer pending', {
			reason: 'not_pending'
		});
	}
	return invite;
}

export async function resendInvite(
	deps: MembersServices,
	orgId: string,
	actor: Actor,
	id: string,
	inviterName: string
): Promise<InviteView> {
	const db = await deps.getDb();
	const invite = await pendingInvite(db, orgId, id);
	if (!canAssignRole(actor.role, invite.role)) throw new ApiError('forbidden', ROLE_ABOVE);
	const secret = randomToken();
	const expiresAt = deps.now() + INVITE_TTL_MS;
	await rotateInvite(db, orgId, invite.id, {
		tokenHash: await sha256Hex(inviteToken(orgId, secret)),
		expiresAt
	});
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'invite.resent',
		target: invite.id
	});
	const renewed = { ...invite, expiresAt };
	await sendInvite(deps, db, orgId, renewed, secret, inviterName);
	return inviteView(renewed);
}

export async function revokeInvite(
	deps: MembersServices,
	orgId: string,
	actor: Actor,
	id: string
): Promise<void> {
	const db = await deps.getDb();
	const invite = await pendingInvite(db, orgId, id);
	if (!canAssignRole(actor.role, invite.role)) throw new ApiError('forbidden', ROLE_ABOVE);
	await setInviteState(db, orgId, invite.id, 'revoked');
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'invite.revoked',
		target: invite.id
	});
}

// the reply names the organisation and role; the invite email is compared, never returned
export async function previewInvite(
	deps: MembersServices,
	token: string,
	userId: string
): Promise<InvitePreview> {
	const invite = await findLiveInvite(deps, token);
	const db = await deps.getDb();
	const user = await signedInUser(db, userId);
	const org = await getOrganization(db, invite.organizationId);
	if (org === null) throw new ApiError('not_found', 'Not found');
	return {
		organizationName: org.name,
		role: invite.role,
		expiresAt: new Date(invite.expiresAt).toISOString(),
		emailMatches: normalizeEmail(user.email) === invite.email
	};
}

async function signedInUser(db: CollegeDBClient, userId: string): Promise<User> {
	const user = await getUserById(db, userId);
	if (user === null) throw new ApiError('unauthenticated', 'Authentication is required');
	return user;
}

// the name an invitation mail carries; a key's name is its issuer's
export async function inviterNameOf(deps: MembersServices, principal: Principal): Promise<string> {
	const db = await deps.getDb();
	const user = await getUserById(db, userIdOf(principal));
	return user?.displayName ?? user?.email ?? 'A member of this organization';
}

export function userIdOf(principal: Principal): string {
	return principal.kind === 'user' ? principal.userId : principal.issuerId;
}

export function actorOf(principal: Principal, role: OrgRole): Actor {
	return { principal, role, userId: userIdOf(principal) };
}

async function findLiveInvite(deps: MembersServices, token: string): Promise<Invite> {
	const parsed = parseInviteToken(token);
	if (parsed === null) throw new ApiError('not_found', 'This invitation is not valid');
	const db = await deps.getDb();
	const invite = await findPendingInviteByHash(db, parsed.orgId, await sha256Hex(token));
	if (invite === null) throw new ApiError('not_found', 'This invitation is not valid');
	if (invite.expiresAt <= deps.now()) {
		throw new ApiError(
			'precondition_failed',
			'This invitation has expired. Ask for a new one.',
			{
				reason: 'expired'
			}
		);
	}
	return invite;
}

// single use: the pending-to-accepted step is the claim, so a second accept finds nothing
export async function acceptInvite(
	deps: MembersServices,
	token: string,
	principal: Principal
): Promise<InviteAccepted> {
	const invite = await findLiveInvite(deps, token);
	const db = await deps.getDb();
	const actor = await signedInUser(db, userIdOf(principal));
	if (normalizeEmail(actor.email) !== invite.email) {
		throw new ApiError(
			'forbidden',
			'This invitation was sent to another address. Sign in with that address to accept it.',
			{ reason: 'email_mismatch' }
		);
	}
	if (await getMember(db, invite.organizationId, actor.id)) {
		throw new ApiError('conflict', 'You are already a member of this organization', {
			reason: 'already_member'
		});
	}
	if (!(await setInviteState(db, invite.organizationId, invite.id, 'accepted'))) {
		throw new ApiError('conflict', 'This invitation has already been used', {
			reason: 'already_used'
		});
	}
	try {
		await addMember(db, invite.organizationId, { userId: actor.id, role: invite.role });
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'You are already a member of this organization', {
				reason: 'already_member'
			});
		}
		throw error;
	}
	await deps.audit(invite.organizationId, {
		actor: principalActor(principal),
		action: 'member.added',
		target: invite.id,
		detail: { role: invite.role }
	});
	return { organizationId: invite.organizationId, role: invite.role };
}

// #endregion
