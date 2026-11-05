import { describe, expect, it } from 'vitest';
import {
	CLASSIFICATIONS,
	PolicyGroupMissingError,
	defaultPolicyGroupId,
	evaluatePolicy,
	grantProvides,
	grantReaches,
	matchesPattern,
	resolvePolicyGroups,
	type PolicyGroup
} from '../../../src/server/domain/policy';
import { ACTIONS, ORG_ROLES, ORG_ROLE_ACTIONS, actionDef } from '../../../src/shared/permissions';

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
