import type { CollegeDBClient } from '@earth-app/collegedb';
import { DAY_MS } from '../../shared/access-reviews';
import type { KeyCreateBody, KeyCreated } from '../../shared/api-keys';
import { ApiError } from '../../shared/errors';
import {
	serviceAccountStateOf,
	type ServiceAccountCreateBody,
	type ServiceAccountKeyList,
	type ServiceAccountView
} from '../../shared/service-accounts';
import {
	getServiceAccount,
	insertServiceAccount,
	linkAccountKey,
	listAccountKeys,
	listServiceAccounts,
	moveKeysToOwner,
	setServiceAccountDisabled,
	setServiceAccountOwner,
	type ServiceAccountRow
} from '../db/repos/access-governance';
import { getDepartment } from '../db/repos/departments';
import { getUserById } from '../db/repos/identity';
import { getMember, revokeApiKey } from '../db/repos/organization';
import { checkExpiry } from '../domain/access-review';
import { authorize } from '../domain/authorize';
import { iso, type GovernanceActor, type GovernanceServices } from './governance';
import { issueKey, viewsOf } from './key-admin';
import { principalActor } from './owner-tokens';

const MANAGE = 'service-account.manage';

function allowed(actor: GovernanceActor, orgId: string, departmentId: string | null): boolean {
	return authorize({
		principal: actor.principal,
		action: MANAGE,
		resource: { orgId, ...(departmentId === null ? {} : { departmentId }) },
		facts: actor.facts
	}).allow;
}

function refuse(): never {
	throw new ApiError('forbidden', 'Your role does not reach this service account');
}

async function load(db: CollegeDBClient, orgId: string, id: string): Promise<ServiceAccountRow> {
	const row = await getServiceAccount(db, orgId, id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

async function viewOf(
	deps: GovernanceServices,
	db: CollegeDBClient,
	row: ServiceAccountRow
): Promise<ServiceAccountView> {
	const keys = await listAccountKeys(db, row.organizationId, row.id);
	const owner = await getUserById(db, row.ownerUserId);
	const last = keys.reduce<number | null>(
		(best, key) =>
			key.lastUsedAt !== null && (best === null || key.lastUsedAt > best)
				? key.lastUsedAt
				: best,
		null
	);
	return {
		id: row.id,
		name: row.name,
		departmentId: row.departmentId,
		ownerUserId: row.ownerUserId,
		ownerEmail: owner?.email ?? null,
		state: serviceAccountStateOf(row, deps.now()),
		expiresAt: new Date(row.expiresAt).toISOString(),
		disabledAt: iso(row.disabledAt),
		createdAt: new Date(row.createdAt).toISOString(),
		keyCount: keys.filter((key) => key.revokedAt === null).length,
		lastUsedAt: iso(last)
	};
}

export async function listServiceAccountViews(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor
): Promise<ServiceAccountView[]> {
	const db = await deps.getDb();
	const rows = (await listServiceAccounts(db, orgId)).filter((row) =>
		allowed(actor, orgId, row.departmentId)
	);
	return Promise.all(rows.map((row) => viewOf(deps, db, row)));
}

export async function createServiceAccount(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	body: ServiceAccountCreateBody
): Promise<ServiceAccountView> {
	const db = await deps.getDb();
	const departmentId = body.departmentId ?? null;
	if (departmentId !== null && (await getDepartment(db, orgId, departmentId)) === null) {
		throw new ApiError('validation', 'That department does not exist in this organization');
	}
	if (!allowed(actor, orgId, departmentId)) refuse();
	const ownerUserId = body.ownerUserId ?? actor.userId;
	if ((await getMember(db, orgId, ownerUserId)) === null) {
		throw new ApiError('validation', 'The owner has to be a member of this organization');
	}
	const now = deps.now();
	const expiresAt = now + body.expiresInDays * DAY_MS;
	if (checkExpiry(expiresAt, now) !== null) {
		throw new ApiError('validation', 'Pick an expiry date within the next year');
	}
	const row: ServiceAccountRow = {
		id: deps.newId(),
		organizationId: orgId,
		departmentId,
		name: body.name,
		ownerUserId,
		expiresAt,
		disabledAt: null,
		createdAt: now
	};
	await insertServiceAccount(db, row);
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'service-account.created',
		target: row.id,
		detail: { name: row.name, departmentId, ownerUserId, expiresAt }
	});
	return viewOf(deps, db, row);
}

export async function issueAccountKey(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	accountId: string,
	body: KeyCreateBody
): Promise<KeyCreated> {
	const db = await deps.getDb();
	const account = await load(db, orgId, accountId);
	if (!allowed(actor, orgId, account.departmentId)) refuse();
	if (serviceAccountStateOf(account, deps.now()) !== 'active') {
		throw new ApiError('conflict', 'This service account is disabled or has expired', {
			reason: 'account_inactive'
		});
	}
	const facts = await deps.ownerFacts(orgId, account.ownerUserId);
	if (facts === null) {
		throw new ApiError(
			'conflict',
			'The owner is no longer in this organization. Hand the account to someone else first',
			{ reason: 'owner_gone' }
		);
	}
	return issueKey(deps, {
		orgId,
		userId: actor.userId,
		principal: actor.principal,
		facts: actor.facts,
		body,
		service: {
			owner: {
				userId: account.ownerUserId,
				principal: { kind: 'user', userId: account.ownerUserId },
				facts
			},
			expiresAt: account.expiresAt,
			link: (keyId) => linkAccountKey(db, orgId, account.id, keyId)
		}
	});
}

export async function listKeysOfAccount(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	accountId: string
): Promise<ServiceAccountKeyList> {
	const db = await deps.getDb();
	const account = await load(db, orgId, accountId);
	if (!allowed(actor, orgId, account.departmentId)) refuse();
	const rows = await listAccountKeys(db, orgId, accountId);
	return {
		items: await viewsOf(
			deps,
			orgId,
			rows.map((row) => ({ ...row, organizationId: orgId }))
		)
	};
}

// the keys go first, so a failure half way leaves an enabled account that can be disabled again
export async function disableAccountOf(
	deps: GovernanceServices,
	orgId: string,
	account: ServiceAccountRow,
	actor: string
): Promise<number> {
	const db = await deps.getDb();
	const now = deps.now();
	let revoked = 0;
	for (const key of await listAccountKeys(db, orgId, account.id)) {
		if (key.revokedAt === null && (await revokeApiKey(db, orgId, key.id, now))) revoked += 1;
	}
	await setServiceAccountDisabled(db, orgId, account.id, now);
	await deps.audit(orgId, {
		actor,
		action: 'service-account.disabled',
		target: account.id,
		detail: { keysRevoked: revoked }
	});
	return revoked;
}

export async function disableServiceAccount(
	deps: GovernanceServices,
	orgId: string,
	actor: GovernanceActor,
	accountId: string
): Promise<ServiceAccountView> {
	const db = await deps.getDb();
	const account = await load(db, orgId, accountId);
	if (!allowed(actor, orgId, account.departmentId)) refuse();
	if (account.disabledAt === null) {
		await disableAccountOf(deps, orgId, account, principalActor(actor.principal));
	}
	return viewOf(deps, db, await load(db, orgId, accountId));
}

// its keys follow, and each keeps only what the new owner holds, because a key is held to its owner
export async function transferAccountOf(
	deps: GovernanceServices,
	orgId: string,
	account: ServiceAccountRow,
	newOwnerUserId: string,
	actor: string
): Promise<void> {
	const db = await deps.getDb();
	await setServiceAccountOwner(db, orgId, account.id, newOwnerUserId);
	await moveKeysToOwner(db, orgId, account.id, newOwnerUserId);
	await deps.audit(orgId, {
		actor,
		action: 'service-account.transferred',
		target: account.id,
		detail: { from: account.ownerUserId, to: newOwnerUserId }
	});
}
