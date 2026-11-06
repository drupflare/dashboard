import type { Plan } from '@contracts/operations';
import type { SiteConfig, SitePlane } from '@contracts/sites';

type Step = Plan['steps'][number];

export interface ConfigFacts {
	plane: SitePlane;
	r2Enabled: boolean;
	emailBindingAccepted: boolean;
	attached: readonly string[];
}

export interface ConfigChoice {
	config: SiteConfig;
	reasons: string[];
}

// a binding already on the script proves the account accepts it, whatever the probe said
function support(facts: ConfigFacts) {
	return {
		r2: facts.r2Enabled || facts.attached.includes('FILES'),
		email: facts.emailBindingAccepted || facts.attached.includes('SEND_EMAIL')
	};
}

export function chooseConfig(facts: ConfigFacts): ConfigChoice {
	const { r2, email } = support(facts);
	const reasons: string[] = [];

	if (facts.plane === 'managed') {
		reasons.push('managed plane: the account is ours, so the site gets the managed config');
		if (!r2)
			reasons.push('R2 is not enabled on this account yet and has to be before the upload');
		if (!email)
			reasons.push('the email binding is not accepted yet and has to be before the upload');
		return { config: 'managed', reasons };
	}

	if (r2 && email) {
		reasons.push(
			facts.r2Enabled
				? 'R2 is enabled on the account'
				: 'FILES is already attached to the script',
			facts.emailBindingAccepted
				? 'the account accepts the email binding'
				: 'SEND_EMAIL is already attached to the script'
		);
		return { config: 'managed', reasons };
	}

	if (!r2) reasons.push('R2 is not enabled on the account, so the config cannot bind FILES');
	if (!email) {
		reasons.push(
			'the account does not accept the email binding, so the config cannot bind SEND_EMAIL'
		);
	}
	return { config: 'canonical', reasons };
}

export interface SwitchFacts extends ConfigFacts {
	fileBytes: number;
	// bytes object storage already holds, not counting the files being moved
	objectStorageBytes: number;
}

export interface SwitchLimits {
	objectStorageLimitBytes: number;
}

export const SWITCH_REFUSAL_CODES = [
	'same_config',
	'invalid_facts',
	'account_lacks_r2',
	'account_lacks_email',
	'exceeds_object_storage'
] as const;

export interface SwitchRefusal {
	code: (typeof SWITCH_REFUSAL_CODES)[number];
	reason: string;
}

export type SwitchPlan = { ok: true; steps: Step[] } | { ok: false; refusal: SwitchRefusal };

const refuse = (code: SwitchRefusal['code'], reason: string): SwitchPlan => ({
	ok: false,
	refusal: { code, reason }
});

const isBytes = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function planSwitch(
	from: SiteConfig,
	to: SiteConfig,
	facts: SwitchFacts,
	limits: SwitchLimits
): SwitchPlan {
	if (from === to) return refuse('same_config', `the site is already on the ${to} config`);
	if (
		!isBytes(facts.fileBytes) ||
		!isBytes(facts.objectStorageBytes) ||
		!Number.isSafeInteger(limits.objectStorageLimitBytes) ||
		limits.objectStorageLimitBytes <= 0
	) {
		return refuse(
			'invalid_facts',
			'file bytes, stored bytes and the limit must be whole byte counts'
		);
	}

	if (to === 'managed') {
		const { r2, email } = support(facts);
		if (facts.plane !== 'managed' && !r2) {
			return refuse(
				'account_lacks_r2',
				'R2 is not enabled on the account, so FILES cannot be bound'
			);
		}
		if (facts.plane !== 'managed' && !email) {
			return refuse(
				'account_lacks_email',
				'the account does not accept the email binding, so SEND_EMAIL cannot be bound'
			);
		}
		return {
			ok: true,
			steps: [
				{ id: 'create-bucket', name: 'Create the site R2 bucket' },
				{ id: 'copy-files', name: 'Copy file bytes from object storage to R2' },
				{
					id: 'verify-files',
					name: 'Compare file count and bytes in R2 with object storage'
				},
				{ id: 'deploy-managed', name: 'Upload the Worker with the managed config' },
				{ id: 'verify-site', name: 'Check the site serves on the managed config' }
			]
		};
	}

	const total = facts.fileBytes + facts.objectStorageBytes;
	if (total > limits.objectStorageLimitBytes) {
		const over = total - limits.objectStorageLimitBytes;
		return refuse(
			'exceeds_object_storage',
			`${facts.fileBytes} file bytes and ${facts.objectStorageBytes} stored bytes come to ` +
				`${total}, which is ${over} over the object storage limit of ${limits.objectStorageLimitBytes}`
		);
	}
	return {
		ok: true,
		steps: [
			{ id: 'copy-files', name: 'Copy file bytes from R2 to object storage' },
			{ id: 'verify-files', name: 'Compare file count and bytes in object storage with R2' },
			{ id: 'deploy-canonical', name: 'Upload the Worker with the canonical config' },
			{ id: 'verify-site', name: 'Check the site serves on the canonical config' },
			{ id: 'retire-bucket', name: 'Delete the R2 bucket once the hold has passed' }
		]
	};
}
