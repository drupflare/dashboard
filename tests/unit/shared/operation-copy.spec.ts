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
	cutoverRefusalReason,
	failedStepError,
	failedStepId,
	failureReason,
	GENERIC_STEP_LABEL,
	GENERIC_TYPE_LABEL,
	LARGER_RESTORE_TITLE,
	needsLargerRestore,
	OPERATION_COPY,
	operationTypeLabel,
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
	'migration.cutover',
	'backup.create',
	'backup.restore'
];
const WORKFLOWS = fileURLToPath(new URL('../../../engine/src/workflows/', import.meta.url));

// (type, step id) pairs the engine writes, read from the plan literals so a new step fails here
function enginePlanSteps(): { type: string; id: string }[] {
	const pairs: { type: string; id: string }[] = [];
	for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith('.ts'))) {
		const text = readFileSync(WORKFLOWS + file, 'utf8');
		const marks = [...text.matchAll(/type: '((?:site|backup|migration)\.[a-z-]+)'/g)];
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
	it('covers the seven operations the progress screen names, and no other', () => {
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
		expect(reason).toContain('16 MiB');
		expect(reason).toContain('Nothing was created');
		expect(reason).toContain('paged restore');
		expect(reason).not.toContain('restore_too_large');
	});

	it.each([
		['already_adopted', 'This site was already adopted.'],
		['not_self_managed', 'Only a self-managed site can be adopted.'],
		['source_unreachable', 'Your site did not answer'],
		['no_owner_token', 'no owner access'],
		['site_not_ready', 'The site is not live'],
		['unsupported_kind', 'cannot be adopted yet'],
		['files_outside_database', 'live only in object storage']
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
		).toBe('Stopped while pointing your address at the new site.');
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
