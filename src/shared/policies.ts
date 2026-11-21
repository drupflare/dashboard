import { z } from 'zod';
import { ACCESS_PRESET_IDS } from './access-presets';
import { ACTIONS } from './permissions';

export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'regulated'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
	public: 'Public',
	internal: 'Internal',
	restricted: 'Restricted',
	regulated: 'Regulated'
};

export const ASSIGNMENT_KINDS = ['organization', 'department', 'site', 'classification'] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

export const POLICY_RULE_IDS = [
	'blocked-actions',
	'step-up',
	'org-sign-in',
	'access-presets',
	'invite-domains',
	'backup-retention',
	'maintenance-window',
	'ring-cohorts',
	'data-locations',
	'modules',
	'egress-allow-list',
	'preview-ttl',
	'forbidden-templates'
] as const;
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

export interface PolicyRuleInfo {
	label: string;
	text: string;
	// plain words for a rule that is stored and shown but not checked yet; null when it is checked
	notEnforced: string | null;
}

export const POLICY_RULE_INFO: Record<PolicyRuleId, PolicyRuleInfo> = {
	'blocked-actions': {
		label: 'Blocked Actions',
		text: 'Nobody can do these actions, whatever role they hold.',
		notEnforced: null
	},
	'step-up': {
		label: 'Fresh Sign-In Required',
		text: 'These actions need a fresh sign-in first.',
		notEnforced: null
	},
	'org-sign-in': {
		label: 'Organization Sign-In for Admins',
		text: 'Administrators must sign in through the organization single sign-on.',
		notEnforced:
			'The session does not record how a person signed in, so nothing is blocked on this yet.'
	},
	'access-presets': {
		label: 'Permitted Access Types',
		text: 'A site can use only these ways of letting visitors in.',
		notEnforced: null
	},
	'invite-domains': {
		label: 'Email Invite Domains',
		text: 'Email invites go only to addresses at these domains.',
		notEnforced: null
	},
	'backup-retention': {
		label: 'Minimum Backup Retention',
		text: 'Backups are kept at least this many days.',
		notEnforced:
			'Backup retention is not a setting yet, so there is nothing to check it against.'
	},
	'maintenance-window': {
		label: 'Maintenance Windows',
		text: 'Upgrades and promotions start only inside these weekly windows (UTC).',
		notEnforced: null
	},
	'ring-cohorts': {
		label: 'Upgrade Rings',
		text: 'Upgrades reach these sites only in the listed rings.',
		notEnforced: null
	},
	'data-locations': {
		label: 'Data Locations',
		text: 'Site data stays in these regions.',
		notEnforced: 'Where site data lives is not tracked yet, so nothing is blocked on this.'
	},
	modules: {
		label: 'Module Lists',
		text: 'Only allowed modules install, and denied modules never do.',
		notEnforced: null
	},
	'egress-allow-list': {
		label: 'Outbound Allow-List',
		text: 'Sites may call only these hosts.',
		notEnforced: 'Outbound calls are not filtered per site yet, so nothing is blocked on this.'
	},
	'preview-ttl': {
		label: 'Preview Lifetime Cap',
		text: 'A preview lives at most this many hours.',
		notEnforced: null
	},
	'forbidden-templates': {
		label: 'Forbidden Templates',
		text: 'A new site cannot start from these templates.',
		notEnforced: null
	}
};

const known = (pattern: string): boolean => {
	if (pattern === '*') return true;
	if (pattern.endsWith('.*')) {
		const prefix = pattern.slice(0, -1);
		return ACTIONS.some((a) => a.startsWith(prefix));
	}
	return (ACTIONS as readonly string[]).includes(pattern);
};

const actionPattern = z.string().refine(known, { message: 'Choose an action that exists' });
const actionList = z.array(actionPattern).min(1).max(60);
const word = z.string().trim().min(1).max(100);
const host = z
	.string()
	.trim()
	.toLowerCase()
	.min(3)
	.max(253)
	.regex(/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, 'Enter a host name such as example.edu');

export const maintenanceWindowSchema = z.strictObject({
	days: z.array(z.int().min(0).max(6)).min(1).max(7),
	startHour: z.int().min(0).max(23),
	hours: z.int().min(1).max(24)
});
export type MaintenanceWindow = z.infer<typeof maintenanceWindowSchema>;

export const RING_NAMES = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;

// a pattern that would block or gate the policy screens themselves is refused, so a group can
// never lock its own administrators out
const reachesPolicyManage = (pattern: string) =>
	pattern === '*' || pattern === 'policy.*' || pattern === 'policy.manage';

export const policyRulesSchema = z.strictObject({
	blockedActions: actionList
		.refine((list) => !list.some(reachesPolicyManage), {
			message: 'A policy cannot block the actions that manage policies'
		})
		.optional(),
	stepUpActions: actionList.optional(),
	requireOrgSignIn: z.boolean().optional(),
	allowedPresets: z
		.array(z.enum(ACCESS_PRESET_IDS))
		.min(1)
		.max(ACCESS_PRESET_IDS.length)
		.optional(),
	inviteDomains: z.array(host).min(1).max(50).optional(),
	minBackupRetentionDays: z.int().min(1).max(3650).optional(),
	maintenanceWindows: z.array(maintenanceWindowSchema).min(1).max(21).optional(),
	allowedRings: z.array(z.enum(RING_NAMES)).min(1).max(RING_NAMES.length).optional(),
	dataLocations: z.array(word).min(1).max(30).optional(),
	moduleAllow: z.array(word).min(1).max(500).optional(),
	moduleDeny: z.array(word).min(1).max(500).optional(),
	egressAllow: z.array(host).min(1).max(200).optional(),
	maxPreviewHours: z.int().min(1).max(336).optional(),
	forbiddenTemplates: z.array(word).min(1).max(100).optional()
});
export type PolicyRules = z.infer<typeof policyRulesSchema>;

export const ruleIdsIn = (rules: PolicyRules): PolicyRuleId[] => {
	const out: PolicyRuleId[] = [];
	if (rules.blockedActions) out.push('blocked-actions');
	if (rules.stepUpActions) out.push('step-up');
	if (rules.requireOrgSignIn) out.push('org-sign-in');
	if (rules.allowedPresets) out.push('access-presets');
	if (rules.inviteDomains) out.push('invite-domains');
	if (rules.minBackupRetentionDays !== undefined) out.push('backup-retention');
	if (rules.maintenanceWindows) out.push('maintenance-window');
	if (rules.allowedRings) out.push('ring-cohorts');
	if (rules.dataLocations) out.push('data-locations');
	if (rules.moduleAllow || rules.moduleDeny) out.push('modules');
	if (rules.egressAllow) out.push('egress-allow-list');
	if (rules.maxPreviewHours !== undefined) out.push('preview-ttl');
	if (rules.forbiddenTemplates) out.push('forbidden-templates');
	return out;
};

const nameSchema = z.string().trim().min(1).max(80);

export const policyGroupBodySchema = z.strictObject({
	name: nameSchema,
	rules: policyRulesSchema
});
export type PolicyGroupBody = z.infer<typeof policyGroupBodySchema>;

export const assignmentSchema = z.strictObject({
	kind: z.enum(ASSIGNMENT_KINDS),
	targetId: z.string().min(1).max(64)
});
export type PolicyAssignment = z.infer<typeof assignmentSchema>;

export const policyGroupViewSchema = z.strictObject({
	id: z.string(),
	name: z.string(),
	rules: policyRulesSchema,
	assignments: z.array(assignmentSchema),
	createdAt: z.string()
});
export type PolicyGroupView = z.infer<typeof policyGroupViewSchema>;

export const classificationEntrySchema = z.strictObject({
	label: z.enum(CLASSIFICATIONS),
	displayName: z.string().nullable(),
	policyId: z.string().nullable()
});
export type ClassificationEntry = z.infer<typeof classificationEntrySchema>;

export const policyListSchema = z.strictObject({
	items: z.array(policyGroupViewSchema),
	classifications: z.array(classificationEntrySchema)
});
export type PolicyList = z.infer<typeof policyListSchema>;

export const classificationNameBodySchema = z.strictObject({
	displayName: z.string().trim().min(1).max(60).nullable()
});

export const siteClassificationBodySchema = z.strictObject({
	classification: z.enum(CLASSIFICATIONS).nullable()
});
export type SiteClassificationBody = z.infer<typeof siteClassificationBodySchema>;

export const siteClassificationViewSchema = z.strictObject({
	siteId: z.string(),
	classification: z.enum(CLASSIFICATIONS).nullable()
});
export type SiteClassificationView = z.infer<typeof siteClassificationViewSchema>;

export interface PolicyBlockDetail {
	policy?: string;
	policyName?: string;
	rule?: string;
	requires?: string;
}

// the text behind "Why was this blocked"
export function policyBlockText(detail: PolicyBlockDetail): string {
	const group = detail.policyName ?? detail.policy ?? 'A policy group';
	const info = POLICY_RULE_INFO[detail.rule as PolicyRuleId];
	const rule = info ? `${info.label}: ${info.text}` : (detail.rule ?? 'a rule in the group');
	if (detail.requires === 'step-up') {
		return `The policy group "${group}" asks for a fresh sign-in first. Rule: ${rule}`;
	}
	return `The policy group "${group}" blocks this. Rule: ${rule}`;
}

// #region editor draft

export interface PolicyDraft {
	blockedActions: string;
	stepUpActions: string;
	requireOrgSignIn: boolean;
	allowedPresets: string[];
	inviteDomains: string;
	minBackupRetentionDays: string;
	windowDays: number[];
	windowStart: string;
	windowHours: string;
	// windows past the first one are kept as they were; the editor shows one
	otherWindows: MaintenanceWindow[];
	allowedRings: string[];
	dataLocations: string;
	moduleAllow: string;
	moduleDeny: string;
	egressAllow: string;
	maxPreviewHours: string;
	forbiddenTemplates: string;
}

const join = (list: readonly string[] | undefined) => (list ?? []).join(', ');
const split = (text: string): string[] =>
	text
		.split(/[\s,]+/)
		.map((part) => part.trim())
		.filter((part) => part !== '');

export function toDraft(rules: PolicyRules): PolicyDraft {
	const [first, ...rest] = rules.maintenanceWindows ?? [];
	return {
		blockedActions: join(rules.blockedActions),
		stepUpActions: join(rules.stepUpActions),
		requireOrgSignIn: rules.requireOrgSignIn === true,
		allowedPresets: [...(rules.allowedPresets ?? [])],
		inviteDomains: join(rules.inviteDomains),
		minBackupRetentionDays: rules.minBackupRetentionDays?.toString() ?? '',
		windowDays: [...(first?.days ?? [])],
		windowStart: first?.startHour.toString() ?? '2',
		windowHours: first?.hours.toString() ?? '4',
		otherWindows: rest,
		allowedRings: [...(rules.allowedRings ?? [])],
		dataLocations: join(rules.dataLocations),
		moduleAllow: join(rules.moduleAllow),
		moduleDeny: join(rules.moduleDeny),
		egressAllow: join(rules.egressAllow),
		maxPreviewHours: rules.maxPreviewHours?.toString() ?? '',
		forbiddenTemplates: join(rules.forbiddenTemplates)
	};
}

// an empty field leaves its rule out; the server checks every value
export function fromDraft(draft: PolicyDraft): unknown {
	const list = (text: string) => {
		const items = split(text);
		return items.length > 0 ? items : undefined;
	};
	const number = (value: string | number) =>
		String(value).trim() === '' ? undefined : Number(value);
	const windows = [
		...(draft.windowDays.length > 0
			? [
					{
						days: [...draft.windowDays].sort(),
						startHour: Number(draft.windowStart),
						hours: Number(draft.windowHours)
					}
				]
			: []),
		...draft.otherWindows
	];
	const out = {
		blockedActions: list(draft.blockedActions),
		stepUpActions: list(draft.stepUpActions),
		requireOrgSignIn: draft.requireOrgSignIn ? true : undefined,
		allowedPresets: draft.allowedPresets.length > 0 ? draft.allowedPresets : undefined,
		inviteDomains: list(draft.inviteDomains),
		minBackupRetentionDays: number(draft.minBackupRetentionDays),
		maintenanceWindows: windows.length > 0 ? windows : undefined,
		allowedRings: draft.allowedRings.length > 0 ? draft.allowedRings : undefined,
		dataLocations: list(draft.dataLocations),
		moduleAllow: list(draft.moduleAllow),
		moduleDeny: list(draft.moduleDeny),
		egressAllow: list(draft.egressAllow),
		maxPreviewHours: number(draft.maxPreviewHours),
		forbiddenTemplates: list(draft.forbiddenTemplates)
	};
	return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}

// #endregion
