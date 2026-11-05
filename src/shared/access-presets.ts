import { z } from 'zod';

export const ACCESS_PRESET_IDS = [
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
] as const;

const PRESET_TIERS = [
	'managed-free',
	'managed-site',
	'managed-agency',
	'institution-standard'
] as const;

const accessPresetSchema = z.object({
	id: z.enum(ACCESS_PRESET_IDS),
	label: z.string().min(1),
	unlockedBy: z.enum(PRESET_TIERS).nullable(),
	source: z.string().min(1)
});

type AccessPreset = z.infer<typeof accessPresetSchema>;

export const ACCESS_PRESETS: readonly AccessPreset[] = z.array(accessPresetSchema).parse([
	{
		id: 'members',
		label: 'Members',
		unlockedBy: null,
		source: 'plan:418; plan states no tier'
	},
	{
		id: 'grants',
		label: 'Grants',
		unlockedBy: null,
		source: 'plan:419; plan states no tier'
	},
	{
		id: 'email-invite',
		label: 'Email invite',
		unlockedBy: 'managed-free',
		source: 'plan:420; plan:428 free 5 by email code'
	},
	{
		id: 'github-user',
		label: 'GitHub user',
		unlockedBy: 'managed-site',
		source: 'plan:421; plan:428 Site adds GitHub'
	},
	{
		id: 'gitlab-user',
		label: 'GitLab user',
		unlockedBy: null,
		source: 'plan:421; plan states no tier'
	},
	{
		id: 'github-org',
		label: 'GitHub organisation',
		unlockedBy: null,
		source: 'plan:422; plan states no tier'
	},
	{
		id: 'gitlab-group',
		label: 'GitLab group',
		unlockedBy: null,
		source: 'plan:422; plan states no tier'
	},
	{
		id: 'sso',
		label: 'Single sign-on',
		unlockedBy: 'institution-standard',
		source: 'plan:423; roadmap:271 SSO in Standard'
	},
	{
		id: 'password',
		label: 'Shared password',
		unlockedBy: null,
		source: 'plan:424; plan states no tier'
	},
	{
		id: 'review-link',
		label: 'Review link',
		unlockedBy: 'managed-agency',
		source: 'plan:425; plan:428 Agency 500 with review links'
	},
	{
		id: 'public',
		label: 'Public',
		unlockedBy: null,
		source: 'plan:426 default for prod; plan states no tier'
	}
]);

export const INVITEE_LIMITS = {
	'managed-free': { value: 5, label: 'assumption', source: 'plan:428; roadmap:270' },
	'managed-site': { value: 25, label: 'assumption', source: 'plan:428; roadmap:270' },
	'managed-studio': { value: 100, label: 'assumption', source: 'plan:428; roadmap:270' },
	'managed-agency': { value: 500, label: 'assumption', source: 'plan:428; roadmap:270' }
} as const;
