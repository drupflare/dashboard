import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATION_TYPES } from '../../../contracts/src/operations';
import { DEFAULT_HOLD_MS } from '../../../dispatch/src/registry';
import { RETRY_ACTIONS } from '../../../src/server/services/operation-retry';
import {
	adoptRefusalReason,
	canRetry,
	copyFor,
	cutoverHandSteps,
	cutoverRefusalReason,
	failedStepError,
	failedStepId,
	failureReason,
	GENERIC_STEP_LABEL,
	GENERIC_TYPE_LABEL,
	IMPORT_ROUTE_REFUSALS,
	importRefusalReason,
	LARGER_RESTORE_TITLE,
	needsLargerRestore,
	nodeSiteFailureReason,
	nodeSiteRefusalReason,
	OPERATION_COPY,
	operationTypeLabel,
	pullRefusalReason,
	refusalReason,
	ROLLBACK_BOUNDARY_COPY,
	SITE_HOLD_DAYS,
	stepLabel,
	type OperationCopy
} from '../../../src/shared/operation-copy';

const SITE = 'site_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const COVERED = [
	'site.create',
	'site.delete',
	'site.upgrade',
	'site.adopt',
	'site.import',
	'import.survey',
	'migration.cutover',
	'backup.create',
	'backup.restore',
	'git.pull',
	'domain.attach',
	'node.command'
];
const WORKFLOWS = fileURLToPath(new URL('../../../engine/src/workflows/', import.meta.url));

// (type, step id) pairs the engine writes, read from the plan literals so a new step fails here
function enginePlanSteps(): { type: string; id: string }[] {
	const pairs: { type: string; id: string }[] = [];
	for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.ts'))) {
		const text = readFileSync(WORKFLOWS + file, 'utf8');
		const marks = [
			...text.matchAll(/type: '((?:site|backup|migration|import|git|domain|node)\.[a-z-]+)'/g)
		];
		marks.forEach((mark, i) => {
			const type = mark[1] ?? '';
			const segment = text.slice(mark.index, marks[i + 1]?.index ?? text.length);
			for (const step of segment.matchAll(/\{ id: '([^']+)', name:/g)) {
				pairs.push({ type, id: step[1] ?? '' });
			}
			for (const step of segment.matchAll(/\{ id: `([a-z-]+\.)\$\{/g)) {
				pairs.push({ type, id: `${step[1]}SAMPLE` });
			}
		});
	}
	return pairs;
}

const IDENTIFIER = /[a-z0-9]\.[a-z]|[a-z]-[a-z]|_/;

describe('operation copy', () => {
	it('covers the operations the progress screen names, and no other', () => {
		expect(Object.keys(OPERATION_COPY).sort()).toEqual([...COVERED].sort());
		for (const type of COVERED) expect(OPERATION_TYPES).toContain(type);
	});

	it('gives every entry a title, a running line, a success line and a failure title in plain ASCII', () => {
		for (const type of COVERED) {
			const copy = copyFor(type as never);
			for (const field of ['title', 'running', 'success', 'failure'] as const) {
				expect(copy[field], `${type} ${field}`).toMatch(/^[\x20-\x7e]+$/);
			}
			expect(copy.failure, type).not.toBe(copy.title);
		}
	});

	it('titles read as the screen heading for each operation', () => {
		expect(copyFor('site.create').title).toBe('Creating Your Site');
		expect(copyFor('site.delete').title).toBe('Deleting Your Site');
		expect(copyFor('site.delete').success).toMatch(/^Site deleted/);
		expect(copyFor('site.delete').failure).toBe('Could Not Delete the Site');
	});

	it('links a finished delete to Sites and every other site operation back to the site', () => {
		const operation = { targetIds: [SITE] };
		expect(copyFor('site.delete').link(operation)).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
		for (const type of ['site.upgrade', 'backup.create', 'backup.restore'] as const) {
			expect(copyFor(type).link(operation), type).toEqual({
				to: `/sites/${SITE}`,
				label: 'Back to the Site'
			});
		}
	});

	it('shows no link after a create, and leaves its failure panel to its own retry and cleanup controls', () => {
		const operation = { targetIds: [SITE] };
		expect(copyFor('site.create').link(operation)).toBeNull();
		expect(copyFor('site.create').failureLink(operation)).toBeNull();
		expect(copyFor('site.delete').failureLink(operation)?.to).toBe(`/sites/${SITE}`);
	});

	it('allows a retry for a failed create, upgrade, backup, restore or cleanup', () => {
		for (const type of [
			'site.create',
			'site.upgrade',
			'backup.create',
			'backup.restore',
			'repair.run'
		]) {
			expect(canRetry(type, 'failed'), type).toBe(true);
		}
	});

	it('offers a retry for exactly the types the server retries', () => {
		for (const type of OPERATION_TYPES) {
			expect(canRetry(type, 'failed'), type).toBe(RETRY_ACTIONS[type] !== undefined);
		}
	});

	it('allows a retry after a rollback only for a create and a backup', () => {
		expect(canRetry('site.create', 'rolled-back')).toBe(true);
		expect(canRetry('backup.create', 'rolled-back')).toBe(true);
		expect(canRetry('site.upgrade', 'rolled-back')).toBe(false);
	});

	it('offers no retry for a delete or purge, a cancelled operation, or one still running', () => {
		expect(canRetry('site.delete', 'failed')).toBe(false);
		expect(canRetry('site.purge', 'failed')).toBe(false);
		expect(canRetry('site.create', 'cancelled')).toBe(false);
		expect(canRetry('site.create', 'running')).toBe(false);
		expect(canRetry(undefined, 'failed')).toBe(false);
	});

	it('gives the plain reason for a refusal, and the server message for a reason it does not name', () => {
		expect(refusalReason({ details: { reason: 'site_busy' }, message: 'Busy' })).toBe(
			'Another change to this site is still running. Wait for it to finish, then try again.'
		);
		expect(refusalReason({ details: { reason: 'site_active' }, message: 'Live' })).toMatch(
			/^This site is live/
		);
		expect(refusalReason({ details: { reason: 'new_thing' }, message: 'Plan limit' })).toBe(
			'Plan limit'
		);
		expect(refusalReason({ details: null, message: 'Try later' })).toBe('Try later');
	});

	it('falls back to Sites when an operation names no site', () => {
		expect(copyFor('site.upgrade').link({ targetIds: [] })).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
	});

	it('uses generic words for a type it has no copy for, and while the type is unknown', () => {
		const generic: OperationCopy = copyFor(undefined);
		expect(copyFor('repair.run')).toBe(generic);
		expect(generic.title).toBe('Activity');
		expect(generic.failure).toBe('Could Not Finish the Activity');
		expect(generic.link({ targetIds: [SITE] })).toEqual({
			to: '/sites',
			label: 'Back to Sites'
		});
	});

	it('labels every (type, step) pair the engine plans, and no label looks like an identifier', () => {
		const pairs = enginePlanSteps();
		expect(new Set(pairs.map((pair) => pair.type))).toEqual(
			new Set(COVERED.concat('site.purge'))
		);
		for (const { type, id } of pairs) {
			const label = stepLabel(type, id);
			expect(label, `${type} ${id}`).not.toBe(GENERIC_STEP_LABEL);
			expect(label, `${type} ${id}`).not.toMatch(IDENTIFIER);
		}
	});

	it('labels every operation type the engine plans with a plain word', () => {
		for (const type of new Set(enginePlanSteps().map((pair) => pair.type))) {
			expect(operationTypeLabel(type), type).not.toBe(GENERIC_TYPE_LABEL);
			expect(operationTypeLabel(type), type).not.toMatch(IDENTIFIER);
		}
		expect(operationTypeLabel('site.upgrade')).toBe('Update');
	});

	it('falls back to generic labels for an unknown step or type, never the raw id', () => {
		expect(stepLabel('site.create', 'made-up-step')).toBe(GENERIC_STEP_LABEL);
		expect(stepLabel('backup.create', 'verify')).toBe('Checking every backup part');
		expect(stepLabel('backup.restore', 'verify')).toBe(
			'Checking that the restored site answers'
		);
		expect(operationTypeLabel('repair.run')).toBe(GENERIC_TYPE_LABEL);
		expect(operationTypeLabel(undefined)).toBe(GENERIC_TYPE_LABEL);
	});

	it('gives a failed row the step it stopped at, in plain words', () => {
		expect(
			failureReason({ type: 'site.create', status: 'rolled-back', failedStep: 'verify' })
		).toBe('Stopped while checking that the site answers.');
		expect(
			failureReason({
				type: 'site.create',
				status: 'failed',
				failedStep: 'resource.CONFIG_KV'
			})
		).toBe('Stopped while creating the site storage.');
	});

	it('explains a failure with no known step, and a cancelled operation, without a step name', () => {
		expect(failureReason({ type: 'site.delete', status: 'failed', failedStep: null })).toBe(
			'Stopped before it could finish.'
		);
		expect(failureReason({ type: 'site.delete', status: 'failed', failedStep: 'nope' })).toBe(
			'Stopped before it could finish.'
		);
		expect(failureReason({ type: 'site.delete', status: 'cancelled', failedStep: null })).toBe(
			'The change was cancelled before it started.'
		);
	});

	it('gives no reason for an operation that has not failed', () => {
		for (const status of ['planned', 'running', 'verifying', 'succeeded']) {
			expect(
				failureReason({ type: 'site.create', status, failedStep: 'verify' }),
				status
			).toBe(null);
		}
	});

	it('finds the first failed step of an operation', () => {
		expect(
			failedStepId([
				{ id: 'lease', state: 'succeeded' },
				{ id: 'verify', state: 'failed' },
				{ id: 'activate', state: 'failed' }
			])
		).toBe('verify');
		expect(failedStepId([{ id: 'lease', state: 'succeeded' }])).toBeNull();
	});

	it('states the same hold as the registry that enforces it', () => {
		expect(SITE_HOLD_DAYS * 86_400_000).toBe(DEFAULT_HOLD_MS);
		expect(copyFor('site.delete').success).toContain(`${SITE_HOLD_DAYS} days`);
	});
});

describe('adoption copy', () => {
	const NEW_SITE = 'site_bbbbbbbbbbbbbbbbbbbbbbbbbb';
	const operation = { targetIds: [NEW_SITE, SITE] };

	it('opens the new site on success and goes back to the source on failure', () => {
		const copy = copyFor('site.adopt');
		expect(copy.title).toBe('Adopting Your Site');
		expect(copy.failure).toBe('Could Not Adopt the Site');
		expect(copy.link(operation)).toEqual({
			to: `/sites/${NEW_SITE}`,
			label: 'Open the New Site'
		});
		expect(copy.failureLink(operation)).toEqual({
			to: `/sites/${SITE}`,
			label: 'Back to the Site'
		});
		expect(copy.link({ targetIds: [] })?.to).toBe('/sites');
		expect(copy.failureLink({ targetIds: [NEW_SITE] })?.to).toBe('/sites');
	});

	it('labels the type and offers no retry', () => {
		expect(operationTypeLabel('site.adopt')).toBe('Adopt');
		expect(canRetry('site.adopt', 'failed')).toBe(false);
		expect(canRetry('site.adopt', 'rolled-back')).toBe(false);
	});

	it('labels every step id the plan writes, including the ones the reused steps rename', () => {
		const ids = [
			'lease',
			'preflight',
			'export',
			'export-verify',
			'export-record',
			'reserve-name',
			'resource.CONFIG_KV',
			'assets',
			'upload-script',
			'authority',
			'route',
			'first-run',
			'link',
			'restore-check',
			'restore-grant',
			'restore',
			'apply',
			'files',
			'verify',
			'activate'
		];
		for (const id of ids) {
			const label = stepLabel('site.adopt', id);
			expect(label, id).not.toBe(GENERIC_STEP_LABEL);
			expect(label, id).not.toMatch(IDENTIFIER);
		}
	});

	it('names the larger restore state only for the export step and the size refusal', () => {
		const failed = 'restore_too_large: the dump is larger than the 300 bytes a site accepts';
		expect(
			needsLargerRestore({ type: 'site.adopt', failedStep: 'export', failedError: failed })
		).toBe(true);
		expect(
			needsLargerRestore({ type: 'site.adopt', failedStep: 'restore', failedError: failed })
		).toBe(false);
		expect(
			needsLargerRestore({ type: 'backup.create', failedStep: 'export', failedError: failed })
		).toBe(false);
		expect(
			needsLargerRestore({ type: 'site.adopt', failedStep: 'export', failedError: null })
		).toBe(false);
		expect(LARGER_RESTORE_TITLE).toBe('Needs a Larger Restore Path');
		const reason = failureReason({
			type: 'site.adopt',
			status: 'rolled-back',
			failedStep: 'export',
			failedError: failed
		});
		expect(reason).toContain('larger than a managed site can restore');
		expect(reason).toContain('Nothing was created');
		expect(reason).not.toContain('MiB');
		expect(reason).not.toContain('restore_too_large');
	});

	it.each([
		['already_adopted', 'This site was already adopted.'],
		['not_self_managed', 'Only a self-managed site can be adopted.'],
		['source_unreachable', 'Your site did not answer'],
		['no_owner_token', 'no owner access'],
		['site_not_ready', 'The site is not live'],
		['unsupported_kind', 'cannot be adopted yet'],
		['files_outside_database', 'live only in object storage'],
		['files_unsupported', 'needs an update'],
		['files_too_many', 'more files in object storage'],
		['restore_too_large', 'larger than a managed site can restore'],
		['restore_unsupported', 'too large for the version'],
		['restore_stalled', 'stopped partway']
	])('turns the %s code into a plain reason with no code in it', (code, text) => {
		const reason = failureReason({
			type: 'site.adopt',
			status: 'rolled-back',
			failedStep: 'preflight',
			failedError: `${code}: some internal words`
		});
		expect(reason).toContain(text);
		expect(reason).not.toContain(code);
		expect(reason).not.toContain('internal words');
	});

	it('falls back to the step phrase for an error it does not name, and for another type', () => {
		expect(
			failureReason({
				type: 'site.adopt',
				status: 'failed',
				failedStep: 'restore',
				failedError: 'import_failed: it broke'
			})
		).toBe('Stopped while sending the copy to the new site.');
		expect(
			failureReason({
				type: 'site.upgrade',
				status: 'failed',
				failedStep: 'verify',
				failedError: 'already_adopted: x'
			})
		).toBe('Stopped while checking that the site answers.');
	});

	it('reads the error of the first failed step', () => {
		expect(
			failedStepError([
				{ state: 'succeeded', error: null },
				{ state: 'failed', error: 'a: b' },
				{ state: 'failed', error: 'c: d' }
			])
		).toBe('a: b');
		expect(failedStepError([{ state: 'succeeded' }])).toBeNull();
		expect(failedStepError([{ state: 'failed' }])).toBeNull();
	});

	it('gives the plain reason for a refused adoption and the server message otherwise', () => {
		const refused = (reason: unknown) =>
			adoptRefusalReason({ details: { reason }, message: 'server words' });
		expect(refused('plan_full')).toContain('no room for another site');
		expect(refused('site_not_live')).toBe('This site is not live, so it cannot be adopted.');
		expect(refused('site_busy')).toContain('still running');
		expect(refused('idempotency_key_reused')).toContain('clashes');
		expect(refused('already_adopted')).toBe('This site was already adopted.');
		expect(refused('nothing_like_it')).toBe('server words');
		expect(adoptRefusalReason({ details: null, message: 'server words' })).toBe('server words');
	});
});

describe('cutover copy', () => {
	const NEW_SITE = 'site_bbbbbbbbbbbbbbbbbbbbbbbbbb';
	const STEP_IDS = [
		'lease',
		'lower-ttl',
		'snapshot',
		'capture-delta',
		'validate',
		'owner-approval',
		'apply-write-policy',
		'final-delta',
		'promote',
		'route',
		'observe-5m',
		'observe-30m',
		'observe-6h',
		'observe-24h'
	];

	it('titles the move and opens its page from the new site, on success and on failure', () => {
		const copy = copyFor('migration.cutover');
		const operation = { targetIds: [NEW_SITE] };
		expect(copy.title).toBe('Moving Your Site');
		expect(copy.failure).toBe('Could Not Finish the Move');
		expect(copy.running).toContain('never deleted');
		expect(copy.success).toContain('not changed or deleted');
		expect(copy.link(operation)).toEqual({
			to: `/sites/${NEW_SITE}/cutover`,
			label: 'Open the Move'
		});
		expect(copy.failureLink(operation)).toEqual(copy.link(operation));
		expect(copy.link({ targetIds: [] })?.to).toBe('/sites');
	});

	it('labels the type and offers no retry', () => {
		expect(operationTypeLabel('migration.cutover')).toBe('Move');
		expect(canRetry('migration.cutover', 'failed')).toBe(false);
		expect(canRetry('migration.cutover', 'rolled-back')).toBe(false);
	});

	it('labels every step id the plan writes in plain words', () => {
		for (const id of STEP_IDS) {
			const label = stepLabel('migration.cutover', id);
			expect(label, id).not.toBe(GENERIC_STEP_LABEL);
			expect(label, id).not.toMatch(IDENTIFIER);
		}
	});

	it('says where a failed move stopped, in plain words', () => {
		expect(
			failureReason({ type: 'migration.cutover', status: 'failed', failedStep: 'validate' })
		).toBe('Stopped while checking the new site against the snapshot and the changes.');
		expect(
			failureReason({ type: 'migration.cutover', status: 'failed', failedStep: 'route' })
		).toBe('Stopped while waiting for your address to point at the new site.');
	});

	it('lists what the owner does by hand, with the address, the cache time and the policy', () => {
		const steps = cutoverHandSteps('www.example.edu', 60, 'freeze');
		expect(steps.map((step) => step.id)).toEqual([
			'lower-cache-time',
			'point-address',
			'restore-cache-time',
			'restore-writes'
		]);
		expect(steps[0]!.text).toContain('www.example.edu');
		expect(steps[0]!.text).toContain('60 seconds');
		expect(steps[3]!.text).toContain('maintenance mode');
		expect(cutoverHandSteps('a.test', 60, 'read-only')[3]!.text).toContain('Read Only Mode');
		for (const step of steps) {
			expect(step.text, step.id).not.toMatch(/workflow|durable|worker/i);
		}
	});

	it('states the rollback boundary in two plain sentences', () => {
		expect(ROLLBACK_BOUNDARY_COPY['dns-reversal']).toContain('first write');
		expect(ROLLBACK_BOUNDARY_COPY['dns-reversal']).toContain('nothing is lost');
		expect(ROLLBACK_BOUNDARY_COPY['post-write']).toContain('no longer a reversal');
		for (const sentence of Object.values(ROLLBACK_BOUNDARY_COPY)) {
			expect(sentence).toMatch(/^[\x20-\x7e]+$/);
			expect(sentence).not.toMatch(/_/);
		}
	});

	it.each([
		['no_ready_destination', 'live managed site'],
		['site_busy', 'still running'],
		['idempotency_key_reused', 'clashes'],
		['not_awaiting_approval', 'not waiting for your approval'],
		['not_observing', 'not live yet'],
		['not_waiting', 'has stopped']
	])('turns the %s refusal into a plain reason', (reason, text) => {
		expect(cutoverRefusalReason({ details: { reason }, message: 'server words' })).toContain(
			text
		);
	});

	it('falls back to the server message for a reason it does not name', () => {
		expect(
			cutoverRefusalReason({ details: { reason: 'new_thing' }, message: 'server words' })
		).toBe('server words');
		expect(cutoverRefusalReason({ details: null, message: 'server words' })).toBe(
			'server words'
		);
	});
});

describe('import copy', () => {
	it('labels the import and the check', () => {
		expect(operationTypeLabel('site.import')).toBe('Import');
		expect(operationTypeLabel('import.survey')).toBe('Check');
		expect(copyFor('site.import').title).toBe('Importing Your Site');
		expect(copyFor('import.survey').title).toBe('Checking Your Server');
		expect(copyFor('site.import').link({ targetIds: [SITE] })).toEqual({
			to: `/sites/${SITE}`,
			label: 'Open the New Site'
		});
	});

	it('labels the files step the import plan writes and no longer a landing step', () => {
		expect(stepLabel('site.import', 'files-convert')).toBe(
			'Preparing the files for the new site'
		);
		expect(stepLabel('site.import', 'files')).toBe(GENERIC_STEP_LABEL);
	});

	it('never offers a retry, since a retry would need a new key', () => {
		for (const type of ['site.import', 'import.survey']) {
			for (const status of ['failed', 'rolled-back'])
				expect(canRetry(type, status)).toBe(false);
		}
	});

	it.each([
		['source_auth_failed', 'did not accept the key'],
		['source_unreachable', 'did not answer'],
		['host_key_mismatch', 'different host key'],
		['credential_expired', 'expired'],
		['host_key_unconfirmed', 'not confirmed'],
		['dossier_refused', 'cannot be imported'],
		['dump_empty', 'empty database'],
		['dump_failed', 'did not finish'],
		['unsupported_statement', 'cannot store'],
		['no_statement_boundary', 'too large to copy'],
		['restore_too_large', 'larger than this site'],
		['restore_unsupported', 'too large for the version'],
		['restore_unaligned', 'too large to send in pieces'],
		['restore_busy', 'already loading'],
		['files_unreadable', 'files was cut short'],
		['files_bad_path', 'name that cannot be carried'],
		['files_too_many', 'more files'],
		['files_too_large', 'files are larger'],
		['import_failed', 'could not load'],
		['import_timeout', 'too long']
	])('turns the %s failure into a plain reason with no code in it', (code, text) => {
		const reason = failureReason({
			type: 'site.import',
			status: 'rolled-back',
			failedStep: 'dump',
			failedError: `${code}: server words`
		});
		expect(reason).toContain(text);
		expect(reason).not.toMatch(/_/);
		expect(reason).toMatch(/^[\x20-\x7e]+$/);
	});

	it('names the step when the failure has no code of its own', () => {
		expect(
			failureReason({
				type: 'site.import',
				status: 'failed',
				failedStep: 'restore',
				failedError: null
			})
		).toBe('Stopped while sending the database to the new site.');
	});

	it('names the site version and no number when the database is too large', () => {
		const reason = failureReason({
			type: 'site.import',
			status: 'rolled-back',
			failedStep: 'dump',
			failedError: 'restore_too_large: the database is larger'
		});
		expect(reason).toContain("this site's version");
		expect(reason).not.toMatch(/MiB|\d/);
	});

	it('counts the files that could not be copied and never lists a path', () => {
		const reason = failureReason({
			type: 'site.adopt',
			status: 'rolled-back',
			failedStep: 'files-copy',
			failedError: 'files_copy_failed: 3 of 40 files could not be read from the site'
		});
		expect(reason).toBe(
			'3 files could not be copied from the site. Nothing was left behind and the site was not changed. Try again.'
		);
		expect(
			failureReason({
				type: 'site.adopt',
				status: 'rolled-back',
				failedStep: 'files-copy',
				failedError: 'files_copy_failed: 1 of 2 files could not be read from the site'
			})
		).toContain('1 file could not');
		expect(
			failureReason({
				type: 'site.adopt',
				status: 'failed',
				failedStep: 'files-copy',
				failedError: 'files_copy_failed: unreadable'
			})
		).toContain('Some files could not be copied');
	});

	it('gives the file copy step of an adoption a plain phrase', () => {
		expect(stepLabel('site.adopt', 'files-copy')).not.toBe(GENERIC_STEP_LABEL);
		expect(stepLabel('site.adopt', 'files-copy')).not.toMatch(/R2|worker|digest|route/i);
	});

	it.each([
		['host_private', 'public internet'],
		['host_unresolved', 'could not be found'],
		['host_key_changed', 'different host key'],
		['survey_not_done', 'not finished'],
		['plan_full', 'no room'],
		['idempotency_key_reused', 'clashes'],
		['import_busy', 'already running'],
		['import_hours_today', 'for today'],
		['import_hours_this_month', 'for this month'],
		['import_approval_needed', 'scheduled with Drupflare'],
		['plan_not_capped', 'not available on this plan']
	])('turns the %s route refusal into a plain reason', (reason, text) => {
		expect(importRefusalReason({ details: { reason }, message: 'server words' })).toContain(
			text
		);
	});

	it('falls back to the server message for a reason it does not name', () => {
		expect(
			importRefusalReason({ details: { reason: 'new_thing' }, message: 'server words' })
		).toBe('server words');
	});

	it('keeps every import route refusal free of internal terms and raw codes', () => {
		for (const sentence of Object.values(IMPORT_ROUTE_REFUSALS)) {
			expect(sentence).not.toMatch(/\b(worker|durable|workflow|container|namespace|kv)\b/i);
			expect(sentence).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
		}
	});

	it('sends a failed import or check back to the import page, and names the Owner sign-in after an import', () => {
		const operation = { targetIds: [] } as Parameters<OperationCopy['failureLink']>[0];
		expect(copyFor('site.import').failureLink(operation)).toEqual({
			to: '/new/import',
			label: 'Back to Import'
		});
		expect(copyFor('import.survey').failureLink(operation)).toEqual({
			to: '/new/import',
			label: 'Back to Import'
		});
		expect(copyFor('site.import').success).toContain('Sign in as the Owner');
	});
});

describe('the import time limit copy', () => {
	it('gives the plain reason for an import stopped at its time limit', () => {
		expect(
			failureReason({
				type: 'site.import',
				status: 'failed',
				failedStep: 'dump',
				failedError: 'job_timeout: the import ran past its limit'
			})
		).toContain('time limit');
	});
});

describe('git pull copy', () => {
	it('titles the pull and goes back to the site on success and on failure', () => {
		const copy = copyFor('git.pull');
		expect(copy.title).toBe('Pulling From Your Repository');
		expect(copy.link({ targetIds: [SITE] })).toEqual({
			to: `/sites/${SITE}`,
			label: 'Back to the Site'
		});
		expect(copy.failureLink({ targetIds: [SITE] })?.to).toBe(`/sites/${SITE}`);
		expect(operationTypeLabel('git.pull')).toBe('Pull');
	});

	it('labels every step id the plan writes in plain words', () => {
		for (const id of ['lease', 'find', 'pull', 'record']) {
			expect(stepLabel('git.pull', id)).not.toBe(GENERIC_STEP_LABEL);
		}
		expect(stepLabel('git.pull', 'pull')).toBe('Installing the latest commit');
	});

	it('never offers a retry, since the next push or press starts a new pull', () => {
		expect(canRetry('git.pull', 'failed')).toBe(false);
	});

	it.each([
		['site_not_ready', 'not live'],
		['no_owner_token', 'no owner access'],
		['owner_token_rejected', 'did not accept'],
		['site_unreachable', 'did not answer'],
		['site_busy', 'Another change'],
		['lease_lost', 'took over'],
		['remote_not_on_site', 'Git page'],
		['remote_mount_differs', 'different folder'],
		['remote_gone', 'no longer follows'],
		['no_branch', 'no branch'],
		['no_module', 'no Drupal module'],
		['path_conflict', 'another repository'],
		['rolled_back', 'went back'],
		['pull_refused', 'could not fetch'],
		['answer_unreadable', 'unknown']
	])('turns the %s code into a plain reason', (code, text) => {
		const reason = failureReason({
			type: 'git.pull',
			status: 'failed',
			failedStep: 'pull',
			failedError: `${code}: engine words`
		});
		expect(reason).toContain(text);
		expect(reason).not.toContain('engine words');
		expect(reason).toMatch(/^[\x20-\x7e]+$/);
	});

	it('names the step when the failure has no code of its own', () => {
		expect(
			failureReason({
				type: 'git.pull',
				status: 'failed',
				failedStep: 'find',
				failedError: 'something odd'
			})
		).toBe('Stopped while finding the repository on the site.');
	});

	it.each([
		['site_not_live', 'not live'],
		['site_busy', 'still running'],
		['connection_revoked', 'revoked'],
		['idempotency_key_reused', 'clashes']
	])('turns the %s route refusal into a plain reason', (reason, text) => {
		expect(pullRefusalReason({ details: { reason }, message: 'server words' })).toContain(text);
	});

	it('falls back to the server message for a reason it does not name', () => {
		expect(
			pullRefusalReason({ details: { reason: 'new_thing' }, message: 'server words' })
		).toBe('server words');
		expect(pullRefusalReason({ details: null, message: 'server words' })).toBe('server words');
	});
});

describe('domain attach copy', () => {
	it('titles the attach and points at the domain page on success and on failure', () => {
		const copy = copyFor('domain.attach');
		expect(copy.title).toBe('Attaching Your Domain');
		expect(copy.link({ targetIds: [SITE] })).toEqual({
			to: `/sites/${SITE}/domain`,
			label: 'Open the Domain'
		});
		expect(copy.failureLink({ targetIds: [SITE] })?.to).toBe(`/sites/${SITE}/domain`);
		expect(operationTypeLabel('domain.attach')).toBe('Domain');
	});

	it('labels every step id the plan writes in plain words', () => {
		for (const id of [
			'lease',
			'claim',
			'request',
			'ownership',
			'certificate',
			'routing',
			'verification'
		]) {
			expect(stepLabel('domain.attach', id)).not.toBe(GENERIC_STEP_LABEL);
		}
		expect(stepLabel('domain.attach', 'certificate')).toBe('Waiting for the certificate');
	});

	it('never offers a retry, since the owner attaches again from the domain page', () => {
		expect(canRetry('domain.attach', 'failed')).toBe(false);
	});

	it.each([
		['hostname_taken', 'Another site already holds'],
		['platform_zone', 'keeps this domain'],
		['custom_domains_off', 'not turned on'],
		['ownership_failed', 'could not be confirmed'],
		['certificate_failed', 'certificate could not be issued'],
		['wait_timed_out', 'did not appear in time'],
		['site_not_ready', 'not live'],
		['site_busy', 'Another change'],
		['site_unreachable', 'did not answer'],
		['provider_unreachable', 'could not reach']
	])('turns the %s code into a plain reason', (code, text) => {
		const reason = failureReason({
			type: 'domain.attach',
			status: 'failed',
			failedStep: 'ownership',
			failedError: `${code}: engine words`
		});
		expect(reason).toContain(text);
		expect(reason).not.toContain('engine words');
		expect(reason).toMatch(/^[\x20-\x7e]+$/);
	});

	it('names the step when the failure has no code of its own', () => {
		expect(
			failureReason({
				type: 'domain.attach',
				status: 'failed',
				failedStep: 'routing',
				failedError: 'something odd'
			})
		).toBe('Stopped while sending the domain to your site.');
	});

	it('keeps infrastructure words out of every line the owner reads', () => {
		const copy = copyFor('domain.attach');
		const lines = [copy.title, copy.running, copy.success, copy.failure];
		for (const code of ['hostname_taken', 'custom_domains_off', 'custom_domains_refused']) {
			lines.push(
				failureReason({
					type: 'domain.attach',
					status: 'failed',
					failedStep: 'claim',
					failedError: `${code}: x`
				}) ?? ''
			);
		}
		for (const word of [
			/worker/i,
			/namespace/i,
			/zone id/i,
			/custom hostname/i,
			/authority/i
		]) {
			expect(lines.join(' ')).not.toMatch(word);
		}
	});
});

describe('adding a site to a box', () => {
	it('names the step a failure stopped at and the reason a box gave', () => {
		expect(copyFor('node.command').title).toBe('Adding Your Site to Your Box');
		expect(
			failureReason({
				type: 'node.command',
				status: 'failed',
				failedStep: 'wait',
				failedError: 'site_exists: this host is already on the box'
			})
		).toBe(nodeSiteFailureReason('site_exists'));
		expect(
			failureReason({
				type: 'node.command',
				status: 'failed',
				failedStep: 'wait',
				failedError: 'something odd'
			})
		).toBe(
			'Stopped while waiting for your box to add the site, which may need approval there.'
		);
	});

	it('answers an unknown code with the generic box failure and a refusal with its sentence', () => {
		expect(nodeSiteFailureReason('nope')).toBe(nodeSiteFailureReason('box_failed'));
		expect(
			nodeSiteRefusalReason({ details: { reason: 'node_offline' }, message: 'server text' })
		).toBe(nodeSiteFailureReason('node_offline'));
		expect(nodeSiteRefusalReason({ details: null, message: 'server text' })).toBe(
			'server text'
		);
	});

	it('keeps infrastructure words out of the lines the owner reads', () => {
		const copy = copyFor('node.command');
		const lines = [copy.title, copy.running, copy.success, copy.failure];
		for (const code of [
			'box_too_old',
			'declined_at_box',
			'not_approved',
			'no_tenant',
			'capacity_exceeded'
		]) {
			lines.push(nodeSiteFailureReason(code));
		}
		for (const word of [/workerd/i, /namespace/i, /durable object/i, /idempotency/i]) {
			expect(lines.join(' ')).not.toMatch(word);
		}
	});
});
