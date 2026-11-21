import { ApiError } from '../../shared/errors';
import { canManageMember } from '../../shared/members';
import type { OffboardEffect, OffboardResult } from '../../shared/offboarding';
import {
	accountKeyLinks,
	decideReviewItem,
	listDepartmentRoles,
	listGrantsOf,
	listInvitesSentBy,
	listLiveKeys,
	listOpenDelegations,
	listServiceAccounts,
	markItemApplied,
	pendingItemsAbout,
	setItemSubject,
	type ServiceAccountRow
} from '../db/repos/access-governance';
import { removeDepartmentMember } from '../db/repos/departments';
import { getUserById } from '../db/repos/identity';
import {
	countOwners,
	getDelegation,
	getMember,
	revokeApiKey,
	setInviteState
} from '../db/repos/organization';
import { revokeDelegationBatchFor } from './delegations';
import type { GovernanceActor, GovernanceServices } from './governance';
import { removeOrgMember } from './members';
import { principalActor } from './owner-tokens';
import { disableAccountOf, transferAccountOf } from './service-accounts';
import { revokeGrant } from './site-grants';

export interface OffboardOptions {
	dryRun?: boolean;
	transferTo?: string;
	keepDelegations?: boolean;
}

interface Plan {
	memberId: string;
	role: string;
	email: string | null;
	effects: OffboardEffect[];
	kept: OffboardEffect[];
	accounts: ServiceAccountRow[];
	transferTo: string | null;
}

async function plan(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	userId: string,
	options: OffboardOptions
): Promise<Plan> {
	const db = await deps.getDb();
	const member = await getMember(db, orgId, userId);
	if (member === null) throw new ApiError('not_found', 'Not found');
	if (userId === actor.userId) {
		throw new ApiError(
			'validation',
			'You cannot offboard yourself. Ask another owner or admin'
		);
	}
	const role = actor.facts.membership?.role;
	if (role === undefined || !canManageMember(role, member.role)) {
		throw new ApiError('forbidden', 'Your role does not reach that member');
	}
	if (member.role === 'owner' && (await countOwners(db, orgId)) <= 1) {
		throw new ApiError('conflict', 'An organization needs at least one owner', {
			reason: 'last_owner'
		});
	}
	const transferTo = options.transferTo ?? null;
	if (transferTo !== null) {
		if (transferTo === userId || (await getMember(db, orgId, transferTo)) === null) {
			throw new ApiError(
				'validation',
				'Pick another member of this organization to take over'
			);
		}
	}

	const user = await getUserById(db, userId);
	const email = user?.email ?? null;
	const now = deps.now();
	const effects: OffboardEffect[] = [];
	const kept: OffboardEffect[] = [];
	const add = (kind: OffboardEffect['kind'], ref: string, label: string) =>
		effects.push({ kind, ref, label });

	add('membership', member.id, `${email ?? userId} (${member.role})`);

	for (const invite of await listInvitesSentBy(db, orgId, userId)) {
		add('invite', invite.id, `Invitation to ${invite.email}`);
	}
	for (const row of await listOpenDelegations(db, orgId, userId)) {
		const entry = {
			kind: 'delegation' as const,
			ref: row.id,
			label: `Agency access (${row.role})`
		};
		if (options.keepDelegations === true) kept.push(entry);
		else effects.push(entry);
	}
	const accounts = (await listServiceAccounts(db, orgId)).filter(
		(account) => account.ownerUserId === userId && account.disabledAt === null
	);
	for (const account of accounts) {
		add(
			transferTo === null ? 'service-account-disable' : 'service-account-transfer',
			account.id,
			account.name
		);
	}
	const links = await accountKeyLinks(db, orgId);
	for (const key of await listLiveKeys(db, orgId, now)) {
		if (key.createdBy !== userId || links.has(key.id)) continue;
		add('api-key', key.id, key.name);
	}
	for (const grant of await listGrantsOf(db, orgId, userId, now)) {
		add('site-grant', grant.id, `${grant.siteName} (${grant.role})`);
	}
	for (const role of await listDepartmentRoles(db, orgId, { userId })) {
		add(
			'department-role',
			`${role.departmentId}:${userId}`,
			`${role.departmentName} (${role.role})`
		);
	}
	for (const item of await pendingItemsAbout(db, orgId, userId)) {
		add('review-item', `${item.reviewId}:${item.kind}:${item.subjectRef}`, item.label);
	}
	return { memberId: member.id, role: member.role, email, effects, kept, accounts, transferTo };
}

export async function offboardMember(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	userId: string,
	options: OffboardOptions = {}
): Promise<OffboardResult> {
	const planned = await plan(deps, orgId, actor, userId, options);
	const result: OffboardResult = {
		dryRun: options.dryRun === true,
		userId,
		email: planned.email,
		effects: planned.effects,
		kept: planned.kept
	};
	if (result.dryRun) return result;

	const db = await deps.getDb();
	const by = principalActor(actor.principal);
	const record = (effect: OffboardEffect) =>
		deps.audit(orgId, {
			actor: by,
			action: `offboard.${effect.kind}`,
			target: effect.ref,
			detail: { userId, label: effect.label }
		});
	const gone = new Set<string>();

	for (const effect of planned.effects) {
		switch (effect.kind) {
			case 'invite':
				await setInviteState(db, orgId, effect.ref, 'revoked');
				break;
			case 'delegation': {
				const row = await getDelegation(db, orgId, effect.ref);
				if (row !== null) await revokeDelegationBatchFor(deps, orgId, actor, row.batchId);
				gone.add(`delegation:${effect.ref}`);
				break;
			}
			case 'service-account-transfer':
			case 'service-account-disable': {
				const account = planned.accounts.find((a) => a.id === effect.ref)!;
				if (planned.transferTo === null) {
					await disableAccountOf(deps, orgId, account, by);
					gone.add(`service-account:${account.id}`);
				} else {
					await transferAccountOf(deps, orgId, account, planned.transferTo, by);
				}
				break;
			}
			case 'api-key':
				await revokeApiKey(db, orgId, effect.ref, deps.now());
				gone.add(`api-key:${effect.ref}`);
				break;
			case 'site-grant': {
				const grants = await listGrantsOf(db, orgId, userId, deps.now());
				const grant = grants.find((g) => g.id === effect.ref);
				if (grant !== undefined)
					await revokeGrant(deps, orgId, grant.siteId, actor, grant.id);
				gone.add(`grant:${effect.ref}`);
				break;
			}
			case 'department-role': {
				const [departmentId] = effect.ref.split(':');
				await removeDepartmentMember(db, orgId, departmentId!, userId);
				gone.add(`grant:department:${effect.ref}`);
				break;
			}
			case 'review-item': {
				const [reviewId, kind, ...rest] = effect.ref.split(':');
				const subjectRef = rest.join(':');
				const items = await pendingItemsAbout(db, orgId, userId);
				const item = items.find(
					(i) => i.reviewId === reviewId && i.kind === kind && i.subjectRef === subjectRef
				);
				if (item === undefined) break;
				if (gone.has(`${kind}:${subjectRef}`) || kind === 'member') {
					await decideReviewItem(db, item, {
						decision: 'revoke',
						decidedBy: 'offboarding',
						decidedAt: deps.now(),
						reason: 'The person was offboarded'
					});
					await markItemApplied(db, item, { appliedAt: deps.now(), error: null });
				} else if (kind === 'service-account' && planned.transferTo !== null) {
					await setItemSubject(db, item, planned.transferTo);
				}
				break;
			}
			case 'membership':
				break;
		}
		if (effect.kind !== 'membership') await record(effect);
	}

	// last, so a failure above leaves the person in place and the same call can run again
	await removeOrgMember(
		{ ...deps, inviteMail: async () => undefined, baseUrl: '' },
		orgId,
		{ principal: actor.principal, role: actor.facts.membership!.role, userId: actor.userId },
		planned.memberId
	);
	await record(planned.effects[0]!);
	await deps.audit(orgId, {
		actor: by,
		action: 'member.offboarded',
		target: planned.memberId,
		detail: { userId, effects: planned.effects.length, kept: planned.kept.length }
	});
	return result;
}
