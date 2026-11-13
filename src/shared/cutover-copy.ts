export type CutoverPolicyName = 'freeze' | 'read-only' | 'delta';
export type CutoverChoiceName = 'keep-new' | 'abandon-new-data' | 'export-changes';

export interface PolicyCopy {
	label: string;
	consequence: string;
}

export const POLICY_COPY: Record<CutoverPolicyName, PolicyCopy> = {
	freeze: {
		label: 'Freeze',
		consequence:
			'Your old site stops taking changes during the move. Visitors can still read it, but nobody can log in, post or submit a form until the new site is live.'
	},
	'read-only': {
		label: 'Read Only',
		consequence:
			'Your old site stays up and visitors can read it, but editors cannot save changes during the move. Form submissions are refused, so tell your editors the time first.'
	},
	delta: {
		label: 'Copy the Changes',
		consequence:
			'Your old site keeps taking changes while the new site is built. Drupflare copies what changed since the snapshot just before the switch. If the same record changed on both sides, the move stops and nothing is switched.'
	}
};

export const CHOICE_COPY: Record<CutoverChoiceName, PolicyCopy> = {
	'keep-new': {
		label: 'Keep the New Site',
		consequence: 'Stay on the new site, with everything it has accepted since the switch.'
	},
	'abandon-new-data': {
		label: 'Abandon the New Data',
		consequence:
			'Send your address back to the old site and drop what the new site accepted since the switch. Those changes are lost.'
	},
	'export-changes': {
		label: 'Export the New Changes',
		consequence:
			'Save what the new site accepted since the switch, then send your address back to the old site. You apply the saved changes to the old site yourself.'
	}
};

export const ROLLBACK_LABEL = 'Go Back Now';

export function windowSentence(policy: CutoverPolicyName, seconds: number | null): string {
	if (seconds === null) return 'The length of the window is not known yet.';
	const minutes = Math.ceil(seconds / 60);
	const span =
		seconds < 60 ? `${seconds} seconds` : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
	return policy === 'delta'
		? `Expect about ${span} while the last changes are copied and the address switches.`
		: `Expect about ${span} when your old site cannot take changes.`;
}

export function formatObservation(offsetMs: number): string {
	const minutes = offsetMs / 60_000;
	if (minutes < 60) return `${minutes} minutes`;
	const hours = minutes / 60;
	return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
