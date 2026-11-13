export const ORG_ROLES = ['owner', 'admin', 'developer', 'billing', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const SITE_ROLES = ['site-admin', 'maintainer', 'viewer'] as const;
export type SiteRole = (typeof SITE_ROLES)[number];

export const CONFIG_GROUPS = [
	'runtime',
	'content',
	'security',
	'integrations',
	'appearance',
	'access'
] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];
export type ConfigAction = `site.config.${ConfigGroup}.${'read' | 'write'}`;

export const PLATFORM_PERMISSIONS = [
	'read',
	'support',
	'billing_support',
	'infrastructure'
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

// a role on the user record, granted by a database write; Access still has to pass beside it
export const PLATFORM_ROLES = ['admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
	admin: ['read']
};

export function isPlatformRole(value: unknown): value is PlatformRole {
	return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export const BUDGET_KEYS = ['destructive-sites', 'production-deploys'] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

export type ActionScope = 'account' | 'org' | 'department' | 'site' | 'admin';

export interface ActionDef {
	scope: ActionScope;
	org?: readonly OrgRole[];
	site?: readonly SiteRole[];
	sessionOnly?: true;
	stepUp?: true;
	content?: true;
	entitlement?: string;
	budget?: BudgetKey;
	platform?: PlatformPermission;
}

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

// #region role groups
const ALL: readonly OrgRole[] = ['owner', 'admin', 'developer', 'billing', 'viewer'];
const NOBILL: readonly OrgRole[] = ['owner', 'admin', 'developer', 'viewer'];
const DEV: readonly OrgRole[] = ['owner', 'admin', 'developer'];
const ADM: readonly OrgRole[] = ['owner', 'admin'];
const OWN: readonly OrgRole[] = ['owner'];
const OB: readonly OrgRole[] = ['owner', 'billing'];
const OAB: readonly OrgRole[] = ['owner', 'admin', 'billing'];
const MONEY: readonly OrgRole[] = ['owner', 'admin', 'developer', 'billing'];
const SV: readonly SiteRole[] = ['site-admin', 'maintainer', 'viewer'];
const SM: readonly SiteRole[] = ['site-admin', 'maintainer'];
const SA: readonly SiteRole[] = ['site-admin'];
// #endregion

const configDefs = Object.fromEntries(
	CONFIG_GROUPS.flatMap((group) => {
		const open = group === 'runtime' || group === 'content' || group === 'appearance';
		return [
			[
				`site.config.${group}.read`,
				{ scope: 'site', org: open ? NOBILL : DEV, site: open ? SV : SM }
			],
			[
				`site.config.${group}.write`,
				{ scope: 'site', org: open ? DEV : ADM, site: open ? SM : SA }
			]
		];
	})
) as Record<ConfigAction, ActionDef>;

export const ACTION_DEFS = {
	// #region account
	'account.read': { scope: 'account' },
	'account.write': { scope: 'account', sessionOnly: true },
	'account.security.manage': { scope: 'account', sessionOnly: true },
	// #endregion

	// #region organisation
	'org.read': { scope: 'org', org: ALL },
	'org.update': { scope: 'org', org: ADM },
	'org.delete': { scope: 'org', org: OWN, sessionOnly: true, stepUp: true },
	'org.sso.manage': { scope: 'org', org: OWN, entitlement: 'sso' },
	'member.read': { scope: 'org', org: ALL },
	'member.invite': { scope: 'department', org: ADM },
	'member.update': { scope: 'department', org: ADM },
	'member.remove': { scope: 'department', org: ADM },
	'department.read': { scope: 'org', org: ALL },
	'department.manage': { scope: 'department', org: ADM },
	'grant.manage': { scope: 'department', org: ADM },
	'service-account.manage': { scope: 'department', org: ADM },
	'policy.read': { scope: 'org', org: NOBILL },
	'policy.manage': { scope: 'org', org: ADM },
	'review.read': { scope: 'org', org: ADM },
	'review.manage': { scope: 'org', org: ADM },
	'key.read': { scope: 'org', org: DEV },
	'key.create': { scope: 'org', org: DEV, sessionOnly: true, stepUp: true },
	'key.revoke': { scope: 'org', org: DEV },
	'delegation.read': { scope: 'org', org: NOBILL },
	'delegation.create': { scope: 'org', org: ADM },
	'delegation.accept': { scope: 'org', org: ADM },
	'delegation.revoke': { scope: 'org', org: ADM },
	'audit.read': { scope: 'org', org: ADM },
	'audit.export': { scope: 'org', org: ADM },
	'notification.read': { scope: 'org', org: ALL },
	'notification.manage': { scope: 'org', org: ADM },
	'integration.read': { scope: 'org', org: NOBILL },
	'integration.manage': { scope: 'org', org: ADM },
	'repo.read': { scope: 'org', org: NOBILL },
	'repo.manage': { scope: 'org', org: DEV },
	'repo.connect': { scope: 'org', org: ADM, sessionOnly: true, stepUp: true },
	'template.read': { scope: 'org', org: NOBILL },
	'template.manage': { scope: 'org', org: DEV },
	// #endregion

	// #region billing and cost
	'billing.read': { scope: 'org', org: OAB },
	'billing.manage': { scope: 'org', org: OB },
	'billing.portal': { scope: 'org', org: OB, sessionOnly: true },
	'usage.read': { scope: 'org', org: MONEY },
	'cost-center.read': { scope: 'org', org: OAB },
	'cost-center.manage': { scope: 'org', org: OAB },
	'procurement.read': { scope: 'org', org: OAB },
	'procurement.manage': { scope: 'org', org: OB },
	// #endregion

	// #region fleet and operations
	'operation.read': { scope: 'org', org: NOBILL },
	'operation.approve': { scope: 'org', org: ADM },
	'operation.cancel': { scope: 'org', org: DEV },
	'operation.retry': { scope: 'org', org: DEV },
	'plane.read': { scope: 'org', org: NOBILL },
	'plane.manage': { scope: 'org', org: ADM },
	'plane.connect': { scope: 'department', org: DEV, sessionOnly: true },
	'node.read': { scope: 'org', org: NOBILL },
	'node.pair': { scope: 'org', org: ADM, sessionOnly: true, stepUp: true },
	'node.revoke': { scope: 'org', org: ADM, stepUp: true },
	'release.read': { scope: 'org', org: NOBILL },
	'release.manage': { scope: 'org', org: ADM },
	'import.manage': { scope: 'org', org: DEV },
	'cutover.manage': { scope: 'org', org: ADM },
	'assessment.read': { scope: 'org', org: NOBILL },
	'assessment.manage': { scope: 'org', org: DEV },
	'fleet.bulk-destructive': {
		scope: 'org',
		org: ADM,
		stepUp: true,
		budget: 'destructive-sites'
	},
	// #endregion

	// #region agency, transfer and pilot
	'client.read': { scope: 'org', org: ADM },
	'client.manage': { scope: 'org', org: ADM, entitlement: 'agency' },
	'transfer.read': { scope: 'org', org: ADM },
	'transfer.accept': { scope: 'org', org: OWN, stepUp: true },
	'pilot.read': { scope: 'org', org: NOBILL, entitlement: 'pilots' },
	'pilot.manage': { scope: 'org', org: ADM, entitlement: 'pilots' },
	// #endregion

	// #region site
	'site.read': { scope: 'site', org: NOBILL, site: SV },
	'site.create': { scope: 'department', org: DEV },
	'site.update': { scope: 'site', org: DEV, site: SA },
	'site.delete': {
		scope: 'site',
		org: ADM,
		site: SA,
		stepUp: true,
		budget: 'destructive-sites'
	},
	'site.transfer': { scope: 'site', org: ADM, stepUp: true },
	'site.classification.set': { scope: 'site', org: ADM },
	'site.deploy': { scope: 'site', org: DEV, site: SM, budget: 'production-deploys' },
	'site.rollback': { scope: 'site', org: DEV, site: SM },
	'site.upgrade': { scope: 'site', org: DEV, site: SM },
	'site.cleanup': { scope: 'site', org: DEV, site: SM },
	'site.adopt': { scope: 'site', org: ADM, site: SA, sessionOnly: true, stepUp: true },
	'site.cutover': { scope: 'site', org: ADM, site: SA, sessionOnly: true, stepUp: true },
	'site.cutover.decide': { scope: 'site', org: ADM, site: SA, sessionOnly: true, stepUp: true },
	'site.cutover.read': { scope: 'site', org: ADM, site: SA },
	'site.pull': { scope: 'site', org: DEV, site: SM },
	'site.modify': { scope: 'site', org: DEV, site: SM },
	'site.heal': { scope: 'site', org: DEV, site: SM },
	'site.git.manage': { scope: 'site', org: DEV, site: SA },
	'site.remote.manage': { scope: 'site', org: DEV, site: SA },
	'site.domain.manage': { scope: 'site', org: ADM, site: SA },
	'site.domain.rename': { scope: 'site', org: ADM, site: SA, stepUp: true },
	'site.credentials.rotate': { scope: 'site', org: ADM, stepUp: true },
	'site.owner-token.reveal': { scope: 'site', org: ADM, sessionOnly: true, stepUp: true },
	'site.owner-token.rotate': { scope: 'site', org: ADM, sessionOnly: true, stepUp: true },
	'site.logs.read': { scope: 'site', org: DEV, site: SM, content: true },
	'site.database.read': { scope: 'site', org: DEV, site: SA, content: true },
	'site.backup.create': { scope: 'site', org: DEV, site: SM },
	'site.backup.restore': { scope: 'site', org: ADM, site: SA },
	'site.backup.download': { scope: 'site', org: ADM, site: SA, content: true },
	'site.backup': { scope: 'department', org: DEV },
	'site.restore': { scope: 'department', org: ADM, budget: 'destructive-sites' },
	'site.backup.export': { scope: 'department', org: ADM, sessionOnly: true, content: true },
	'site.environment.manage': {
		scope: 'site',
		org: DEV,
		site: SA,
		entitlement: 'environments'
	},
	'site.preview.manage': { scope: 'site', org: DEV, site: SM, entitlement: 'previews' },
	'site.access.manage': { scope: 'site', org: ADM, site: SA },
	'site.grant.manage': { scope: 'site', org: ADM, site: SA },
	...configDefs,
	// #endregion

	// #region platform admin
	'admin.aggregates.read': { scope: 'admin', platform: 'read' },
	'admin.metadata.read': { scope: 'admin', platform: 'read' },
	'admin.capacity.read': { scope: 'admin', platform: 'read' },
	'admin.audit.read': { scope: 'admin', platform: 'read' },
	'admin.abuse.manage': { scope: 'admin', platform: 'support' },
	'admin.break-glass.start': { scope: 'admin', platform: 'support', stepUp: true },
	'admin.billing.support': { scope: 'admin', platform: 'billing_support' },
	'admin.infrastructure.manage': { scope: 'admin', platform: 'infrastructure' }
	// #endregion
} as const satisfies Record<string, ActionDef>;

export type Action = keyof typeof ACTION_DEFS;

export const ACTIONS = Object.keys(ACTION_DEFS) as Action[];

export function isAction(value: unknown): value is Action {
	return typeof value === 'string' && Object.hasOwn(ACTION_DEFS, value);
}

export function actionDef(action: Action): ActionDef {
	return ACTION_DEFS[action];
}

function roleTable<R extends string>(
	roles: readonly R[],
	pick: (def: ActionDef) => readonly R[] | undefined
): Record<R, readonly Action[]> {
	const out = {} as Record<R, Action[]>;
	for (const role of roles) {
		out[role] = ACTIONS.filter((action) => pick(actionDef(action))?.includes(role));
	}
	return out;
}

export const ORG_ROLE_ACTIONS = roleTable(ORG_ROLES, (def) => def.org);
export const SITE_ROLE_ACTIONS = roleTable(SITE_ROLES, (def) => def.site);

export function isOrgRole(value: unknown): value is OrgRole {
	return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

export function isSiteRole(value: unknown): value is SiteRole {
	return typeof value === 'string' && (SITE_ROLES as readonly string[]).includes(value);
}

export const SESSION_ONLY_ACTIONS = ACTIONS.filter((a) => actionDef(a).sessionOnly === true);
export const STEP_UP_ACTIONS = ACTIONS.filter((a) => actionDef(a).stepUp === true);

// admin actions never take a key, whether or not they carry the flag
export function isSessionOnly(action: Action): boolean {
	const def = actionDef(action);
	return def.sessionOnly === true || def.scope === 'admin';
}

export const SUSPENDED_ORG_ACTIONS: readonly Action[] = [
	'org.read',
	'billing.read',
	'billing.manage',
	'billing.portal',
	'audit.read'
];

export const SUPPORT_ROLES = ['viewer', 'developer'] as const satisfies readonly OrgRole[];
export type SupportRole = (typeof SUPPORT_ROLES)[number];
export const BREAK_GLASS_ROLE: SupportRole = 'developer';

export const BASTION_ROLES = {
	'site-admin': 'tenant-admin',
	maintainer: 'tenant-admin',
	viewer: 'tenant-viewer'
} as const satisfies Record<SiteRole, 'tenant-admin' | 'tenant-viewer'>;

export const PLATFORM_ADMIN_BASTION_ROLE = null;

export const PUBLIC_ACTIONS = [
	'auth.code.request',
	'auth.code.verify',
	'auth.passkey.options',
	'auth.passkey.verify',
	'auth.oauth.providers',
	'auth.oauth.start',
	'auth.oauth.callback',
	'auth.logout',
	'node.claim'
] as const;
export type PublicAction = (typeof PUBLIC_ACTIONS)[number];

export function isPublicAction(value: unknown): value is PublicAction {
	return typeof value === 'string' && (PUBLIC_ACTIONS as readonly string[]).includes(value);
}
