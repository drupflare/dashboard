import type { Finding } from './recipes';

export interface FindingCopy {
	title: string;
	// what to change; null when the finding asks for nothing
	change: string | null;
}

const BUNDLE_ERROR_COPY = 'The bundle is too large or its files do not match its manifest.';

export const FINDING_COPY: Record<string, FindingCopy> = {
	'main-missing': {
		title: 'No entry file is set',
		change: 'Set main in wrangler.jsonc to your built entry file.'
	},
	'main-not-found': {
		title: 'The entry file is not in the archive',
		change: 'Add the built file that main names, or fix the path.'
	},
	'main-not-built': {
		title: 'The entry file is source code',
		change: 'Build your project and upload the JavaScript it produces.'
	},
	'compat-date-missing': {
		title: 'No compatibility date is set',
		change: 'Set compatibility_date to the day you built and tested the code.'
	},
	'compat-date-invalid': {
		title: 'The compatibility date is not a date',
		change: 'Write compatibility_date as YYYY-MM-DD.'
	},
	'compat-date-future': {
		title: 'The compatibility date is in the future',
		change: 'Use a date that has already passed.'
	},
	'binding-unverified': {
		title: 'A setting the platform cannot run yet',
		change: 'Remove it from wrangler.jsonc, or keep it out of this site.'
	},
	'config-invalid': {
		title: 'A setting in wrangler.jsonc is malformed',
		change: 'Fix the setting named below and upload again.'
	},
	'binding-name-invalid': {
		title: 'A binding name cannot be used',
		change: 'Use letters, digits and underscores, starting with a letter.'
	},
	'binding-name-too-long': {
		title: 'A binding name is too long',
		change: 'Shorten the binding name.'
	},
	'binding-name-duplicate': {
		title: 'Two bindings share a name',
		change: 'Give each binding its own name.'
	},
	'durable-object-foreign': {
		title: 'A stateful class belongs to another script',
		change: 'Remove script_name and environment so the class lives in this bundle.'
	},
	'durable-object-no-migration': {
		title: 'A stateful class has no migration',
		change: 'Add a migrations step that lists the class in new_sqlite_classes.'
	},
	'var-unsupported': {
		title: 'A variable holds a value that is not plain',
		change: 'Use text, a number, true or false.'
	},
	'service-target-unknown': {
		title: 'A service binding points at another script',
		change: 'Remove the service binding; this site cannot call other scripts yet.'
	},
	'cron-not-applied': {
		title: 'Schedules will not run',
		change: null
	},
	'cron-unobserved': {
		title: 'Schedules cannot be checked',
		change: null
	},
	'queue-producer-unchecked': {
		title: 'Queue sending is not checked',
		change: null
	},
	'route-not-applied': {
		title: 'Routes are ignored',
		change: null
	},
	'env-ignored': {
		title: 'Environment overrides are ignored',
		change: null
	},
	'limits-ignored': {
		title: 'Limits are ignored',
		change: null
	},
	'placement-ignored': {
		title: 'Placement is ignored',
		change: null
	},
	'd1-migrations-not-applied': {
		title: 'Database migration files are not run',
		change: null
	},
	'assets-empty': {
		title: 'The assets folder is empty',
		change: null
	},
	'connect-unseen': {
		title: 'Outbound connections are not checked',
		change: null
	}
};

// the engine's bundle error codes, which the spec checks against the engine's own list
export const BUNDLE_ERROR_CODE_LIST = [
	'malformed',
	'missing_hash',
	'missing_main',
	'duplicate_path',
	'count_mismatch',
	'oversize_module',
	'oversize_asset',
	'oversize_bundle',
	'too_many_assets',
	'hash_mismatch',
	'size_mismatch',
	'invalid_limits'
];

for (const code of BUNDLE_ERROR_CODE_LIST) {
	FINDING_COPY[code] = {
		title: BUNDLE_ERROR_COPY,
		change: 'Rebuild the bundle and upload it again.'
	};
}

export const GENERIC_FINDING: FindingCopy = {
	title: 'Something in the bundle needs a look',
	change: null
};

export function explainFinding(finding: Pick<Finding, 'code'>): FindingCopy {
	return FINDING_COPY[finding.code] ?? GENERIC_FINDING;
}

// what the upload route returns for a refused archive, by its reason
export const ARCHIVE_REASON_COPY: Record<string, string> = {
	archive_too_large: 'The archive is over 16 MiB. Upload only the built files.',
	archive_expanded_too_large: 'The archive unpacks to more than 40 MiB.',
	archive_too_many_entries: 'The archive holds more than 20,000 files.',
	archive_unsafe_path: 'The archive holds a path that leaves its own folder.',
	archive_link: 'The archive holds a link. Upload the files themselves.',
	archive_unreadable: 'The file is not a valid .tar.gz.',
	no_config: 'The archive has no wrangler.jsonc at its top level.',
	config_invalid: 'wrangler.jsonc is not valid JSON.'
};
