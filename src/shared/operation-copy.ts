import type { Operation } from '@contracts/operations';
import { attachFailureReason } from './domain-copy';

// how long a deleted site's address stays reserved; dispatch/src/registry.ts holds the same number
export const SITE_HOLD_DAYS = 90;

export interface OperationLink {
	to: string;
	label: string;
}

// the words the progress screen uses for one operation type
export interface OperationCopy {
	// the heading, before and after the operation ends
	title: string;
	running: string;
	success: string;
	// the title of the panel shown when the operation fails
	failure: string;
	// shown after success; null when the screen has its own content instead
	link: (operation: Pick<Operation, 'targetIds'>) => OperationLink | null;
	// the button in the failure panel; null when the panel has its own controls
	failureLink: (operation: Pick<Operation, 'targetIds'>) => OperationLink | null;
}

const sites: OperationLink = { to: '/sites', label: 'Back to Sites' };

// every operation of these types names its site first
function siteOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[0];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}`, label: 'Back to the Site' };
}

// an adoption names the new site first and the one it came from second
function adoptedSiteOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[0];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}`, label: 'Open the New Site' };
}

function sourceSiteOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[1];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}`, label: 'Back to the Site' };
}

// a cutover names the new site, which holds the plan and the timeline
function cutoverOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[0];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}/cutover`, label: 'Open the Move' };
}

// a domain attach names the site, whose domain page holds the stages and the DNS records
function domainOf(operation: Pick<Operation, 'targetIds'>): OperationLink {
	const id = operation.targetIds[0];
	return id === undefined
		? sites
		: { to: `/sites/${encodeURIComponent(id)}/domain`, label: 'Open the Domain' };
}

// the two sentences that say whether going back is still a reversal
export const ROLLBACK_BOUNDARY_COPY = {
	'dns-reversal':
		'Until the new site accepts its first write, going back is a DNS change and nothing is lost.',
	'post-write':
		'The new site has accepted writes, so going back is no longer a reversal. Keep the new site, abandon its new data, or export its new changes to apply to the old site.'
} as const;

export const OPERATION_COPY = {
	'site.create': {
		title: 'Creating Your Site',
		running: 'The site is ready when every step succeeds. Leaving this page does not stop it.',
		success: 'Your site is ready.',
		failure: 'Could Not Create the Site',
		link: () => null,
		failureLink: () => null
	},
	'node.command': {
		title: 'Adding Your Site to Your Box',
		running:
			'Someone at the box may need to approve this there before it goes ahead. Leaving this page does not stop it.',
		success: 'Your site is added on the box and listed here. It serves once the box reloads.',
		failure: 'Could Not Add the Site to the Box',
		link: siteOf,
		failureLink: () => ({ to: '/new/self-hosted', label: 'Back to Your Boxes' })
	},
	'site.delete': {
		title: 'Deleting Your Site',
		running:
			'The site stops serving once its access is revoked. Leaving this page does not stop the delete.',
		success: `Site deleted. Its address is held for ${SITE_HOLD_DAYS} days, and its backups are kept.`,
		failure: 'Could Not Delete the Site',
		link: () => sites,
		failureLink: siteOf
	},
	'site.upgrade': {
		title: 'Updating Your Site',
		running:
			'The site keeps serving during the update. Leaving this page does not stop the update.',
		success: 'Your site is up to date.',
		failure: 'Could Not Update the Site',
		link: siteOf,
		failureLink: siteOf
	},
	'site.adopt': {
		title: 'Adopting Your Site',
		running:
			'Your site keeps running where it is while the copy is made. Leaving this page does not stop the adoption.',
		success: 'Your site now also runs as a managed site. The original is unchanged.',
		failure: 'Could Not Adopt the Site',
		link: adoptedSiteOf,
		failureLink: sourceSiteOf
	},
	'site.import': {
		title: 'Importing Your Site',
		running:
			'Your site keeps running where it is while the copy is made. Leaving this page does not stop the import.',
		success:
			'Your site now also runs as a managed site. The original is unchanged. Sign in as the Owner on the new site with the password you use on the old one.',
		failure: 'Could Not Import the Site',
		link: adoptedSiteOf,
		failureLink: () => ({ to: '/new/import', label: 'Back to Import' })
	},
	'import.survey': {
		title: 'Checking Your Server',
		running: 'Nothing on your server is changed. Leaving this page does not stop the check.',
		success: 'The check is done.',
		failure: 'Could Not Check the Server',
		link: () => null,
		failureLink: () => ({ to: '/new/import', label: 'Back to Import' })
	},
	'migration.cutover': {
		title: 'Moving Your Site',
		running:
			'Your old site keeps its data and is never deleted. Leaving this page does not stop the move.',
		success:
			'Your address now points at the new site. The old site was not changed or deleted.',
		failure: 'Could Not Finish the Move',
		link: cutoverOf,
		failureLink: cutoverOf
	},
	'backup.create': {
		title: 'Backing Up Your Site',
		running: 'Leaving this page does not stop the backup.',
		success: 'The backup is saved.',
		failure: 'Could Not Back Up the Site',
		link: siteOf,
		failureLink: siteOf
	},
	'backup.restore': {
		title: 'Restoring a Backup',
		running:
			'The backup replaces the site content as the restore runs. Leaving this page does not stop the restore.',
		success: 'The backup is restored.',
		failure: 'Could Not Restore the Backup',
		link: siteOf,
		failureLink: siteOf
	},
	'git.pull': {
		title: 'Pulling From Your Repository',
		running:
			'The site keeps serving while the new code is installed. Leaving this page does not stop the pull.',
		success: 'The latest commit is installed.',
		failure: 'Could Not Pull the Repository',
		link: siteOf,
		failureLink: siteOf
	},
	'domain.attach': {
		title: 'Attaching Your Domain',
		running:
			'Your site keeps serving at its Drupflare address. The domain goes live once every stage is done. Leaving this page does not stop the attach.',
		success: 'The domain checks are done. Open the domain to see where it stands.',
		failure: 'Could Not Attach the Domain',
		link: domainOf,
		failureLink: domainOf
	}
} satisfies Partial<Record<Operation['type'], OperationCopy>>;

const GENERIC: OperationCopy = {
	title: 'Activity',
	running: 'Leaving this page does not stop the activity.',
	success: 'The activity finished.',
	failure: 'Could Not Finish the Activity',
	link: () => sites,
	failureLink: () => sites
};

export function copyFor(type: Operation['type'] | undefined): OperationCopy {
	if (type === undefined) return GENERIC;
	return (OPERATION_COPY as Partial<Record<Operation['type'], OperationCopy>>)[type] ?? GENERIC;
}

export const GENERIC_TYPE_LABEL = 'Change';
export const GENERIC_STEP_LABEL = 'Working on this step';

const TYPE_LABELS: Record<string, string> = {
	'site.create': 'Create',
	'site.upgrade': 'Update',
	'site.delete': 'Delete',
	'site.adopt': 'Adopt',
	'site.import': 'Import',
	'import.survey': 'Check',
	'site.purge': 'Permanent Delete',
	'migration.cutover': 'Move',
	'backup.create': 'Backup',
	'backup.restore': 'Restore',
	'git.pull': 'Pull',
	'domain.attach': 'Domain',
	'node.command': 'Add to Box'
};

export function operationTypeLabel(type: string | undefined): string {
	return (type !== undefined && TYPE_LABELS[type]) || GENERIC_TYPE_LABEL;
}

// keyed by operation type, then by the step id the engine writes; a key ending in a dot matches by prefix
const STEP_PHRASES: Record<string, Record<string, string>> = {
	'site.create': {
		lease: 'locking the site for this change',
		'reserve-name': 'reserving the site address',
		'resource.': 'creating the site storage',
		assets: 'uploading static files',
		'upload-script': 'uploading the site code',
		authority: "recording the site's access rules",
		route: 'connecting the site address',
		'first-run': 'setting up the first admin account',
		verify: 'checking that the site answers',
		activate: 'marking the site ready'
	},
	'site.adopt': {
		lease: 'locking your site for this change',
		preflight: 'checking that your site can be copied',
		export: 'copying your site database',
		'export-verify': 'checking every part of the copy',
		'export-record': 'saving the copy',
		'files-copy': 'copying the files that only live in object storage',
		'reserve-name': 'reserving the new site address',
		'resource.': 'creating the new site storage',
		assets: 'uploading static files to the new site',
		'upload-script': 'uploading the new site code',
		authority: "recording the new site's access rules",
		route: 'connecting the new site address',
		'first-run': 'starting the new site',
		link: 'recording where the new site came from',
		'restore-check': 'checking the new site and the copy',
		'restore-grant': 'giving the new site temporary access to the copied files',
		restore: 'sending the copy to the new site',
		apply: 'waiting for the new site to load the copy',
		files: 'waiting for the files to copy, then removing the temporary access',
		verify: 'checking that the new site answers',
		activate: 'marking the new site ready'
	},
	'site.import': {
		lease: 'locking the new site for this change',
		preflight: 'checking that your server can be imported',
		dump: 'copying your database from the server',
		'files-archive': 'copying your files from the server',
		'private-archive': 'copying your private files from the server',
		convert: 'converting the database for the new site',
		'files-convert': 'preparing the files for the new site',
		'private-convert': 'preparing the private files for the new site',
		'reserve-name': 'reserving the new site address',
		'resource.': 'creating the new site storage',
		assets: 'uploading static files to the new site',
		'upload-script': 'uploading the new site code',
		authority: "recording the new site's access rules",
		route: 'connecting the new site address',
		'first-run': 'starting the new site',
		link: 'recording where the new site came from',
		restore: 'sending the database to the new site',
		apply: 'waiting for the new site to load the database',
		verify: 'checking that the new site answers',
		activate: 'marking the new site ready',
		forget: 'deleting the key and the copies'
	},
	'import.survey': {
		survey: 'reading your server'
	},
	'site.upgrade': {
		lease: 'locking the site for this change',
		preflight: 'checking the site and the new release',
		assets: 'uploading changed static files',
		'upload-script': 'uploading the site code',
		verify: 'checking that the site answers',
		finish: 'recording the new release'
	},
	'site.delete': {
		lease: 'locking the site for this change',
		revoke: "turning off the site's access",
		route: 'removing the site address',
		tombstone: 'marking the site as deleted'
	},
	'site.purge': {
		lease: 'locking the site for this change',
		script: 'deleting the site code',
		resources: 'deleting the site storage',
		name: 'releasing the site address',
		forget: 'removing the site record'
	},
	'migration.cutover': {
		lease: 'locking the new site for this change',
		'lower-ttl': 'reading the DNS cache time of your address',
		snapshot: 'taking a consistent snapshot of your old site',
		'capture-delta': 'copying the changes made since the snapshot',
		validate: 'checking the new site against the snapshot and the changes',
		'owner-approval': 'waiting for your approval',
		'apply-write-policy': 'holding writes on your old site',
		'final-delta': 'copying the last changes and checking them',
		promote: 'promoting the new site',
		route: 'waiting for your address to point at the new site',
		'observe-5m': 'checking the new site after 5 minutes',
		'observe-30m': 'checking the new site after 30 minutes',
		'observe-6h': 'checking the new site after 6 hours',
		'observe-24h': 'checking the new site after 24 hours'
	},
	'backup.create': {
		lease: 'locking the site for this change',
		export: 'copying the site database into the backup',
		verify: 'checking every backup part',
		record: 'saving the backup record'
	},
	'backup.restore': {
		lease: 'locking the site for this change',
		check: 'checking the site and the backup',
		grant: 'giving the site temporary access to the backup files',
		restore: 'sending the backup to the site',
		apply: 'waiting for the site to load the backup',
		adopt: 'waiting for the files to copy, then removing the temporary access',
		verify: 'checking that the restored site answers'
	},
	'git.pull': {
		lease: 'locking the site for this change',
		find: 'finding the repository on the site',
		pull: 'installing the latest commit',
		record: 'saving the result'
	},
	'node.command': {
		claim: 'reserving the address for this site',
		payload: 'finding the site files for the current release',
		add: 'sending the request to your box',
		wait: 'waiting for your box to add the site, which may need approval there',
		activate: 'listing the site as ready'
	},
	'domain.attach': {
		lease: 'locking the site for this change',
		claim: 'reserving the domain for this site',
		request: 'asking the certificate service for its records',
		ownership: 'checking the ownership record',
		certificate: 'waiting for the certificate',
		routing: 'sending the domain to your site',
		verification: 'loading your site through the domain'
	}
};

function phraseOf(type: string | undefined, stepId: string): string | null {
	const table = type === undefined ? undefined : STEP_PHRASES[type];
	if (table === undefined) return null;
	if (table[stepId] !== undefined) return table[stepId];
	const prefix = Object.keys(table).find((key) => key.endsWith('.') && stepId.startsWith(key));
	return prefix === undefined ? null : (table[prefix] ?? null);
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function stepLabel(type: string | undefined, stepId: string): string {
	const phrase = phraseOf(type, stepId);
	return phrase === null ? GENERIC_STEP_LABEL : sentence(phrase);
}

export function failedStepId(steps: { id: string; state: string }[]): string | null {
	return steps.find((step) => step.state === 'failed')?.id ?? null;
}

// the engine writes a failed step's error as "<code>: <text>"; only the code is read here
function errorCode(error: string | null | undefined): string | null {
	return /^([a-z_]+): /.exec(error ?? '')?.[1] ?? null;
}

export function failedStepError(steps: { state: string; error?: string | null }[]): string | null {
	return steps.find((step) => step.state === 'failed')?.error ?? null;
}

export const LARGER_RESTORE_TITLE = 'Needs a Larger Restore Path';

const ADOPT_REFUSALS: Record<string, string> = {
	already_adopted: 'This site was already adopted.',
	not_self_managed: 'Only a self-managed site can be adopted.',
	source_unreachable:
		'Your site did not answer, so nothing was copied. Check that it is online, then adopt it again.',
	no_owner_token:
		'Drupflare has no owner access to this site, so it cannot copy it. Reconnect the site, then adopt it again.',
	site_not_ready: 'The site is not live, so it cannot be adopted.',
	unsupported_kind: 'This kind of site cannot be adopted yet.',
	files_outside_database:
		'Some files on this site live only in object storage, and your site needs an update before they can be copied. Nothing was created and your site was not changed.',
	files_unsupported:
		'Some files on this site live only in object storage, and your site needs an update before they can be copied. Nothing was created and your site was not changed.',
	files_too_many:
		'This site holds more files in object storage than a copy carries. Nothing was created and your site was not changed.',
	restore_too_large:
		"This site's database and files are larger than a managed site can restore at the moment. Nothing was created and your site was not changed."
};

// the paged restore and the file copy refusals, shared by every operation that sends a database
const PAGED_RESTORE_REFUSALS: Record<string, string> = {
	restore_unsupported:
		'This database is too large for the version the site runs. Update the site, then try again. Nothing was left behind.',
	restore_busy:
		'The site is already loading another database. Wait for that to end, then try again.',
	restore_unaligned:
		'The database holds a row too large to send in pieces. Nothing was left behind.',
	restore_stalled:
		'The site stopped partway through loading the database. It keeps its earlier data. Try again.'
};

// the engine writes the count into the text of this refusal, and the owner sees only the count
function filesCopyFailedReason(error: string | null | undefined): string {
	const count = /: (\d+) of \d+ files/.exec(error ?? '')?.[1];
	const files =
		count === undefined ? 'Some files' : `${count} ${count === '1' ? 'file' : 'files'}`;
	return `${files} could not be copied from the site. Nothing was left behind and the site was not changed. Try again.`;
}

const LARGER_RESTORE_REASON =
	"This site's database is larger than a managed site can restore at the moment. Nothing was created and your site was not changed.";

// an adoption that stopped before it made anything because the database is too big to restore
export function needsLargerRestore(operation: {
	type: string | undefined;
	failedStep: string | null;
	failedError?: string | null;
}): boolean {
	return (
		operation.type === 'site.adopt' &&
		operation.failedStep === 'export' &&
		errorCode(operation.failedError) === 'restore_too_large'
	);
}

const IMPORT_REFUSALS: Record<string, string> = {
	source_auth_failed:
		'The server did not accept the key. Add the public line to the authorized keys of that user, then start again.',
	source_unreachable:
		'The server did not answer. Check that it is online and that the port is open, then start again.',
	source_host_private:
		'The server address is not on the public internet, so Drupflare cannot reach it and nothing was run.',
	host_key_mismatch:
		'The server presented a different host key than the one you confirmed, so nothing was run. Start again and confirm the new key if you trust it.',
	credential_expired: 'The key for this import expired. Start again to make a new one.',
	credential_missing: 'The key for this import is gone. Start again to make a new one.',
	host_key_unconfirmed: 'The host key of the server was not confirmed. Start again.',
	dossier_refused:
		'The check found a reason this site cannot be imported yet. Nothing was created and your server was not changed.',
	unsupported_kind: 'This kind of site cannot be imported yet.',
	dump_empty: 'The server returned an empty database, so nothing was imported.',
	dump_failed:
		'The database copy on your server did not finish. Check that Drush works there, then start again.',
	restore_too_large:
		"The database and the files together are larger than this site's version can restore. Nothing was created and your server was not changed.",
	unsupported_statement:
		'The database holds something a new site cannot store, such as a row that is too large or a trigger. Nothing was created and your server was not changed.',
	no_statement_boundary:
		'The database holds a row too large to copy in one piece. Nothing was created and your server was not changed.',
	files_too_large: 'The files are larger than an import accepts. Nothing was created.',
	files_unreadable:
		'The copy of your files was cut short or could not be read. Nothing was created and your server was not changed. Start again.',
	files_bad_path:
		'A file on your server has a name that cannot be carried into a new site. Nothing was created and your server was not changed.',
	files_too_many: 'Your server holds more files than an import carries. Nothing was created.',
	import_failed: 'The new site could not load the database. Nothing was left behind.',
	import_timeout: 'The new site took too long to load the database. Nothing was left behind.',
	job_timeout:
		'The import ran past its time limit, so it was stopped. Nothing was left behind and your server was not changed. Start again to retry.'
};

const GIT_PULL_REFUSALS: Record<string, string> = {
	site_not_ready: 'The site is not live, so nothing was pulled.',
	no_owner_token:
		'Drupflare has no owner access to this site, so it cannot pull. Reconnect the site, then pull again.',
	owner_token_rejected:
		'The site did not accept the access Drupflare holds, so nothing was pulled. Reconnect the site, then pull again.',
	site_unreachable: 'The site did not answer. Check that it is online, then pull again.',
	site_busy:
		'Another change to this site was running, so nothing was pulled. Pull again when it finishes.',
	lease_lost: 'Another change took over the site while this ran. Pull again.',
	remote_not_on_site:
		"This site does not follow the repository yet, and Drupflare cannot add it for you yet. Add the repository on the site's own Git page, then pull again.",
	remote_mount_differs:
		'The site follows this repository at a different folder than the one saved here, so nothing was pulled.',
	remote_gone: 'The site no longer follows this repository, so nothing was pulled.',
	no_branch: 'The repository has no branch with that name.',
	no_module: 'That commit has no Drupal module, theme or profile to install.',
	path_conflict:
		'Some files in that commit belong to another repository on this site, so nothing was installed.',
	rolled_back:
		'The site would not start with that commit, so it went back to the code it had. Fix the code and push again.',
	pull_refused:
		'The site could not fetch that commit from the provider. The access saved on the site may have expired.',
	answer_unreadable:
		'The site answered in a way Drupflare could not read, so the result is unknown. Pull again to check.'
};

// one sentence per code the box-site create writes, for a refused start and for a failed step
const NODE_SITE_REFUSALS: Record<string, string> = {
	unsupported_kind: 'Only a Drupal site can be added to a box for now.',
	node_not_found: 'That box is not paired with this organization.',
	node_revoked: 'That box was unpaired. Pair it again, then add the site.',
	node_offline:
		'That box is not connected right now. Check that bastion is running on it, then try again.',
	plan_no_nodes: 'Your plan does not include boxes of your own.',
	no_release: 'Drupflare has no current Drupal release set up for boxes yet.',
	invalid: 'Enter a domain name such as www.example.org.',
	wildcard: 'A domain that starts with * cannot be added. Enter one domain name.',
	platform_zone:
		'Drupflare keeps this domain for its own sites. Enter a domain you own and point at your box.',
	host_taken:
		'Another site already holds this domain. Remove it from that site first, or use a different domain.',
	no_payload:
		'The current Drupal release has no site files a box can take yet, so nothing was sent to your box.',
	box_too_old:
		'This box does not support creating sites yet. Update bastion on it, then try again.',
	declined_at_box: 'Someone at the box declined the request, so no site was added.',
	not_approved:
		'Nobody approved the request at the box in time, so no site was added. Start again when someone can approve it.',
	site_exists:
		'The box already serves a different site on this domain, so nothing was changed. Use another domain or remove that site at the box.',
	no_tenant:
		'The box has no tenant yet. Add one at the box with the tenant command, then try again.',
	unknown_tenant: 'The box does not have the tenant the request named.',
	capacity_exceeded:
		'The box has no room for another site. Raise its limit or remove a site there.',
	box_interrupted:
		'The box stopped while it was adding the site. Check the box, then start again; a site it already added is picked up.',
	box_refused: 'The box did not accept the request, so no site was added.',
	bundle_invalid:
		'The site files the box downloaded could not run there, so no site was added. Nothing changed on the box.',
	assets_failed:
		'The box could not place the site files it downloaded, so no site was added. Check the free space on the box, then start again.',
	box_failed: 'The box could not add the site. Check it, then start again.'
};

export function nodeSiteFailureReason(code: string): string {
	return NODE_SITE_REFUSALS[code] ?? NODE_SITE_REFUSALS.box_failed!;
}

// the plain reason for a start the server refused; the server message is the fallback
export function nodeSiteRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (
		(typeof reason === 'string' && (NODE_SITE_REFUSALS[reason] ?? REFUSALS[reason])) ||
		error.message
	);
}

const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'rolled-back']);

// the one plain reason shown on the progress page, the site's activity list and the admin list
export function failureReason(operation: {
	type: string | undefined;
	status: string;
	failedStep: string | null;
	failedError?: string | null;
}): string | null {
	if (!FAILED_STATUSES.has(operation.status)) return null;
	if (operation.status === 'cancelled') return 'The change was cancelled before it started.';
	if (needsLargerRestore(operation)) return LARGER_RESTORE_REASON;
	if (operation.type === 'site.adopt') {
		const refusal = ADOPT_REFUSALS[errorCode(operation.failedError) ?? ''];
		if (refusal !== undefined) return refusal;
	}
	const paged = errorCode(operation.failedError) ?? '';
	if (
		(operation.type === 'site.adopt' ||
			operation.type === 'site.import' ||
			operation.type === 'backup.restore') &&
		PAGED_RESTORE_REFUSALS[paged] !== undefined
	) {
		return PAGED_RESTORE_REFUSALS[paged];
	}
	if (operation.type === 'site.adopt' && paged === 'files_copy_failed') {
		return filesCopyFailedReason(operation.failedError);
	}
	if (operation.type === 'site.import' || operation.type === 'import.survey') {
		const refusal = IMPORT_REFUSALS[errorCode(operation.failedError) ?? ''];
		if (refusal !== undefined) return refusal;
	}
	if (operation.type === 'git.pull') {
		const refusal = GIT_PULL_REFUSALS[errorCode(operation.failedError) ?? ''];
		if (refusal !== undefined) return refusal;
	}
	if (operation.type === 'domain.attach') {
		const refusal = attachFailureReason(errorCode(operation.failedError));
		if (refusal !== null) return refusal;
	}
	if (operation.type === 'node.command') {
		const refusal = NODE_SITE_REFUSALS[errorCode(operation.failedError) ?? ''];
		if (refusal !== undefined) return refusal;
	}
	const phrase =
		operation.failedStep === null ? null : phraseOf(operation.type, operation.failedStep);
	if (phrase === null) return 'Stopped before it could finish.';
	return `Stopped while ${phrase}.`;
}

// the types a retry starts again; mirrors RETRY_ACTIONS in src/server/services/operation-retry.ts
const RETRYABLE_TYPES: ReadonlySet<string> = new Set([
	'site.create',
	'site.upgrade',
	'backup.create',
	'backup.restore',
	'repair.run'
]);
// a create and a backup undo themselves when they fail, so their failure ends as rolled-back
const RETRY_AFTER_ROLLBACK: ReadonlySet<string> = new Set(['site.create', 'backup.create']);

export function canRetry(type: string | undefined, status: string): boolean {
	if (type === undefined || !RETRYABLE_TYPES.has(type)) return false;
	if (status === 'failed') return true;
	return status === 'rolled-back' && RETRY_AFTER_ROLLBACK.has(type);
}

const REFUSALS: Record<string, string> = {
	not_failed: 'Only an activity that failed can be tried again.',
	not_retryable:
		'This kind of activity cannot be tried again. Start it again from the page where you began it.',
	inputs_missing:
		'This activity was recorded before it could be tried again. Start it again from the page where you began it.',
	site_not_live: 'The site is not live, so this cannot be tried again.',
	site_busy:
		'Another change to this site is still running. Wait for it to finish, then try again.',
	up_to_date: 'The site already runs that release.',
	site_active:
		'This site is live, so it is not removed. Only a site that did not finish its create can be cleaned up.',
	idempotency_key_reused:
		'This request clashes with an earlier one. Refresh the page and try again.'
};

// the plain reason for a refused retry or cleanup; the server message is the fallback
export function refusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && REFUSALS[reason]) || error.message;
}

const ADOPT_ROUTE_REFUSALS: Record<string, string> = {
	...ADOPT_REFUSALS,
	site_not_live: 'This site is not live, so it cannot be adopted.',
	site_busy: REFUSALS.site_busy!,
	idempotency_key_reused: REFUSALS.idempotency_key_reused!,
	plan_full:
		'Your plan has no room for another site. Remove a site or change your plan, then adopt again.'
};

// the plain reason for a refused adoption; the server message is the fallback
export function adoptRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && ADOPT_ROUTE_REFUSALS[reason]) || error.message;
}

const CUTOVER_ROUTE_REFUSALS: Record<string, string> = {
	no_ready_destination:
		'This site cannot take a move yet. Only a live managed site with an address can be moved to.',
	site_busy: REFUSALS.site_busy!,
	idempotency_key_reused: REFUSALS.idempotency_key_reused!,
	not_awaiting_approval: 'The move is not waiting for your approval right now.',
	not_observing: 'The new site is not live yet, so there is nothing to choose.',
	not_waiting: 'The move has stopped, so it can no longer take your answer. Refresh the page.'
};

// the plain reason for a refused move, approval or choice; the server message is the fallback
export function cutoverRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && CUTOVER_ROUTE_REFUSALS[reason]) || error.message;
}

export interface CutoverHandStep {
	id: 'lower-cache-time' | 'point-address' | 'restore-cache-time' | 'restore-writes';
	when: string;
	text: string;
}

// the steps in the owner's own DNS zone and on the old server, which Drupflare cannot do for them
export function cutoverHandSteps(
	hostname: string,
	ttlSeconds: number,
	policy: 'freeze' | 'read-only' | 'delta'
): CutoverHandStep[] {
	const held =
		policy === 'read-only'
			? 'turn Read Only Mode back off'
			: 'turn maintenance mode back off (drush state:delete system.maintenance_mode)';
	return [
		{
			id: 'lower-cache-time',
			when: 'Before you approve',
			text: `Set the cache time (TTL) of ${hostname} to ${ttlSeconds} seconds in your DNS, then wait out the old cache time. Drupflare reads the old value when the move starts.`
		},
		{
			id: 'point-address',
			when: 'Right after you approve',
			text: `Point ${hostname} at the new site. Drupflare waits a few minutes to see the change. If it does not appear, the move goes back and your old site is unchanged.`
		},
		{
			id: 'restore-cache-time',
			when: 'After the move',
			text: `Put the cache time of ${hostname} back to its old value.`
		},
		{
			id: 'restore-writes',
			when: 'Only if Drupflare could not',
			text: `If the move says your old site did not take writes again, ${held}.`
		}
	];
}

export const IMPORT_ROUTE_REFUSALS: Record<string, string> = {
	host_private: 'That address is not on the public internet, so Drupflare cannot reach it.',
	host_unresolved: 'That server name could not be found. Check the spelling.',
	credential_expired: IMPORT_REFUSALS.credential_expired!,
	host_key_unconfirmed: 'Confirm the host key of the server first.',
	host_key_changed:
		'The server now shows a different host key than the one you were shown. Read it again before you confirm.',
	host_key_confirmed:
		'A different host key was confirmed for this key already. Start again with a new key.',
	survey_not_done: 'The check of the server has not finished yet.',
	dossier_refused: IMPORT_REFUSALS.dossier_refused!,
	unsupported_kind: IMPORT_REFUSALS.unsupported_kind!,
	idempotency_key_reused: REFUSALS.idempotency_key_reused!,
	plan_full:
		'Your plan has no room for another site. Remove a site or change your plan, then import again.',
	import_busy:
		'Another import is already running for this account. Wait for it to finish, then start again.',
	import_hours_today:
		'Another import could take this plan past its import time for today. Try again after midnight UTC.',
	import_hours_this_month:
		'Another import could take this plan past its import time for this month. Try again on the first day of next month, UTC.',
	import_approval_needed:
		'Imports on this plan are scheduled with Drupflare. Contact us and we will set one up with you.',
	plan_not_capped: 'Imports are not available on this plan yet.'
};

// the plain reason for a refused import step; the server message is the fallback
export function importRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && IMPORT_ROUTE_REFUSALS[reason]) || error.message;
}

const PULL_ROUTE_REFUSALS: Record<string, string> = {
	site_not_live: 'This site is not live, so nothing can be pulled.',
	site_busy: REFUSALS.site_busy!,
	connection_revoked: 'The connection for this repository was revoked. Connect it again first.',
	idempotency_key_reused: REFUSALS.idempotency_key_reused!
};

// the plain reason for a pull that never started; the server message is the fallback
export function pullRefusalReason(error: { details: unknown; message: string }): string {
	const reason = (error.details as { reason?: unknown } | null)?.reason;
	return (typeof reason === 'string' && PULL_ROUTE_REFUSALS[reason]) || error.message;
}
