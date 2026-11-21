import { z } from 'zod';
import {
	ORG_ROLE_ACTIONS,
	ORG_ROLES,
	SITE_ROLE_ACTIONS,
	type Action,
	type OrgRole,
	type SiteRole
} from './permissions';

export const INVITE_TTL_DAYS = 7;
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export const INVITABLE_ROLES = ORG_ROLES.filter((role) => role !== 'owner');

export const memberViewSchema = z.strictObject({
	id: z.string(),
	userId: z.string(),
	email: z.string(),
	displayName: z.string().nullable(),
	role: z.enum(ORG_ROLES),
	joinedAt: z.string()
});
export type MemberView = z.infer<typeof memberViewSchema>;

export const memberPageSchema = z.strictObject({
	items: z.array(memberViewSchema),
	nextCursor: z.string().nullable()
});
export type MemberPage = z.infer<typeof memberPageSchema>;

export const inviteViewSchema = z.strictObject({
	id: z.string(),
	email: z.string(),
	role: z.enum(ORG_ROLES),
	expiresAt: z.string(),
	createdAt: z.string()
});
export type InviteView = z.infer<typeof inviteViewSchema>;

export const inviteCreateBodySchema = z.strictObject({
	email: z.string().trim().toLowerCase().email().max(254),
	role: z.enum(INVITABLE_ROLES)
});
export type InviteCreateBody = z.infer<typeof inviteCreateBodySchema>;

export const roleBodySchema = z.strictObject({ role: z.enum(ORG_ROLES) });
export type RoleBody = z.infer<typeof roleBodySchema>;

export const invitePreviewSchema = z.strictObject({
	organizationName: z.string(),
	role: z.enum(ORG_ROLES),
	expiresAt: z.string(),
	emailMatches: z.boolean()
});
export type InvitePreview = z.infer<typeof invitePreviewSchema>;

export const inviteAcceptedSchema = z.strictObject({
	organizationId: z.string(),
	role: z.enum(ORG_ROLES)
});
export type InviteAccepted = z.infer<typeof inviteAcceptedSchema>;

export const SITE_GRANT_EXPIRY_PRESETS = ['never', '30d', '90d', '180d', '365d'] as const;
export type SiteGrantExpiry = (typeof SITE_GRANT_EXPIRY_PRESETS)[number];

export const siteGrantBodySchema = z.strictObject({
	email: z.string().trim().toLowerCase().email().max(254),
	role: z.enum(['site-admin', 'maintainer', 'viewer']),
	expiry: z.enum(SITE_GRANT_EXPIRY_PRESETS)
});
export type SiteGrantBody = z.infer<typeof siteGrantBodySchema>;

// keep leaves the expiry as it stands
export const siteGrantUpdateSchema = z.strictObject({
	role: z.enum(['site-admin', 'maintainer', 'viewer']),
	expiry: z.enum(['keep', ...SITE_GRANT_EXPIRY_PRESETS])
});
export type SiteGrantUpdate = z.infer<typeof siteGrantUpdateSchema>;

export const siteGrantViewSchema = z.strictObject({
	id: z.string(),
	userId: z.string(),
	email: z.string(),
	displayName: z.string().nullable(),
	role: z.enum(['site-admin', 'maintainer', 'viewer']),
	inOrganization: z.boolean(),
	expiresAt: z.string().nullable(),
	createdAt: z.string()
});
export type SiteGrantView = z.infer<typeof siteGrantViewSchema>;

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
	owner: 'Owner',
	admin: 'Admin',
	developer: 'Developer',
	billing: 'Billing',
	viewer: 'Viewer'
};

export const SITE_ROLE_LABELS: Record<SiteRole, string> = {
	'site-admin': 'Site Admin',
	maintainer: 'Maintainer',
	viewer: 'Viewer'
};

// #region rules

// a role whose actions the actor does not all hold is above them; owner is never invitable, and only
// an owner can hand out admin
export function canAssignRole(actor: OrgRole, target: OrgRole): boolean {
	if (target === 'owner') return false;
	if (target === 'admin') return actor === 'owner';
	return roleActionsSubset(target, actor);
}

// a member can be touched only when the actor holds everything that member's role holds
export function canManageMember(actor: OrgRole, member: OrgRole): boolean {
	return roleActionsSubset(member, actor);
}

function roleActionsSubset(inner: OrgRole, outer: OrgRole): boolean {
	const held = new Set<Action>(ORG_ROLE_ACTIONS[outer]);
	return ORG_ROLE_ACTIONS[inner].every((action) => held.has(action));
}

export function assignableRoles(actor: OrgRole): OrgRole[] {
	return INVITABLE_ROLES.filter((role) => canAssignRole(actor, role));
}

// #endregion

// #region effective permissions

// the headline site actions, in the order a person reads them; each one is only ever phrased, never
// decided here, so the preview follows shared/permissions.ts
const SITE_HEADLINES: readonly (readonly [Action, string])[] = [
	['site.read', 'see the site'],
	['site.deploy', 'deploy'],
	['site.rollback', 'roll back'],
	['site.modify', 'change what the site runs'],
	['site.grant.manage', 'manage collaborators'],
	['site.domain.manage', 'change domains'],
	['site.delete', 'delete the site']
];

export function sitePreviewLine(role: SiteRole): string {
	const held = new Set<Action>(SITE_ROLE_ACTIONS[role]);
	const can = SITE_HEADLINES.filter(([action]) => held.has(action)).map(([, phrase]) => phrase);
	const cannot = SITE_HEADLINES.filter(([action]) => !held.has(action)).map(
		([, phrase]) => phrase
	);
	const parts: string[] = [];
	if (can.length > 0) parts.push(`Can ${joinPhrases(can)}`);
	if (cannot.length > 0) parts.push(`cannot ${joinPhrases(cannot)}`);
	return parts.join(', ');
}

function joinPhrases(phrases: readonly string[]): string {
	if (phrases.length <= 1) return phrases[0] ?? '';
	return `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`;
}

// #endregion
