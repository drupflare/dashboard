import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import type {
	SiteGrantBody,
	SiteGrantExpiry,
	SiteGrantUpdate,
	SiteGrantView
} from '../../shared/members';
import type { SiteRole } from '../../shared/permissions';
import { DuplicateRowError } from '../db/collegedb';
import { getUserByEmail, getUserById, type User } from '../db/repos/identity';
import {
	createSiteGrant,
	getMember,
	getSiteGrant,
	listSiteGrants,
	revokeSiteGrant,
	type SiteGrant,
	updateSiteGrant
} from '../db/repos/organization';
import type { Principal } from '../domain/authorize';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export interface SiteGrantServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
}

let installed: SiteGrantServices | null = null;

export function setSiteGrantServices(services: SiteGrantServices | null): void {
	installed = services;
}

export function siteGrantServices(): SiteGrantServices {
	if (installed === null) throw new ApiError('not_built', 'Site access is not available yet');
	return installed;
}

const EXPIRY_MS: Record<Exclude<SiteGrantExpiry, 'never'>, number> = {
	'30d': 30 * 24 * 60 * 60 * 1000,
	'90d': 90 * 24 * 60 * 60 * 1000,
	'180d': 180 * 24 * 60 * 60 * 1000,
	'365d': 365 * 24 * 60 * 60 * 1000
};

export function expiryAt(expiry: SiteGrantExpiry, now: number): number | null {
	return expiry === 'never' ? null : now + EXPIRY_MS[expiry];
}

export interface GrantActor {
	principal: Principal;
	userId: string;
}

async function grantView(
	db: CollegeDBClient,
	orgId: string,
	grant: SiteGrant,
	user: User | null
): Promise<SiteGrantView> {
	return {
		id: grant.id,
		userId: grant.userId,
		email: user?.email ?? '',
		displayName: user?.displayName ?? null,
		role: grant.role,
		inOrganization: (await getMember(db, orgId, grant.userId)) !== null,
		expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
		createdAt: new Date(grant.createdAt).toISOString()
	};
}

export async function listGrants(
	deps: SiteGrantServices,
	orgId: string,
	siteId: string
): Promise<SiteGrantView[]> {
	const db = await deps.getDb();
	const grants = await listSiteGrants(db, orgId, siteId);
	return Promise.all(
		grants.map(async (grant) =>
			grantView(db, orgId, grant, await getUserById(db, grant.userId))
		)
	);
}

// a person with no account yet cannot hold a grant; the reply says so without saying more
export async function grantSite(
	deps: SiteGrantServices,
	orgId: string,
	siteId: string,
	actor: GrantActor,
	body: SiteGrantBody
): Promise<SiteGrantView> {
	const db = await deps.getDb();
	const user = await getUserByEmail(db, body.email);
	if (user === null) {
		throw new ApiError(
			'unprocessable',
			'No account uses that email yet. Ask the person to sign up first.',
			{ reason: 'no_account' }
		);
	}
	const grant = await createOrChange(db, orgId, siteId, actor, user.id, body, deps.now());
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'site.grant.created',
		target: grant.id,
		detail: { siteId, role: grant.role }
	});
	return grantView(db, orgId, grant, user);
}

async function createOrChange(
	db: CollegeDBClient,
	orgId: string,
	siteId: string,
	actor: GrantActor,
	userId: string,
	body: { role: SiteRole; expiry: SiteGrantExpiry },
	now: number
): Promise<SiteGrant> {
	try {
		return await createSiteGrant(db, orgId, {
			siteId,
			userId,
			role: body.role,
			createdBy: actor.userId,
			expiresAt: expiryAt(body.expiry, now)
		});
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError(
				'conflict',
				'That person already has access to this site. Change their role instead.',
				{
					reason: 'already_granted'
				}
			);
		}
		throw error;
	}
}

async function liveGrant(db: CollegeDBClient, orgId: string, id: string): Promise<SiteGrant> {
	const grant = await getSiteGrant(db, orgId, id);
	if (grant === null || grant.revokedAt !== null) throw new ApiError('not_found', 'Not found');
	return grant;
}

export async function changeGrant(
	deps: SiteGrantServices,
	orgId: string,
	siteId: string,
	actor: GrantActor,
	id: string,
	body: SiteGrantUpdate
): Promise<SiteGrantView> {
	const db = await deps.getDb();
	const grant = await liveGrant(db, orgId, id);
	if (grant.siteId !== siteId) throw new ApiError('not_found', 'Not found');
	const expiresAt = body.expiry === 'keep' ? grant.expiresAt : expiryAt(body.expiry, deps.now());
	await updateSiteGrant(db, orgId, grant.id, { role: body.role, expiresAt });
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'site.grant.changed',
		target: grant.id,
		detail: { from: grant.role, to: body.role }
	});
	const changed = { ...grant, role: body.role, expiresAt };
	return grantView(db, orgId, changed, await getUserById(db, grant.userId));
}

// revoking a grant that is already revoked changes nothing
export async function revokeGrant(
	deps: SiteGrantServices,
	orgId: string,
	siteId: string,
	actor: GrantActor,
	id: string
): Promise<void> {
	const db = await deps.getDb();
	const grant = await getSiteGrant(db, orgId, id);
	if (grant === null || grant.siteId !== siteId) throw new ApiError('not_found', 'Not found');
	if (grant.revokedAt !== null) return;
	await revokeSiteGrant(db, orgId, grant.id);
	await deps.audit(orgId, {
		actor: principalActor(actor.principal),
		action: 'site.grant.revoked',
		target: grant.id,
		detail: { role: grant.role }
	});
}
