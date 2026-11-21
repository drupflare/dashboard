import {
	ORG_ROLE_ACTIONS,
	SITE_ROLE_ACTIONS,
	actionDef,
	isOrgRole,
	isSiteRole,
	type Action,
	type ActionScope,
	type OrgRole,
	type SiteRole
} from '../../shared/permissions';
import {
	POLICY_RULE_INFO,
	type Classification,
	type MaintenanceWindow,
	type PolicyRuleId,
	type PolicyRules
} from '../../shared/policies';

export { CLASSIFICATIONS, policyRulesSchema, type Classification } from '../../shared/policies';

export type GrantLevel = 'organisation' | 'department' | 'site';

export type Grant =
	| { level: 'department'; orgId: string; targetId: string; role: OrgRole }
	| { level: 'site'; orgId: string; targetId: string; role: SiteRole };

export interface PolicyRule {
	id: string;
	deny?: readonly string[];
	stepUp?: readonly string[];
}

export interface PolicyGroup {
	id: string;
	name: string;
	rules: readonly PolicyRule[];
	// the typed rules the group was saved with; the named checks below read these
	settings?: PolicyRules;
}

export interface PolicyBlock {
	reason: 'policy_denied' | 'step_up_required';
	policy: string;
	rule: string;
}

export class PolicyGroupMissingError extends Error {
	constructor(readonly missing: readonly string[]) {
		super(`policy groups not found: ${missing.join(', ')}`);
		this.name = 'PolicyGroupMissingError';
	}
}

const LEVEL_RANK: Record<GrantLevel, number> = { organisation: 0, department: 1, site: 2 };
const SCOPE_RANK: Record<Exclude<ActionScope, 'account' | 'admin'>, number> = {
	org: 0,
	department: 1,
	site: 2
};

// a grant at one level gives actions addressed at that level or below, never above
export function grantReaches(level: GrantLevel, action: Action): boolean {
	const scope = actionDef(action).scope;
	if (scope === 'account' || scope === 'admin') return false;
	return SCOPE_RANK[scope] >= LEVEL_RANK[level];
}

export type AnyGrant = Grant | { level: 'organisation'; role: OrgRole };

export function grantProvides(grant: AnyGrant, action: Action): boolean {
	if (!grantReaches(grant.level, action)) return false;
	if (grant.level === 'site') {
		return isSiteRole(grant.role) && SITE_ROLE_ACTIONS[grant.role].includes(action);
	}
	return isOrgRole(grant.role) && ORG_ROLE_ACTIONS[grant.role].includes(action);
}

export function matchesPattern(pattern: string, action: string): boolean {
	if (pattern === '*') return true;
	if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
	return pattern === action;
}

export function evaluatePolicy(
	groups: readonly PolicyGroup[],
	action: Action,
	opts: { stepUp: boolean }
): PolicyBlock | null {
	for (const group of groups) {
		for (const rule of group.rules) {
			if (rule.deny?.some((p) => matchesPattern(p, action))) {
				return { reason: 'policy_denied', policy: group.id, rule: rule.id };
			}
		}
	}
	if (!opts.stepUp) {
		for (const group of groups) {
			for (const rule of group.rules) {
				if (rule.stepUp?.some((p) => matchesPattern(p, action))) {
					return { reason: 'step_up_required', policy: group.id, rule: rule.id };
				}
			}
		}
	}
	return null;
}

export function defaultPolicyGroupId(
	label: Classification,
	mapping?: Partial<Record<Classification, string>>
): string {
	return mapping?.[label] ?? `classification:${label}`;
}

export interface PolicyAssignments {
	organisation: readonly string[];
	department: readonly string[];
	site: readonly string[];
	classification?: Classification;
	classificationMapping?: Partial<Record<Classification, string>>;
}

// every assigned group applies and caps only tighten, so the stack is the most restrictive
export function resolvePolicyGroups(
	assignments: PolicyAssignments,
	groups: ReadonlyMap<string, PolicyGroup>
): PolicyGroup[] {
	const ids = [...assignments.organisation, ...assignments.department, ...assignments.site];
	if (assignments.classification) {
		ids.push(
			defaultPolicyGroupId(assignments.classification, assignments.classificationMapping)
		);
	}
	const unique = [...new Set(ids)];
	const missing = unique.filter((id) => !groups.has(id));
	if (missing.length > 0) throw new PolicyGroupMissingError(missing);
	return unique.map((id) => groups.get(id) as PolicyGroup);
}

// #region stored groups

export interface StoredAssignment {
	groupId: string;
	kind: 'organization' | 'department' | 'site' | 'classification';
	targetId: string;
}

// the typed rules become the deny and step-up rules authorize reads; the rest stay in settings
export function toPolicyGroup(row: { id: string; name: string; rules: PolicyRules }): PolicyGroup {
	const rules: PolicyRule[] = [];
	if (row.rules.blockedActions)
		rules.push({ id: 'blocked-actions', deny: row.rules.blockedActions });
	if (row.rules.stepUpActions) rules.push({ id: 'step-up', stepUp: row.rules.stepUpActions });
	return { id: row.id, name: row.name, rules, settings: row.rules };
}

// the stack for one place: organisation groups, then the department chain from the root down, then
// the site, then the default group of the site's label. `chain` runs nearest department first
export function stackFor(input: {
	groups: ReadonlyMap<string, PolicyGroup>;
	assignments: readonly StoredAssignment[];
	orgId: string;
	chain?: readonly string[];
	siteId?: string;
	classification?: Classification | null;
}): PolicyGroup[] {
	const of = (kind: StoredAssignment['kind'], target: string) =>
		input.assignments
			.filter((a) => a.kind === kind && a.targetId === target)
			.map((a) => a.groupId);
	const mapping: Partial<Record<Classification, string>> = {};
	for (const a of input.assignments) {
		if (a.kind === 'classification') mapping[a.targetId as Classification] = a.groupId;
	}
	const label = input.classification ?? undefined;
	return resolvePolicyGroups(
		{
			organisation: of('organization', input.orgId),
			department: [...(input.chain ?? [])].reverse().flatMap((id) => of('department', id)),
			site: input.siteId === undefined ? [] : of('site', input.siteId),
			...(label !== undefined && mapping[label] !== undefined
				? { classification: label, classificationMapping: mapping }
				: {})
		},
		input.groups
	);
}

// #endregion

// #region named checks

export type CheckOutcome =
	| { status: 'blocked'; policy: string; policyName: string; rule: PolicyRuleId; message: string }
	| {
			status: 'not-enforced';
			policy: string;
			policyName: string;
			rule: PolicyRuleId;
			reason: string;
	  };

const blocked = (group: PolicyGroup, rule: PolicyRuleId, message: string): CheckOutcome => ({
	status: 'blocked',
	policy: group.id,
	policyName: group.name,
	rule,
	message: `The policy group "${group.name}" blocks this (${POLICY_RULE_INFO[rule].label}). ${message}`
});

const notEnforced = (group: PolicyGroup, rule: PolicyRuleId): CheckOutcome => ({
	status: 'not-enforced',
	policy: group.id,
	policyName: group.name,
	rule,
	reason: POLICY_RULE_INFO[rule].notEnforced ?? 'This rule is not checked here.'
});

type Reader<T> = (settings: PolicyRules) => T | undefined;

// the group with the smallest value wins; on a tie the later, nearer group is named
function strictest(
	groups: readonly PolicyGroup[],
	pick: Reader<number>,
	smallest: boolean
): { group: PolicyGroup; value: number } | null {
	let best: { group: PolicyGroup; value: number } | null = null;
	for (const group of groups) {
		const value = group.settings ? pick(group.settings) : undefined;
		if (value === undefined) continue;
		if (best === null || (smallest ? value <= best.value : value >= best.value)) {
			best = { group, value };
		}
	}
	return best;
}

const holding = (groups: readonly PolicyGroup[], pick: Reader<unknown>) =>
	groups.filter((g) => g.settings && pick(g.settings) !== undefined);

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
const inDomains = (email: string, domains: readonly string[]) =>
	domains.some((d) => {
		const host = d.replace(/^\*\./, '');
		const got = domainOf(email);
		return got === host || got.endsWith(`.${host}`);
	});

export function checkAdminSignIn(
	groups: readonly PolicyGroup[],
	input: { admin: boolean; method?: 'organisation' | 'other' }
): CheckOutcome | null {
	if (!input.admin) return null;
	for (const group of holding(groups, (s) => s.requireOrgSignIn || undefined)) {
		if (input.method === undefined) return notEnforced(group, 'org-sign-in');
		if (input.method !== 'organisation') {
			return blocked(group, 'org-sign-in', 'Sign in through your organization first.');
		}
	}
	return null;
}

export function checkAccessRule(
	groups: readonly PolicyGroup[],
	input: { preset: string; emails?: readonly string[] }
): CheckOutcome | null {
	for (const group of groups) {
		const s = group.settings;
		if (s?.allowedPresets && !(s.allowedPresets as readonly string[]).includes(input.preset)) {
			return blocked(group, 'access-presets', 'That access type is not permitted here.');
		}
		if (s?.inviteDomains && input.preset === 'email-invite') {
			const outside = (input.emails ?? []).find((e) => !inDomains(e, s.inviteDomains ?? []));
			if (outside !== undefined) {
				return blocked(
					group,
					'invite-domains',
					`Invites can go only to ${s.inviteDomains.join(', ')}.`
				);
			}
		}
	}
	return null;
}

export function checkBackupRetention(
	groups: readonly PolicyGroup[],
	input: { days?: number }
): CheckOutcome | null {
	const best = strictest(groups, (s) => s.minBackupRetentionDays, false);
	if (best === null) return null;
	if (input.days === undefined) return notEnforced(best.group, 'backup-retention');
	if (input.days < best.value) {
		return blocked(best.group, 'backup-retention', `Keep backups at least ${best.value} days.`);
	}
	return null;
}

const inWindow = (w: MaintenanceWindow, at: Date): boolean => {
	const hour = at.getUTCHours() + at.getUTCMinutes() / 60;
	const day = at.getUTCDay();
	const end = w.startHour + w.hours;
	if (end <= 24) return w.days.includes(day) && hour >= w.startHour && hour < end;
	// a window that runs past midnight spills into the next day
	const spill = (day + 6) % 7;
	return (
		(w.days.includes(day) && hour >= w.startHour) || (w.days.includes(spill) && hour < end - 24)
	);
};

export function checkMaintenanceWindow(
	groups: readonly PolicyGroup[],
	input: { now: number }
): CheckOutcome | null {
	const at = new Date(input.now);
	for (const group of groups) {
		const windows = group.settings?.maintenanceWindows;
		if (windows && !windows.some((w) => inWindow(w, at))) {
			return blocked(group, 'maintenance-window', 'Start it inside a maintenance window.');
		}
	}
	return null;
}

export function checkRing(
	groups: readonly PolicyGroup[],
	input: { ring: string }
): CheckOutcome | null {
	for (const group of groups) {
		const rings = group.settings?.allowedRings as readonly string[] | undefined;
		if (rings && !rings.includes(input.ring)) {
			return blocked(
				group,
				'ring-cohorts',
				`Upgrades reach this site in ${rings.join(', ')} only.`
			);
		}
	}
	return null;
}

export function checkDataLocation(
	groups: readonly PolicyGroup[],
	_input: { location?: string }
): CheckOutcome | null {
	for (const group of holding(groups, (s) => s.dataLocations)) {
		return notEnforced(group, 'data-locations');
	}
	return null;
}

export function checkEgress(
	groups: readonly PolicyGroup[],
	_input: { host?: string }
): CheckOutcome | null {
	for (const group of holding(groups, (s) => s.egressAllow)) {
		return notEnforced(group, 'egress-allow-list');
	}
	return null;
}

export function checkModule(
	groups: readonly PolicyGroup[],
	input: { name: string }
): CheckOutcome | null {
	const name = input.name.toLowerCase();
	for (const group of groups) {
		const s = group.settings;
		if (s?.moduleDeny?.some((m) => m.toLowerCase() === name)) {
			return blocked(group, 'modules', `The module ${input.name} is on the deny list.`);
		}
		if (s?.moduleAllow && !s.moduleAllow.some((m) => m.toLowerCase() === name)) {
			return blocked(group, 'modules', `The module ${input.name} is not on the allow list.`);
		}
	}
	return null;
}

export function checkPreviewTtl(
	groups: readonly PolicyGroup[],
	input: { hours: number }
): CheckOutcome | null {
	const best = strictest(groups, (s) => s.maxPreviewHours, true);
	if (best !== null && input.hours > best.value) {
		return blocked(
			best.group,
			'preview-ttl',
			`A preview can live ${best.value} hours at most.`
		);
	}
	return null;
}

export function checkTemplate(
	groups: readonly PolicyGroup[],
	input: { template: string }
): CheckOutcome | null {
	for (const group of groups) {
		if (group.settings?.forbiddenTemplates?.includes(input.template)) {
			return blocked(group, 'forbidden-templates', 'That template is not permitted here.');
		}
	}
	return null;
}

// #endregion

// #region operation preflight

const UPGRADE_TYPES = ['site.upgrade', 'fleet.upgrade', 'env.promote'];
const text = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

// the checks an operation start runs before anything is recorded; only a block stops it
export function operationRefusal(
	groups: readonly PolicyGroup[],
	input: { type: string; inputs?: unknown; now: number }
): Extract<CheckOutcome, { status: 'blocked' }> | null {
	if (groups.length === 0) return null;
	const inputs = (input.inputs ?? {}) as Record<string, unknown>;
	const outcomes: (CheckOutcome | null)[] = [];
	if (input.type === 'module.install' || input.type === 'module.enable') {
		const name = text(inputs.name);
		if (name !== undefined) outcomes.push(checkModule(groups, { name }));
	}
	if (UPGRADE_TYPES.includes(input.type)) {
		outcomes.push(checkMaintenanceWindow(groups, { now: input.now }));
		const ring = text(inputs.ring);
		if (ring !== undefined) outcomes.push(checkRing(groups, { ring }));
	}
	return (
		(outcomes.find((o) => o?.status === 'blocked') as
			Extract<CheckOutcome, { status: 'blocked' }> | undefined) ?? null
	);
}

// #endregion
