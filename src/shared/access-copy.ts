import type { AccessPresetId } from './access-presets';

export const PRESET_DESCRIPTIONS: Record<AccessPresetId, string> = {
	members: 'Organisation members with at least viewer access.',
	grants: 'People and groups holding a site grant, including delegated agencies.',
	'email-invite': 'Invited email addresses. Each person gets a one-time code by email.',
	'github-user': 'Named GitHub accounts. Each person proves who they are with GitHub sign-in.',
	'gitlab-user': 'Named GitLab accounts. Each person proves who they are with GitLab sign-in.',
	'github-org': 'Members of a named GitHub organisation.',
	'gitlab-group': 'Members of a named GitLab group.',
	sso: "The organisation's identity provider. Needs single sign-on set up first.",
	password: 'A shared password. Replace it by removing this rule and adding another.',
	'review-link': 'A link that stops working after a set time. Useful for client review.',
	public: 'Everyone can open it. This is the default for production.'
};

export type EnvironmentStatus = {
	icon: string;
	label: string;
	tone: string;
	sentence: string;
};

// mirrors accessGates: prod is public unless it has rules and none of them is public
export function environmentStatus(
	production: boolean,
	rules: readonly { preset: AccessPresetId }[]
): EnvironmentStatus {
	const place = production ? 'this site' : 'this environment';
	if (rules.some((rule) => rule.preset === 'public') || (production && rules.length === 0)) {
		return {
			icon: 'i-lucide-globe',
			label: 'Public',
			tone: 'text-success',
			sentence: `Public. Anyone can open ${place}.`
		};
	}
	if (rules.length > 0) {
		return {
			icon: 'i-lucide-lock-keyhole',
			label: 'Limited',
			tone: 'text-warning',
			sentence: `Limited. Only the people these rules name can open ${place}.`
		};
	}
	return {
		icon: 'i-lucide-lock',
		label: 'Private',
		tone: 'text-muted',
		sentence: `Private. Nobody can open ${place} until a rule is added.`
	};
}
