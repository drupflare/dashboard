import { z } from 'zod';

export const KEY_EXPIRY_PRESETS = ['30d', '90d', '180d', '365d'] as const;
export type KeyExpiry = (typeof KEY_EXPIRY_PRESETS)[number];

export const KEY_EXPIRY_LABELS: Record<KeyExpiry, string> = {
	'30d': '30 Days',
	'90d': '90 Days',
	'180d': '180 Days',
	'365d': '1 Year'
};

export const keyViewSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	prefix: z.string().nullable(),
	scopes: z.array(z.string()),
	createdAt: z.string(),
	lastUsedAt: z.string().nullable(),
	expiresAt: z.string().nullable(),
	revokedAt: z.string().nullable()
});
export type KeyView = z.infer<typeof keyViewSchema>;

export const keyPageSchema = z.strictObject({
	items: z.array(keyViewSchema),
	nextCursor: z.string().nullable()
});
export type KeyPage = z.infer<typeof keyPageSchema>;

export const keyCreateBodySchema = z.strictObject({
	name: z.string().trim().min(1).max(64),
	scopes: z.array(z.string().min(1).max(64)).min(1).max(200),
	expiry: z.enum(KEY_EXPIRY_PRESETS)
});
export type KeyCreateBody = z.infer<typeof keyCreateBodySchema>;

// the token is in this reply and nowhere else
export const keyCreatedSchema = keyViewSchema.extend({ token: z.string() });
export type KeyCreated = z.infer<typeof keyCreatedSchema>;

// #region state

export type KeyState = 'active' | 'expired' | 'revoked';

export function keyStateOf(key: Pick<KeyView, 'expiresAt' | 'revokedAt'>, now: number): KeyState {
	if (key.revokedAt !== null) return 'revoked';
	if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now) return 'expired';
	return 'active';
}

export const KEY_RECENT_USE_MS = 24 * 60 * 60 * 1000;

// a key that did work in the last day may be wired into something running, so revoking it asks twice
export function keyUsedRecently(key: Pick<KeyView, 'lastUsedAt'>, now: number): boolean {
	if (key.lastUsedAt === null) return false;
	const used = Date.parse(key.lastUsedAt);
	return !Number.isNaN(used) && now - used < KEY_RECENT_USE_MS;
}

// #endregion

// #region mcp command

export const MCP_ORIGIN = 'https://mymcp.gmitch215.xyz';
export const MCP_SERVER = 'drupflare';
export const KEY_PLACEHOLDER = '<paste the key>';

export interface McpFilters {
	methods?: readonly string[];
	tags?: readonly string[];
	confirm?: 'write' | 'destructive' | 'all';
}

export function mcpUrl(filters: McpFilters = {}): string {
	const list = (values: readonly string[]) => values.map(encodeURIComponent).join(',');
	const query = [
		filters.tags?.length ? `tags=${list(filters.tags)}` : '',
		filters.methods?.length ? `methods=${list(filters.methods)}` : '',
		filters.confirm ? `confirm=${filters.confirm}` : ''
	].filter(Boolean);
	return `${MCP_ORIGIN}/${MCP_SERVER}/mcp${query.length > 0 ? `?${query.join('&')}` : ''}`;
}

// the key rides in a header and never in the url, which clients log; the url is quoted because a
// shell reads ? as a wildcard
export function claudeMcpAddCommand(
	filters: McpFilters = {},
	key: string = KEY_PLACEHOLDER
): string {
	return `claude mcp add --transport http ${MCP_SERVER} '${mcpUrl(filters)}' --header "X-Mcp-Upstream-Authorization: Bearer ${key}"`;
}

// #endregion

// #region scope copy

export interface ScopeGroup {
	id: string;
	title: string;
}

export const KEY_SCOPE_GROUPS: readonly ScopeGroup[] = [
	{ id: 'sites', title: 'Sites' },
	{ id: 'site-settings', title: 'Site Settings' },
	{ id: 'backups', title: 'Backups' },
	{ id: 'domains', title: 'Domains and Access' },
	{ id: 'operations', title: 'Operations' },
	{ id: 'servers', title: 'Servers and Planes' },
	{ id: 'migration', title: 'Migration and Import' },
	{ id: 'team', title: 'People and Organization' },
	{ id: 'billing', title: 'Billing and Usage' },
	{ id: 'integrations', title: 'Integrations and Templates' },
	{ id: 'agency', title: 'Agencies and Clients' }
];

const CONFIG_AREAS = [
	['runtime', 'Runtime'],
	['content', 'Content'],
	['security', 'Security'],
	['integrations', 'Integration'],
	['appearance', 'Appearance'],
	['access', 'Access']
] as const;

const configCopy = Object.fromEntries(
	CONFIG_AREAS.flatMap(([group, noun]) => [
		[`site.config.${group}.read`, { group: 'site-settings', label: `See ${noun} Settings` }],
		[`site.config.${group}.write`, { group: 'site-settings', label: `Change ${noun} Settings` }]
	])
) as Record<string, { group: string; label: string }>;

// every action a key can hold has a line here; a spec fails when a new action has none
export const KEY_SCOPE_COPY: Record<string, { group: string; label: string }> = {
	'site.read': { group: 'sites', label: 'See Sites and Their Status' },
	'site.create': { group: 'sites', label: 'Create Sites' },
	'site.update': { group: 'sites', label: 'Rename and Edit Sites' },
	'site.classification.set': { group: 'sites', label: 'Set How Sensitive a Site Is' },
	'site.deploy': { group: 'sites', label: 'Deploy Code to a Site' },
	'site.rollback': { group: 'sites', label: 'Roll a Site Back' },
	'site.upgrade': { group: 'sites', label: 'Upgrade a Site' },
	'site.cleanup': { group: 'sites', label: 'Clean Up a Site' },
	'site.pull': { group: 'sites', label: 'Pull Code From a Repository' },
	'site.modify': { group: 'sites', label: 'Change What a Site Runs' },
	'site.heal': { group: 'sites', label: 'Repair a Site' },
	'site.git.manage': { group: 'sites', label: 'Manage Git Settings' },
	'site.remote.manage': { group: 'sites', label: 'Attach Repositories to a Site' },
	'site.logs.read': { group: 'sites', label: 'Read Site Logs' },
	'site.database.read': { group: 'sites', label: 'Read the Site Database' },
	'site.environment.manage': { group: 'sites', label: 'Manage Environments' },
	'site.preview.manage': { group: 'sites', label: 'Manage Previews' },
	'site.backup': { group: 'backups', label: 'Back Up Sites' },
	'site.backup.create': { group: 'backups', label: 'Create a Backup of One Site' },
	'site.backup.restore': { group: 'backups', label: 'Restore One Site From a Backup' },
	'site.backup.download': { group: 'backups', label: 'Download Backups' },
	'site.restore': { group: 'backups', label: 'Restore Sites' },
	'site.domain.read': { group: 'domains', label: 'See Custom Domains' },
	'site.access.manage': { group: 'domains', label: 'Manage Who Can Visit a Site' },
	'site.grant.manage': { group: 'domains', label: 'Give People Access to One Site' },
	'site.cutover.read': { group: 'migration', label: 'See Migration Cutovers' },
	'import.manage': { group: 'migration', label: 'Manage Imports' },
	'cutover.manage': { group: 'migration', label: 'Manage Cutovers' },
	'assessment.read': { group: 'migration', label: 'See Estate Assessments' },
	'assessment.manage': { group: 'migration', label: 'Run Estate Assessments' },
	...configCopy,
	'operation.read': { group: 'operations', label: 'See Operations' },
	'operation.approve': { group: 'operations', label: 'Approve Operations' },
	'operation.cancel': { group: 'operations', label: 'Cancel Operations' },
	'operation.retry': { group: 'operations', label: 'Retry Operations' },
	'release.read': { group: 'operations', label: 'See Releases' },
	'release.manage': { group: 'operations', label: 'Manage Releases' },
	'plane.read': { group: 'servers', label: 'See Planes' },
	'plane.manage': { group: 'servers', label: 'Manage Planes' },
	'node.read': { group: 'servers', label: 'See Nodes' },
	'node.site.create': { group: 'servers', label: 'Ask a Node to Add a Site' },
	'account.read': { group: 'team', label: 'Read Your Account Profile' },
	'org.read': { group: 'team', label: 'See Organization Details and the Plan' },
	'org.update': { group: 'team', label: 'Change Organization Details' },
	'org.sso.manage': { group: 'team', label: 'Manage Single Sign-On' },
	'member.read': { group: 'team', label: 'See Members' },
	'member.invite': { group: 'team', label: 'Invite Members' },
	'member.update': { group: 'team', label: 'Change Member Roles' },
	'member.remove': { group: 'team', label: 'Remove Members' },
	'department.read': { group: 'team', label: 'See Departments' },
	'department.manage': { group: 'team', label: 'Manage Departments' },
	'grant.manage': { group: 'team', label: 'Manage Access Grants' },
	'service-account.manage': { group: 'team', label: 'Manage Service Accounts' },
	'policy.read': { group: 'team', label: 'See Access Policies' },
	'policy.manage': { group: 'team', label: 'Manage Access Policies' },
	'review.read': { group: 'team', label: 'See Access Reviews' },
	'review.manage': { group: 'team', label: 'Manage Access Reviews' },
	'key.read': { group: 'team', label: 'See API Keys' },
	'audit.read': { group: 'team', label: 'Read the Audit Log' },
	'audit.export': { group: 'team', label: 'Export the Audit Log' },
	'notification.read': { group: 'team', label: 'See Notification Settings' },
	'notification.manage': { group: 'team', label: 'Change Notification Settings' },
	'billing.read': { group: 'billing', label: 'See Billing Details' },
	'billing.manage': { group: 'billing', label: 'Change the Plan and Billing' },
	'usage.read': { group: 'billing', label: 'See Usage' },
	'cost-center.read': { group: 'billing', label: 'See Cost Centers' },
	'cost-center.manage': { group: 'billing', label: 'Manage Cost Centers' },
	'procurement.read': { group: 'billing', label: 'See Procurement Records' },
	'procurement.manage': { group: 'billing', label: 'Manage Procurement Records' },
	'integration.read': { group: 'integrations', label: 'See Integrations' },
	'integration.manage': { group: 'integrations', label: 'Manage Integrations' },
	'repo.read': { group: 'integrations', label: 'See Repository Connections' },
	'repo.manage': { group: 'integrations', label: 'Manage Repository Connections' },
	'template.read': { group: 'integrations', label: 'See Templates' },
	'template.manage': { group: 'integrations', label: 'Manage Templates' },
	'delegation.read': { group: 'agency', label: 'See Agency Access' },
	'delegation.create': { group: 'agency', label: 'Give an Agency Access' },
	'delegation.accept': { group: 'agency', label: 'Accept Agency Access' },
	'delegation.revoke': { group: 'agency', label: 'End Agency Access' },
	'client.read': { group: 'agency', label: 'See Client Organizations' },
	'client.manage': { group: 'agency', label: 'Manage Client Organizations' },
	'transfer.read': { group: 'agency', label: 'See Site Transfers' },
	'pilot.read': { group: 'agency', label: 'See Pilot Workspaces' },
	'pilot.manage': { group: 'agency', label: 'Manage Pilot Workspaces' }
};

export interface ScopeChoice {
	action: string;
	label: string;
}

export interface ScopeSection {
	id: string;
	title: string;
	choices: ScopeChoice[];
}

// the groups that have something to pick, each in a stable order
export function scopeSections(offered: readonly string[]): ScopeSection[] {
	const held = new Set(offered);
	return KEY_SCOPE_GROUPS.map((group) => ({
		id: group.id,
		title: group.title,
		choices: Object.entries(KEY_SCOPE_COPY)
			.filter(([action, copy]) => copy.group === group.id && held.has(action))
			.map(([action, copy]) => ({ action, label: copy.label }))
	})).filter((section) => section.choices.length > 0);
}

// #endregion
