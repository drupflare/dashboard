import { describe, expect, it } from 'vitest';
import { capByPolicy } from '../../../src/server/domain/cap-by-policy';
import {
	CLASSIFICATIONS,
	PolicyGroupMissingError,
	checkAccessRule,
	checkAdminSignIn,
	checkBackupRetention,
	checkDataLocation,
	checkEgress,
	checkMaintenanceWindow,
	checkModule,
	checkPreviewTtl,
	checkRing,
	checkTemplate,
	defaultPolicyGroupId,
	evaluatePolicy,
	grantProvides,
	grantReaches,
	matchesPattern,
	operationRefusal,
	policyRulesSchema,
	resolvePolicyGroups,
	stackFor,
	toPolicyGroup,
	type PolicyGroup,
	type StoredAssignment
} from '../../../src/server/domain/policy';
import { ACTIONS, ORG_ROLES, ORG_ROLE_ACTIONS, actionDef } from '../../../src/shared/permissions';
import {
	POLICY_RULE_IDS,
	POLICY_RULE_INFO,
	fromDraft,
	policyBlockText,
	ruleIdsIn,
	toDraft,
	type PolicyRules
} from '../../../src/shared/policies';

const group = (id: string, deny: string[] = [], stepUp: string[] = []): PolicyGroup => ({
	id,
	name: id,
	rules: [{ id: `${id}-rule`, deny, stepUp }]
});

describe('grant levels', () => {
	it('lets a grant reach its own level and below, never above', () => {
		expect(grantReaches('organisation', 'org.update')).toBe(true);
		expect(grantReaches('organisation', 'site.deploy')).toBe(true);
		expect(grantReaches('department', 'member.invite')).toBe(true);
		expect(grantReaches('department', 'site.deploy')).toBe(true);
		expect(grantReaches('department', 'org.update')).toBe(false);
		expect(grantReaches('site', 'site.deploy')).toBe(true);
		expect(grantReaches('site', 'site.create')).toBe(false);
		expect(grantReaches('organisation', 'account.read')).toBe(false);
		expect(grantReaches('organisation', 'admin.aggregates.read')).toBe(false);
	});

	it('never provides more than the role holds', () => {
		for (const role of ORG_ROLES) {
			for (const action of ACTIONS) {
				const got = grantProvides({ level: 'organisation', role }, action);
				if (got) expect(ORG_ROLE_ACTIONS[role]).toContain(action);
			}
		}
	});

	it('reads a site grant through the site role table and rejects a bad role', () => {
		const site = (role: string) => ({
			level: 'site' as const,
			orgId: 'o',
			targetId: 's',
			role: role as never
		});
		expect(grantProvides(site('maintainer'), 'site.deploy')).toBe(true);
		expect(grantProvides(site('viewer'), 'site.deploy')).toBe(false);
		expect(grantProvides(site('constructor'), 'site.deploy')).toBe(false);
		expect(
			grantProvides({ level: 'organisation', role: 'constructor' as never }, 'org.read')
		).toBe(false);
	});
});

describe('policy rules', () => {
	it('matches exact, prefix and wildcard patterns', () => {
		expect(matchesPattern('site.deploy', 'site.deploy')).toBe(true);
		expect(matchesPattern('site.deploy', 'site.rollback')).toBe(false);
		expect(matchesPattern('site.*', 'site.config.security.write')).toBe(true);
		expect(matchesPattern('site.*', 'sites.read')).toBe(false);
		expect(matchesPattern('*', 'anything')).toBe(true);
	});

	it('denies by rule and names the policy and rule', () => {
		const groups = [group('open'), group('freeze', ['site.deploy', 'site.config.*'])];
		expect(evaluatePolicy(groups, 'site.deploy', { stepUp: true })).toEqual({
			reason: 'policy_denied',
			policy: 'freeze',
			rule: 'freeze-rule'
		});
		expect(evaluatePolicy(groups, 'site.read', { stepUp: true })).toBeNull();
	});

	it('requires a step-up unless one is fresh, and a deny wins over a step-up', () => {
		const groups = [group('p', ['site.delete'], ['site.deploy', 'site.delete'])];
		expect(evaluatePolicy(groups, 'site.deploy', { stepUp: false })).toMatchObject({
			reason: 'step_up_required'
		});
		expect(evaluatePolicy(groups, 'site.deploy', { stepUp: true })).toBeNull();
		expect(evaluatePolicy(groups, 'site.delete', { stepUp: false })).toMatchObject({
			reason: 'policy_denied'
		});
	});

	it('is a no-op with no groups', () => {
		for (const a of ACTIONS) expect(evaluatePolicy([], a, { stepUp: false })).toBeNull();
	});
});

describe('classification and resolution', () => {
	it('picks a default group per label and honours an organisation mapping', () => {
		for (const label of CLASSIFICATIONS) {
			expect(defaultPolicyGroupId(label)).toBe(`classification:${label}`);
		}
		expect(defaultPolicyGroupId('regulated', { regulated: 'disc-3' })).toBe('disc-3');
		expect(defaultPolicyGroupId('public', { regulated: 'disc-3' })).toBe(
			'classification:public'
		);
	});

	it('stacks organisation, department, site and classification groups once each', () => {
		const groups = new Map(
			['a', 'b', 'c', 'classification:restricted'].map((id) => [id, group(id)] as const)
		);
		const got = resolvePolicyGroups(
			{
				organisation: ['a'],
				department: ['b', 'a'],
				site: ['c'],
				classification: 'restricted'
			},
			groups
		);
		expect(got.map((g) => g.id)).toEqual(['a', 'b', 'c', 'classification:restricted']);
	});

	it('fails closed when an assigned group does not exist', () => {
		const groups = new Map([['a', group('a')]]);
		expect(() =>
			resolvePolicyGroups({ organisation: ['a', 'x'], department: [], site: ['y'] }, groups)
		).toThrow(PolicyGroupMissingError);
		try {
			resolvePolicyGroups({ organisation: ['x'], department: [], site: [] }, groups);
		} catch (e) {
			expect((e as PolicyGroupMissingError).missing).toEqual(['x']);
		}
	});

	it('keeps the scope table consistent with grant reach', () => {
		for (const a of ACTIONS) {
			const scope = actionDef(a).scope;
			if (scope === 'org') expect(grantReaches('department', a)).toBe(false);
		}
	});
});

const named = (id: string, rules: PolicyRules): PolicyGroup =>
	toPolicyGroup({ id, name: `Group ${id}`, rules });
// 0 is Sunday; 2026-11-22 is a Sunday
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, 22 + day, hour, minute);

describe('the rules schema', () => {
	it('accepts a full rule set and refuses unknown keys', () => {
		const full = {
			blockedActions: ['site.delete'],
			stepUpActions: ['site.*'],
			requireOrgSignIn: true,
			allowedPresets: ['members', 'sso'],
			inviteDomains: ['example.edu'],
			minBackupRetentionDays: 30,
			maintenanceWindows: [{ days: [0, 6], startHour: 2, hours: 4 }],
			allowedRings: ['R3'],
			dataLocations: ['us'],
			moduleAllow: ['views'],
			moduleDeny: ['devel'],
			egressAllow: ['api.example.edu'],
			maxPreviewHours: 48,
			forbiddenTemplates: ['tpl']
		};
		expect(policyRulesSchema.safeParse(full).success).toBe(true);
		expect(ruleIdsIn(full as PolicyRules)).toEqual([...POLICY_RULE_IDS]);
		expect(policyRulesSchema.safeParse({ nope: 1 }).success).toBe(false);
	});

	it('refuses an action that does not exist, a bad host and out-of-range numbers', () => {
		const bad = (rules: unknown) => policyRulesSchema.safeParse(rules).success;
		expect(bad({ stepUpActions: ['site.fly'] })).toBe(false);
		expect(bad({ stepUpActions: ['nothing.*'] })).toBe(false);
		expect(bad({ inviteDomains: ['not a host'] })).toBe(false);
		expect(bad({ maxPreviewHours: 0 })).toBe(false);
		expect(bad({ maxPreviewHours: 400 })).toBe(false);
		expect(bad({ minBackupRetentionDays: 0 })).toBe(false);
		expect(bad({ maintenanceWindows: [{ days: [7], startHour: 1, hours: 1 }] })).toBe(false);
	});

	it('refuses a block that would lock out the people who manage policies', () => {
		for (const pattern of ['*', 'policy.*', 'policy.manage']) {
			expect(
				policyRulesSchema.safeParse({ blockedActions: [pattern] }).success,
				pattern
			).toBe(false);
		}
		expect(policyRulesSchema.safeParse({ blockedActions: ['site.*'] }).success).toBe(true);
	});

	it('has plain words for every rule and says which ones are not enforced yet', () => {
		for (const id of POLICY_RULE_IDS) {
			expect(POLICY_RULE_INFO[id].label).not.toBe('');
			expect(POLICY_RULE_INFO[id].text).not.toBe('');
		}
		const stored = POLICY_RULE_IDS.filter((id) => POLICY_RULE_INFO[id].notEnforced !== null);
		expect(stored).toEqual([
			'org-sign-in',
			'backup-retention',
			'data-locations',
			'egress-allow-list'
		]);
	});
});

describe('stored groups become the stack authorize reads', () => {
	it('compiles blocked and step-up actions into named rules', () => {
		const g = named('a', { blockedActions: ['site.delete'], stepUpActions: ['site.deploy'] });
		expect(g.rules).toEqual([
			{ id: 'blocked-actions', deny: ['site.delete'] },
			{ id: 'step-up', stepUp: ['site.deploy'] }
		]);
		expect(evaluatePolicy([g], 'site.delete', { stepUp: true })).toEqual({
			reason: 'policy_denied',
			policy: 'a',
			rule: 'blocked-actions'
		});
	});

	const groups = new Map(
		['org', 'dept-top', 'dept-low', 'site', 'restricted', 'other'].map((id) => [
			id,
			named(id, {})
		])
	);
	const assignments: StoredAssignment[] = [
		{ groupId: 'org', kind: 'organization', targetId: 'o' },
		{ groupId: 'dept-top', kind: 'department', targetId: 'top' },
		{ groupId: 'dept-low', kind: 'department', targetId: 'low' },
		{ groupId: 'site', kind: 'site', targetId: 's1' },
		{ groupId: 'restricted', kind: 'classification', targetId: 'restricted' },
		{ groupId: 'other', kind: 'site', targetId: 's2' }
	];

	it('stacks organisation, then departments from the root down, then the site, then the label', () => {
		const got = stackFor({
			groups,
			assignments,
			orgId: 'o',
			chain: ['low', 'top'],
			siteId: 's1',
			classification: 'restricted'
		});
		expect(got.map((g) => g.id)).toEqual(['org', 'dept-top', 'dept-low', 'site', 'restricted']);
	});

	it('leaves out groups assigned elsewhere and a label with no default group', () => {
		const got = stackFor({
			groups,
			assignments,
			orgId: 'o',
			chain: ['top'],
			siteId: 's2',
			classification: 'regulated'
		});
		expect(got.map((g) => g.id)).toEqual(['org', 'dept-top', 'other']);
		expect(stackFor({ groups, assignments, orgId: 'other-org' })).toEqual([]);
	});

	it('picks the default group of a site from its label alone', () => {
		const got = stackFor({ groups, assignments, orgId: 'o2', classification: 'restricted' });
		expect(got.map((g) => g.id)).toEqual(['restricted']);
	});
});

describe('capByPolicy', () => {
	const actions = new Set(['site.deploy', 'site.read'] as const);

	it('returns the same set when no group applies', () => {
		expect(capByPolicy(actions, { policy: [] })).toBe(actions);
	});

	it('removes blocked actions and keeps the rest', () => {
		const got = capByPolicy(actions, {
			policy: [named('a', { blockedActions: ['site.deploy'] })]
		});
		expect([...got]).toEqual(['site.read']);
	});

	it('does not treat a step-up requirement as a cap', () => {
		const got = capByPolicy(actions, {
			policy: [named('a', { stepUpActions: ['site.deploy'] })]
		});
		expect(got.has('site.deploy')).toBe(true);
	});
});

describe('named rule checks', () => {
	it('refuses an access type outside the permitted set and names group and rule', () => {
		const g = named('a', { allowedPresets: ['members', 'sso'] });
		expect(checkAccessRule([g], { preset: 'password' })).toMatchObject({
			status: 'blocked',
			policy: 'a',
			policyName: 'Group a',
			rule: 'access-presets'
		});
		expect(checkAccessRule([g], { preset: 'sso' })).toBeNull();
	});

	it('refuses an email invite to an address outside the permitted domains', () => {
		const g = named('a', { inviteDomains: ['example.edu'] });
		const bad = checkAccessRule([g], {
			preset: 'email-invite',
			emails: ['a@example.edu', 'b@gmail.com']
		});
		expect(bad).toMatchObject({ status: 'blocked', rule: 'invite-domains' });
		expect(
			checkAccessRule([g], { preset: 'email-invite', emails: ['a@cs.example.edu'] })
		).toBeNull();
		expect(checkAccessRule([g], { preset: 'members' })).toBeNull();
	});

	it('checks the strictest minimum backup retention, and says not enforced with no setting', () => {
		const groups = [
			named('a', { minBackupRetentionDays: 14 }),
			named('b', { minBackupRetentionDays: 30 })
		];
		expect(checkBackupRetention(groups, { days: 20 })).toMatchObject({
			status: 'blocked',
			policy: 'b',
			rule: 'backup-retention'
		});
		expect(checkBackupRetention(groups, { days: 30 })).toBeNull();
		expect(checkBackupRetention(groups, {})).toMatchObject({
			status: 'not-enforced',
			rule: 'backup-retention'
		});
		expect(checkBackupRetention([named('c', {})], { days: 1 })).toBeNull();
	});

	it('allows a start inside a maintenance window and refuses one outside', () => {
		const g = named('a', { maintenanceWindows: [{ days: [0], startHour: 2, hours: 4 }] });
		expect(checkMaintenanceWindow([g], { now: at(0, 3) })).toBeNull();
		expect(checkMaintenanceWindow([g], { now: at(0, 1, 59) })).toMatchObject({
			status: 'blocked',
			rule: 'maintenance-window'
		});
		expect(checkMaintenanceWindow([g], { now: at(0, 6) })).toMatchObject({ status: 'blocked' });
		expect(checkMaintenanceWindow([g], { now: at(1, 3) })).toMatchObject({ status: 'blocked' });
	});

	it('lets a window run past midnight into the next day', () => {
		const g = named('a', { maintenanceWindows: [{ days: [6], startHour: 22, hours: 6 }] });
		expect(checkMaintenanceWindow([g], { now: at(6, 23) })).toBeNull();
		expect(checkMaintenanceWindow([g], { now: at(7, 3) })).toBeNull();
		expect(checkMaintenanceWindow([g], { now: at(7, 4) })).toMatchObject({ status: 'blocked' });
	});

	it('refuses a ring outside the permitted cohorts', () => {
		const g = named('a', { allowedRings: ['R3', 'R4'] });
		expect(checkRing([g], { ring: 'R0' })).toMatchObject({
			status: 'blocked',
			rule: 'ring-cohorts'
		});
		expect(checkRing([g], { ring: 'R3' })).toBeNull();
	});

	it('says data location and outbound allow-list rules are saved, not enforced', () => {
		const g = named('a', { dataLocations: ['us'], egressAllow: ['api.example.edu'] });
		const place = checkDataLocation([g], { location: 'eu' });
		expect(place).toMatchObject({
			status: 'not-enforced',
			policy: 'a',
			rule: 'data-locations'
		});
		expect(place?.status === 'not-enforced' && place.reason).toBe(
			POLICY_RULE_INFO['data-locations'].notEnforced
		);
		expect(checkEgress([g], { host: 'evil.test' })).toMatchObject({
			status: 'not-enforced',
			rule: 'egress-allow-list'
		});
		expect(checkDataLocation([named('b', {})], {})).toBeNull();
		expect(checkEgress([], {})).toBeNull();
	});

	it('applies deny and allow lists for modules, ignoring case', () => {
		const g = named('a', { moduleDeny: ['devel'], moduleAllow: ['views', 'pathauto'] });
		expect(checkModule([g], { name: 'Devel' })).toMatchObject({
			status: 'blocked',
			rule: 'modules'
		});
		expect(checkModule([g], { name: 'webform' })).toMatchObject({ status: 'blocked' });
		expect(checkModule([g], { name: 'Views' })).toBeNull();
		expect(checkModule([named('b', { moduleDeny: ['devel'] })], { name: 'views' })).toBeNull();
	});

	it('caps previews at the strictest lifetime and names the tighter group', () => {
		const groups = [
			named('wide', { maxPreviewHours: 72 }),
			named('tight', { maxPreviewHours: 24 })
		];
		expect(checkPreviewTtl(groups, { hours: 48 })).toMatchObject({
			status: 'blocked',
			policy: 'tight',
			rule: 'preview-ttl'
		});
		expect(checkPreviewTtl(groups, { hours: 24 })).toBeNull();
		const tie = [named('far', { maxPreviewHours: 24 }), named('near', { maxPreviewHours: 24 })];
		expect(checkPreviewTtl(tie, { hours: 25 })).toMatchObject({ policy: 'near' });
	});

	it('refuses a forbidden template', () => {
		const g = named('a', { forbiddenTemplates: ['legacy'] });
		expect(checkTemplate([g], { template: 'legacy' })).toMatchObject({
			status: 'blocked',
			rule: 'forbidden-templates'
		});
		expect(checkTemplate([g], { template: 'modern' })).toBeNull();
	});

	it('checks organization sign-in for administrators only, and says not enforced when unknown', () => {
		const g = named('a', { requireOrgSignIn: true });
		expect(checkAdminSignIn([g], { admin: false, method: 'other' })).toBeNull();
		expect(checkAdminSignIn([g], { admin: true, method: 'organisation' })).toBeNull();
		expect(checkAdminSignIn([g], { admin: true, method: 'other' })).toMatchObject({
			status: 'blocked',
			rule: 'org-sign-in'
		});
		expect(checkAdminSignIn([g], { admin: true })).toMatchObject({ status: 'not-enforced' });
	});

	it('writes a refusal that names the group and the rule label', () => {
		const out = checkTemplate([named('a', { forbiddenTemplates: ['x'] })], { template: 'x' });
		expect(out?.status === 'blocked' && out.message).toContain('"Group a"');
		expect(out?.status === 'blocked' && out.message).toContain('Forbidden Templates');
	});
});

describe('operation preflight', () => {
	const stack = [
		named('a', {
			moduleDeny: ['devel'],
			maintenanceWindows: [{ days: [0], startHour: 2, hours: 4 }],
			allowedRings: ['R3'],
			dataLocations: ['us']
		})
	];

	it('blocks a module install on the deny list before it starts', () => {
		expect(
			operationRefusal(stack, {
				type: 'module.install',
				inputs: { name: 'devel' },
				now: at(0, 3)
			})
		).toMatchObject({ status: 'blocked', policy: 'a', rule: 'modules' });
		expect(
			operationRefusal(stack, {
				type: 'module.enable',
				inputs: { name: 'views' },
				now: at(0, 3)
			})
		).toBeNull();
	});

	it('blocks an upgrade outside the window or outside the permitted rings', () => {
		expect(operationRefusal(stack, { type: 'site.upgrade', now: at(2, 3) })).toMatchObject({
			rule: 'maintenance-window'
		});
		expect(operationRefusal(stack, { type: 'site.upgrade', now: at(0, 3) })).toBeNull();
		expect(
			operationRefusal(stack, {
				type: 'fleet.upgrade',
				inputs: { ring: 'R0' },
				now: at(0, 3)
			})
		).toMatchObject({ rule: 'ring-cohorts' });
	});

	it('passes unrelated operations, empty stacks and rules that are not enforced', () => {
		expect(operationRefusal(stack, { type: 'backup.create', now: at(2, 3) })).toBeNull();
		expect(
			operationRefusal([], { type: 'module.install', inputs: { name: 'devel' }, now: 0 })
		).toBeNull();
		expect(operationRefusal(stack, { type: 'module.install', now: at(0, 3) })).toBeNull();
	});
});

describe('block text and the editor draft', () => {
	it('says which group and rule blocked an action', () => {
		const text = policyBlockText({
			policyName: 'Regulated sites',
			rule: 'forbidden-templates'
		});
		expect(text).toContain('"Regulated sites"');
		expect(text).toContain('Forbidden Templates');
		expect(
			policyBlockText({ policy: 'pol_1', rule: 'step-up', requires: 'step-up' })
		).toContain('fresh sign-in');
		expect(policyBlockText({})).toContain('A policy group');
	});

	it('round-trips the rules through the draft and drops empty fields', () => {
		const rules: PolicyRules = {
			blockedActions: ['site.delete'],
			maintenanceWindows: [
				{ days: [0], startHour: 2, hours: 4 },
				{ days: [3], startHour: 5, hours: 2 }
			],
			maxPreviewHours: 24,
			allowedRings: ['R3']
		};
		expect(fromDraft(toDraft(rules))).toEqual(rules);
		expect(fromDraft(toDraft({}))).toEqual({});
		const draft = toDraft({});
		draft.moduleDeny = 'devel, webform\nfoo';
		expect(fromDraft(draft)).toEqual({ moduleDeny: ['devel', 'webform', 'foo'] });
	});
});
