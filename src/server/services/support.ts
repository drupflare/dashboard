import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import type { SupportRole } from '../../shared/permissions';
import {
	BREAK_GLASS_DAY_MS,
	BREAK_GLASS_MAX_PER_DAY,
	BREAK_GLASS_MS,
	SUPPORT_GRANT_MAX_MS,
	SUPPORT_GRANT_MIN_MS,
	type BreakGlassView,
	type SupportGrantScope,
	type SupportGrantView
} from '../../shared/support';
import { getOrganization } from '../db/repos/organization';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import {
	countBreakGlassSince,
	currentSupportGrant,
	getSupportGrant,
	insertBreakGlass,
	insertSupportGrant,
	listBreakGlass,
	listLiveSupportGrants,
	listSupportGrants,
	liveBreakGlass,
	revokeSupportGrant,
	setBreakGlassNotified,
	type BreakGlassRow,
	type SupportGrantRow
} from '../db/repos/support';
import type { Principal } from '../domain/authorize';
import type { AccessIdentity } from '../utils/access';
import type { AuditInput } from './audit';
import type { BackupServices } from './backups';
import type { SupportStanding } from './facts';
import { principalActor } from './owner-tokens';

export interface SupportServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	ownerEmails: (orgId: string) => Promise<string[]>;
	// one essential security-event mail; reviewPath is the page the mail's button opens
	notify: (to: string, summary: string, reviewPath: string) => Promise<void>;
	startOperation: BackupServices['startOperation'];
	newId: () => string;
	now: () => number;
}

let installed: SupportServices | null = null;

export function setSupportServices(services: SupportServices | null): void {
	installed = services;
}

export function supportServices(): SupportServices {
	if (installed === null) throw new ApiError('not_built', 'Support access is not available yet');
	return installed;
}

// read-metadata maps to the viewer role and act to the developer role; neither reads content
export const SUPPORT_ROLE_OF: Record<SupportGrantScope, SupportRole> = {
	'read-metadata': 'viewer',
	act: 'developer'
};

export function grantView(row: SupportGrantRow, now: number): SupportGrantView {
	return {
		id: row.id,
		organizationId: row.organizationId,
		grantedBy: row.grantedBy,
		scope: row.scope,
		reason: row.reason,
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
		revokedAt: row.revokedAt,
		live: row.revokedAt === null && row.expiresAt > now
	};
}

export function glassView(row: BreakGlassRow, now: number): BreakGlassView {
	return {
		id: row.id,
		organizationId: row.organizationId,
		admin: row.adminUserId,
		reason: row.reason,
		startedAt: row.startedAt,
		expiresAt: row.expiresAt,
		ownersNotified: row.ownersNotified,
		live: row.expiresAt > now
	};
}

// #region customer side

export async function createGrant(
	services: SupportServices,
	input: {
		orgId: string;
		principal: Principal;
		scope: SupportGrantScope;
		hours: number;
		reason: string;
	}
): Promise<SupportGrantView> {
	const now = services.now();
	const length = input.hours * 3_600_000;
	if (length < SUPPORT_GRANT_MIN_MS || length > SUPPORT_GRANT_MAX_MS) {
		throw new ApiError('unprocessable', 'Support access can last between 1 hour and 7 days', {
			reason: 'grant_length'
		});
	}
	const actor = principalActor(input.principal);
	const row = await insertSupportGrant(await services.getDb(), {
		id: services.newId(),
		organizationId: input.orgId,
		grantedBy: actor,
		scope: input.scope,
		reason: input.reason,
		createdAt: now,
		expiresAt: now + length
	});
	await services.audit(input.orgId, {
		actor,
		action: 'support.grant.create',
		target: row.id,
		detail: { scope: row.scope, expiresAt: row.expiresAt }
	});
	return grantView(row, now);
}

export async function revokeGrant(
	services: SupportServices,
	input: { orgId: string; id: string; principal: Principal }
): Promise<SupportGrantView> {
	const db = await services.getDb();
	const now = services.now();
	const grant = await getSupportGrant(db, input.orgId, input.id);
	if (grant === null) throw new ApiError('not_found', 'No support access has this id');
	const actor = principalActor(input.principal);
	if (
		await revokeSupportGrant(db, { organizationId: input.orgId, id: input.id, by: actor, now })
	) {
		await services.audit(input.orgId, {
			actor,
			action: 'support.grant.revoke',
			target: input.id,
			detail: {}
		});
	}
	const latest = await getSupportGrant(db, input.orgId, input.id);
	return grantView(latest ?? grant, now);
}

export async function listOrgGrants(
	services: SupportServices,
	orgId: string
): Promise<SupportGrantView[]> {
	const now = services.now();
	return (await listSupportGrants(await services.getDb(), orgId)).map((row) =>
		grantView(row, now)
	);
}

// #endregion

// #region admin side

export async function listAdminGrants(
	services: SupportServices
): Promise<{ grants: SupportGrantView[]; breakGlass: BreakGlassView[] }> {
	const db = await services.getDb();
	const now = services.now();
	return {
		grants: (await listLiveSupportGrants(db, now)).map((row) => grantView(row, now)),
		breakGlass: (await listBreakGlass(db)).map((row) => glassView(row, now))
	};
}

// every owner hears at once, and a failed mail does not stop the access that was recorded
export async function startBreakGlass(
	services: SupportServices,
	input: { orgId: string; reason: string; principal: Principal }
): Promise<BreakGlassView> {
	if (input.principal.kind !== 'user') {
		throw new ApiError('forbidden', 'Break-glass access needs a signed-in session');
	}
	const reason = input.reason.trim();
	if (reason.length === 0) {
		throw new ApiError('unprocessable', 'Break-glass access needs a reason', {
			reason: 'reason_required'
		});
	}
	const db = await services.getDb();
	const now = services.now();
	const adminId = input.principal.userId;
	if ((await getOrganization(db, input.orgId)) === null) {
		throw new ApiError('not_found', 'No organization has this id');
	}
	const recent = await countBreakGlassSince(db, adminId, now - BREAK_GLASS_DAY_MS);
	if (recent >= BREAK_GLASS_MAX_PER_DAY) {
		throw new ApiError(
			'rate_limited',
			'This admin started break-glass access too often today',
			{
				reason: 'break_glass_rate',
				retryAfterSeconds: Math.ceil(BREAK_GLASS_DAY_MS / 1000)
			}
		);
	}
	const actor = principalActor(input.principal);
	const row = await insertBreakGlass(db, {
		id: services.newId(),
		organizationId: input.orgId,
		adminUserId: adminId,
		reason,
		startedAt: now,
		expiresAt: now + BREAK_GLASS_MS,
		ownersNotified: 0
	});
	await appendPlatformAudit(db, {
		actor,
		action: 'admin.break-glass.start',
		target: input.orgId,
		detail: { eventId: row.id, reason, expiresAt: row.expiresAt },
		now
	});
	await services.audit(input.orgId, {
		actor,
		action: 'support.break-glass.start',
		target: row.id,
		detail: { reason, expiresAt: row.expiresAt }
	});
	const emails = await services.ownerEmails(input.orgId);
	const summary =
		'Drupflare support opened emergency access to your organization for one hour. ' +
		`The stated reason: ${reason}`;
	const sent = await Promise.all(
		emails.map((to) =>
			services.notify(to, summary, '/org/support').then(
				() => 1,
				() => 0
			)
		)
	);
	const count = sent.reduce<number>((a, b) => a + b, 0);
	await setBreakGlassNotified(db, row.id, count);
	return glassView({ ...row, ownersNotified: count }, now);
}

// #endregion

// #region facts port

// the platform standing comes from the same lookup as the admin routes, so the grant and the
// break-glass window only matter to someone Access and the role both vouch for
export function supportStanding(
	getDb: () => Promise<CollegeDBClient>,
	platform: (input: {
		userId: string;
		access: AccessIdentity | null;
	}) => Promise<NonNullable<SupportStanding['platform']> | null>,
	now: () => number
) {
	return async (input: {
		userId: string;
		orgId: string;
		access: AccessIdentity | null;
	}): Promise<SupportStanding | null> => {
		const standing = await platform({ userId: input.userId, access: input.access });
		if (standing === null) return null;
		const db = await getDb();
		const [grant, glass] = await Promise.all([
			currentSupportGrant(db, input.orgId),
			liveBreakGlass(db, input.userId, input.orgId, now())
		]);
		return {
			platform: standing,
			...(grant
				? {
						supportGrant: {
							orgId: input.orgId,
							role: SUPPORT_ROLE_OF[grant.scope],
							expiresAt: grant.expiresAt
						}
					}
				: {}),
			...(glass ? { breakGlass: { orgId: input.orgId, reason: glass.reason } } : {})
		};
	};
}

// #endregion
