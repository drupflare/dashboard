export const GLOBAL_CONFIRMATION = 'global';

export interface RepairWords {
	title: string;
	found: string;
}

// owner words for each automatic catalogue row; a row without an entry shows a generic line
export const REPAIR_WORDS: Readonly<Record<string, RepairWords>> = {
	'render.empty': { title: 'Blank Page Fixed', found: 'Pages came back blank.' },
	'render.size_anomaly': {
		title: 'Unusual Page Size Fixed',
		found: 'Pages came back an unusual size.'
	},
	'bridge.asyncify_called': {
		title: 'PHP Restarted',
		found: 'The PHP runtime reached a state that needs a restart.'
	},
	'bridge.mask_leaked': {
		title: 'PHP Restarted',
		found: 'The PHP runtime left a leftover state behind.'
	},
	'memory.highwater_rising': {
		title: 'PHP Restarted',
		found: 'Memory use is climbing toward its limit.'
	},
	'memory.trend_rising': {
		title: 'PHP Restarted',
		found: 'Memory use has risen steadily over time.'
	},
	'pack.generation_mismatch': {
		title: 'Site Files Brought Up to Date',
		found: 'Some site files were out of date with the shipped version.'
	},
	'health.ledger_oversized': {
		title: 'Change Record Trimmed',
		found: 'The change record grew past its size limit.'
	},
	'budget.image_transforms': {
		title: 'Image Work Eased',
		found: 'Image processing reached its allowance.'
	},
	'budget.rows_written': {
		title: 'Database Writes Eased',
		found: 'Database writes reached the plan limit.'
	},
	'budget.do_requests': {
		title: 'Background Work Eased',
		found: 'Background requests reached the plan limit.'
	},
	'cache.anonymous_purity': {
		title: 'Visitor Pages Cleared',
		found: 'Pages for signed-out visitors held content meant for one person.'
	},
	reconcile: {
		title: 'Site Settings Brought Up to Date',
		found: 'Site settings had drifted from the shipped version.'
	},
	'overhead.reconcile-after-release': {
		title: 'Release Applied',
		found: 'The site had not yet picked up the latest release.'
	},
	'overhead.cache-invalidation-after-deploy': {
		title: 'Stored Pages Cleared',
		found: 'Stored pages were older than the latest update.'
	},
	'overhead.fill-rearm-after-gap': {
		title: 'Page Warming Restarted',
		found: 'Page warming had stopped partway through.'
	},
	'overhead.restore-drill': {
		title: 'Backup Checked',
		found: 'A backup had not been checked recently.'
	},
	'overhead.token-expiry': {
		title: 'Token Expiry Notice',
		found: 'A saved access token is close to expiring.'
	},
	'overhead.idle-archive-notice': {
		title: 'Idle Site Notice',
		found: 'The site has been idle long enough to archive.'
	}
};

export const GENERIC_REPAIR_WORDS: RepairWords = {
	title: 'Automatic Repair',
	found: 'The site showed a problem that the repair targets.'
};

export function repairWords(repairId: string): RepairWords {
	return REPAIR_WORDS[repairId] ?? GENERIC_REPAIR_WORDS;
}

export const UNDO_UNAVAILABLE = 'Undo is not available for this repair yet.';
export const NOT_UNDOABLE = 'This repair cannot be undone.';
