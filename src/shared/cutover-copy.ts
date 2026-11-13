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
			'Save what the new site accepted since the switch as a SQL file, then send your address back to the old site. You apply the file to the database of your old site yourself. It cannot carry every kind of change, and the page lists what it leaves out.'
	}
};

export const SIGN_IN_COUNTS =
	'A signed-in visit to the new site counts as a change, so check it while signed out or through the preview, or going back stops being a reversal.';

// the count is the last one a check read, so the sentence says when it was true
export function writesSentence(writes: number, observed: number): string | null {
	if (observed === 0) return null;
	if (writes === 0) {
		return 'At the last check the new site had accepted no changes, so going back is a DNS reversal: your address points at the old site again and nothing is lost.';
	}
	return `At the last check the new site had accepted ${writes} ${writes === 1 ? 'change' : 'changes'}, so going back is no longer a reversal. Keep the new site, abandon its new data, or export its new changes to apply to the old site.`;
}

export type FinalChangesName = 'waiting' | 'ready' | 'none' | 'unread';

// the second read of the new site, after the address went back and old copies of it expired
export function finalChangesSentence(state: FinalChangesName, statements: number): string {
	if (state === 'waiting') {
		return 'Your address is back on the old site. Drupflare is waiting for old copies of the address to expire, then it adds the last changes the new site accepted to the file.';
	}
	if (state === 'ready') {
		return `Final changes ready. The file now holds ${statements} more ${statements === 1 ? 'change' : 'changes'} that reached the new site before visitors stopped using it. Download it again to get the whole file.`;
	}
	if (state === 'none')
		return 'No changes after the first file. The file you can download is the whole record.';
	return 'Drupflare could not read the last changes from the new site. The file holds what the new site had accepted when it was first saved, and nothing after that.';
}

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
