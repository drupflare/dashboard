import { describe, expect, it } from 'vitest';
import {
	ACCESS_PRESET_IDS,
	ACCESS_PRESETS,
	accessGates,
	evaluateAccess,
	hashLinkToken,
	hashPassword,
	INVITEE_LIMITS,
	presetUnlocked,
	ruleHash,
	type AccessPresetId,
	type AccessRule,
	type Visitor
} from '../../../src/shared/access-presets';

function preset(id: string) {
	const found = ACCESS_PRESETS.find((item) => item.id === id);
	if (!found) throw new Error(`no preset ${id}`);
	return found;
}

describe('access presets', () => {
	it('lists every preset once, in the plan order', () => {
		expect(ACCESS_PRESET_IDS).toEqual([
			'members',
			'grants',
			'email-invite',
			'github-user',
			'gitlab-user',
			'github-org',
			'gitlab-group',
			'sso',
			'password',
			'review-link',
			'public'
		]);
		expect(ACCESS_PRESETS.map((item) => item.id)).toEqual([...ACCESS_PRESET_IDS]);
	});

	it('unlocks email invites on the free plan and review links on Agency', () => {
		expect(preset('email-invite').unlockedBy).toBe('managed-free');
		expect(preset('review-link').unlockedBy).toBe('managed-agency');
		expect(preset('github-user').unlockedBy).toBe('managed-site');
	});

	it('leaves the tier null where the plan does not state one', () => {
		for (const id of ['members', 'grants', 'gitlab-user', 'github-org', 'gitlab-group']) {
			expect(preset(id).unlockedBy).toBe(null);
		}
		expect(preset('public').unlockedBy).toBe(null);
	});

	it('labels every invitee count as an assumption from the plan', () => {
		expect(INVITEE_LIMITS['managed-free']).toEqual({
			value: 5,
			label: 'assumption',
			source: 'plan:428; roadmap:270'
		});
		expect(INVITEE_LIMITS['managed-site'].value).toBe(25);
		expect(INVITEE_LIMITS['managed-studio'].value).toBe(100);
		expect(INVITEE_LIMITS['managed-agency'].value).toBe(500);
		for (const limit of Object.values(INVITEE_LIMITS)) {
			expect(limit.label).toBe('assumption');
		}
	});
});

const NOW = 1_000_000;
const rule = (
	preset: AccessPresetId,
	config: Record<string, unknown> = {},
	environment = 'staging'
): AccessRule => ({ id: `rule_${preset}`, environment, preset, config });

describe('evaluateAccess', () => {
	const salt = 'pepper';
	const cases: [string, () => Promise<[AccessRule[], Partial<Visitor>]>, boolean][] = [
		['public lets anyone in', async () => [[rule('public')], {}], true],
		['no rules denies', async () => [[], {}], false],
		['members admits a member', async () => [[rule('members')], { member: true }], true],
		['members refuses a stranger', async () => [[rule('members')], {}], false],
		['grants admits a grant holder', async () => [[rule('grants')], { grant: true }], true],
		['grants refuses without a grant', async () => [[rule('grants')], { member: true }], false],
		[
			'email invite matches ignoring case',
			async () => [[rule('email-invite', { emails: ['a@x.org'] })], { email: 'A@X.org' }],
			true
		],
		[
			'email invite refuses another address',
			async () => [[rule('email-invite', { emails: ['a@x.org'] })], { email: 'b@x.org' }],
			false
		],
		[
			'email invite refuses with no proven address',
			async () => [[rule('email-invite', { emails: ['a@x.org'] })], {}],
			false
		],
		[
			'github user matches a proven account',
			async () => [
				[rule('github-user', { users: ['octo'] })],
				{ github: { user: 'Octo', orgs: [] } }
			],
			true
		],
		[
			'github user refuses with no identity',
			async () => [[rule('github-user', { users: ['octo'] })], {}],
			false
		],
		[
			'gitlab user matches a proven account',
			async () => [
				[rule('gitlab-user', { users: ['fox'] })],
				{ gitlab: { user: 'fox', groups: [] } }
			],
			true
		],
		[
			'github org matches membership',
			async () => [
				[rule('github-org', { orgs: ['acme'] })],
				{ github: { user: 'x', orgs: ['ACME'] } }
			],
			true
		],
		[
			'github org refuses another org',
			async () => [
				[rule('github-org', { orgs: ['acme'] })],
				{ github: { user: 'x', orgs: ['other'] } }
			],
			false
		],
		[
			'gitlab group matches membership',
			async () => [
				[rule('gitlab-group', { groups: ['team'] })],
				{ gitlab: { user: 'x', groups: ['team'] } }
			],
			true
		],
		['sso admits a proven sign-in', async () => [[rule('sso')], { sso: true }], true],
		['sso refuses without sign-in', async () => [[rule('sso')], {}], false],
		[
			'password admits the right password',
			async () => [
				[
					rule('password', {
						salt,
						passwordHash: await hashPassword('correct horse', salt)
					})
				],
				{ password: 'correct horse' }
			],
			true
		],
		[
			'password refuses a wrong password',
			async () => [
				[
					rule('password', {
						salt,
						passwordHash: await hashPassword('correct horse', salt)
					})
				],
				{ password: 'wrong horse' }
			],
			false
		],
		[
			'password refuses a rule with no hash',
			async () => [[rule('password', {})], { password: 'anything' }],
			false
		],
		[
			'review link admits a live token',
			async () => [
				[
					rule('review-link', {
						tokenHash: await hashLinkToken('tok'),
						expiresAt: NOW + 5
					})
				],
				{ linkToken: 'tok' }
			],
			true
		],
		[
			'review link refuses an expired token',
			async () => [
				[rule('review-link', { tokenHash: await hashLinkToken('tok'), expiresAt: NOW })],
				{ linkToken: 'tok' }
			],
			false
		],
		[
			'review link refuses another token',
			async () => [
				[
					rule('review-link', {
						tokenHash: await hashLinkToken('tok'),
						expiresAt: NOW + 5
					})
				],
				{ linkToken: 'nope' }
			],
			false
		],
		[
			'any rule can admit',
			async () => [[rule('members'), rule('sso'), rule('grants')], { grant: true }],
			true
		]
	];

	for (const [name, build, allow] of cases) {
		it(name, async () => {
			const [rules, visitor] = await build();
			const decision = await evaluateAccess(rules, { now: NOW, ...visitor });
			expect(decision.allow).toBe(allow);
		});
	}

	it('names the rule that let a visitor in and why a visitor was refused', async () => {
		expect(await evaluateAccess([rule('members')], { now: NOW, member: true })).toEqual({
			allow: true,
			reason: 'members'
		});
		expect((await evaluateAccess([], { now: NOW })).reason).toBe('no-rules');
		expect((await evaluateAccess([rule('members')], { now: NOW })).reason).toBe('no-match');
	});
});

describe('presetUnlocked', () => {
	it('refuses a preset the plan lacks and names the plan that unlocks it', () => {
		expect(presetUnlocked('review-link', 'managed-site')).toEqual({
			ok: false,
			unlockedBy: 'managed-agency'
		});
		expect(presetUnlocked('sso', 'managed-agency')).toEqual({
			ok: false,
			unlockedBy: 'institution-standard'
		});
	});

	it('allows a preset at or above its tier and any preset with no tier', () => {
		expect(presetUnlocked('github-user', 'managed-studio')).toEqual({ ok: true });
		expect(presetUnlocked('members', 'self-hosted')).toEqual({ ok: true });
	});

	it('refuses a tiered preset on a plan outside the ladder', () => {
		expect(presetUnlocked('email-invite', 'self-hosted').ok).toBe(false);
	});
});

describe('ruleHash', () => {
	const a = rule('members');
	const b = rule('email-invite', { emails: ['a@x.org'] });

	it('gives one hash for the same rules in any order', async () => {
		expect(await ruleHash([a, b])).toBe(await ruleHash([b, a]));
		expect(await ruleHash([a, b])).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it('changes when a rule changes or goes away', async () => {
		const base = await ruleHash([a, b]);
		expect(await ruleHash([a])).not.toBe(base);
		expect(await ruleHash([a, rule('email-invite', { emails: ['c@x.org'] })])).not.toBe(base);
		expect(await ruleHash([a, b], 'dev')).not.toBe(base);
	});
});

describe('accessGates', () => {
	it('leaves a site with no rules public and gates every other environment', async () => {
		const open = await accessGates([], []);
		expect(open.gates).toEqual({});
		const withStaging = await accessGates(['env_1'], []);
		expect(Object.keys(withStaging.gates)).toEqual(['env_1']);
		expect(withStaging.accessRuleHash).not.toBe(open.accessRuleHash);
	});

	it('keeps prod public until a rule gates it, and lets a public rule open an environment', async () => {
		const prod = await accessGates([], [rule('members', {}, 'prod')]);
		expect(Object.keys(prod.gates)).toEqual(['prod']);
		const opened = await accessGates(['env_1'], [rule('public', {}, 'env_1')]);
		expect(opened.gates).toEqual({});
	});

	it('changes the site hash and the environment hash when a rule is revoked', async () => {
		const member = rule('members', {}, 'env_1');
		const invite = rule('email-invite', { emails: ['a@x.org'] }, 'env_1');
		const before = await accessGates(['env_1'], [member, invite]);
		const after = await accessGates(['env_1'], [member]);
		expect(after.gates.env_1).not.toBe(before.gates.env_1);
		expect(after.accessRuleHash).not.toBe(before.accessRuleHash);
	});
});
