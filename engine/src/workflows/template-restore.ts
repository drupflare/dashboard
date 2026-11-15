import { mebibytes, SINGLE_RESTORE_BYTES } from '../../../src/shared/restore-limits';
import type { EngineDeps, TemplateCreateDeps } from '../ports';
import { PermanentError } from '../step';
import { parseBundle, TemplateBundleError } from '../template-bundle';
import { fenced, runStep, type Ctx } from './common';

export interface TemplateCreate {
	entryId: string;
	commit: string;
	bundleKey: string;
}

export const TEMPLATE_RESTORE_STEPS = [
	{ id: 'template-restore', name: 'Send the template database' },
	{ id: 'template-apply', name: 'Wait for the site to apply the template' },
	{ id: 'template-code', name: 'Install the template code' }
];

// a window of the lock is 40 packages, so the largest measured lock (274) takes 7 windows; the cap
// only stops a site that never advances its cursor
const MAX_LOCK_WINDOWS = 30;

export type TemplateRestoreDeps = EngineDeps &
	Partial<Pick<TemplateCreateDeps, 'worker' | 'blobs' | 'sleep'>> & {
		templateCodeDelivery?: boolean;
	};

const APPLY_WAIT_MS = 10 * 60_000;
const APPLY_POLL_MS = 3000;

export class TemplateRestoreError extends PermanentError {}

function needed(deps: TemplateRestoreDeps) {
	const { worker, blobs, sleep } = deps;
	if (worker === undefined || blobs === undefined || sleep === undefined) {
		throw new TemplateRestoreError(
			'template_unavailable',
			'this engine cannot restore a template'
		);
	}
	return { worker, blobs, sleep };
}

function bundleRefusal(error: unknown): never {
	if (error instanceof TemplateBundleError)
		throw new TemplateRestoreError(error.code, error.message);
	throw error;
}

// the database of a built template goes into the new site the way a backup does: one body, sent
// once under the operation id, then polled until the site has applied it
export async function restoreTemplate(
	ctx: Ctx,
	deps: TemplateRestoreDeps,
	target: { siteId: string; hostname: string; ownerTokenId: string | null },
	template: TemplateCreate,
	options: { waitMs?: number; pollMs?: number } = {}
): Promise<void> {
	const label = ctx.operationId;
	const startedAt = await runStep(ctx, 'template-restore', 'template-restore', async () => {
		await fenced(ctx);
		const { worker, blobs } = needed(deps);
		if (target.ownerTokenId === null) {
			throw new TemplateRestoreError(
				'template_needs_owner_token',
				'the site has no owner token to restore a template with'
			);
		}
		const bytes = await blobs.get(template.bundleKey);
		if (bytes === null) {
			throw new TemplateRestoreError('template_missing', 'the template bundle is missing');
		}
		let sql: Uint8Array;
		try {
			const bundle = await parseBundle(bytes);
			if (
				bundle.manifest.entryId !== template.entryId ||
				bundle.manifest.commit !== template.commit
			) {
				throw new TemplateRestoreError(
					'template_changed',
					'the template bundle is for another template or commit'
				);
			}
			sql = bundle.section('database.sql');
		} catch (error) {
			return bundleRefusal(error);
		}
		if (sql.byteLength > SINGLE_RESTORE_BYTES) {
			throw new TemplateRestoreError(
				'restore_too_large',
				`This template's database is ${mebibytes(sql.byteLength)} MiB and a new site restores at most ${mebibytes(SINGLE_RESTORE_BYTES)} MiB. A larger restore path is not available yet.`
			);
		}
		const ownerTokenId = target.ownerTokenId;
		await deps.custody.withOwnerToken(target.siteId, ownerTokenId, async (bearer) => {
			const state = await worker.importState(target.hostname, label, { bearer });
			if (state === 'absent') await worker.restore(target.hostname, sql, label, { bearer });
		});
		return deps.now();
	});

	const waitMs = options.waitMs ?? APPLY_WAIT_MS;
	const pollMs = options.pollMs ?? APPLY_POLL_MS;
	await runStep(ctx, 'template-apply', 'template-apply', async () => {
		await fenced(ctx);
		const { worker, sleep } = needed(deps);
		const ownerTokenId = target.ownerTokenId as string;
		for (;;) {
			const state = await deps.custody.withOwnerToken(target.siteId, ownerTokenId, (bearer) =>
				worker.importState(target.hostname, label, { bearer })
			);
			if (state === 'applied') return;
			if (state === 'failed') {
				const reason = await deps.custody.withOwnerToken(
					target.siteId,
					ownerTokenId,
					(bearer) => worker.importReason(target.hostname, label, { bearer })
				);
				throw new TemplateRestoreError(
					'template_import_failed',
					`the site reported that the template import failed${reason === '' ? '' : ` at ${reason}`}`
				);
			}
			if (deps.now() >= startedAt + waitMs) {
				throw new TemplateRestoreError(
					'template_import_timeout',
					'the site had not applied the template in time'
				);
			}
			await sleep(pollMs);
		}
	});
}

// the site's sentence for a package it could not install, turned into the reason an owner reads
const LOCK_FAILURES: readonly (readonly [RegExp, string])[] = [
	[/does not match its published/, 'its download did not match its checksum'],
	[/is commit .+ so it is not installed/, 'its archive is a different commit from the lock'],
	[/has no downloadable archive/, 'it has no downloadable archive'],
	[/ships a .+ which is not read here/, 'its archive type is not supported'],
	[/publishes a digest this cannot read/, 'its checksum is in a format the site cannot read'],
	[/holds a path that leaves its mount/, 'its archive holds a path outside its folder'],
	[/^archive \d{3} from /, 'its archive could not be downloaded']
];

// the site's reason for a skipped package, in words an owner reads without the site's internals
const LOCK_SKIPS: readonly (readonly [RegExp, string])[] = [
	[/^composer-plugin:/, 'a Composer plugin, which cannot run on the site'],
	[/^metapackage:/, 'a metapackage with no files of its own'],
	[/^path package:/, 'the template carries its own copy of it'],
	[/^drupal core ships/, 'Drupal core is already part of the site'],
	[/^shipped: the pack carries .+ and keeps it/, 'the site keeps the version it already has'],
	[/^shipped: /, 'the site already has this version'],
	[/^provided:/, 'the site already has a package that provides it'],
	[/^no dist url/, 'the lock gives no download address for it']
];

// an unmatched sentence is passed through as the site wrote it
function lockFailureReason(error: string): string {
	return LOCK_FAILURES.find(([pattern]) => pattern.test(error))?.[1] ?? error;
}

function lockSkipReason(reason: string): string {
	return LOCK_SKIPS.find(([pattern]) => pattern.test(reason))?.[1] ?? reason;
}

// the note after the site name on a finished create; empty when the lock left nothing to say
export function lockSummaryNote(summary: TemplateCodeSummary): string {
	const { skippedPackages } = summary;
	const count = skippedPackages.length;
	const listed = skippedPackages.map((entry) => `${entry.name} (${entry.reason})`).join(', ');
	const verb = count === 1 ? 'package was' : 'packages were';
	const skipped = count === 0 ? '' : `; ${count} ${verb} skipped: ${listed}`;
	const patches =
		summary.patches === 'not applied'
			? '; Patches Not Applied, because a lock does not carry Composer patches'
			: '';
	return `${skipped}${patches}`;
}

function isRefusal(error: unknown): error is PermanentError {
	return error instanceof PermanentError && error.code === 'install_lock_refused';
}

// what the success note says about the lock; the site counts skips across the whole session
export interface TemplateCodeSummary {
	skippedPackages: { name: string; reason: string }[];
	patches: string;
}

// the database carries the installed extension list and configuration; the lock brings the code
// that list names, one window of packages per durable step, so a retry resumes at the last cursor
export async function installTemplateCode(
	ctx: Ctx,
	deps: TemplateRestoreDeps,
	target: { siteId: string; hostname: string; ownerTokenId: string | null },
	template: TemplateCreate
): Promise<TemplateCodeSummary | null> {
	let cursor = 0;
	let summary: TemplateCodeSummary | null = null;
	for (let window = 0; window < MAX_LOCK_WINDOWS; window++) {
		const next = await runStep(
			ctx,
			`template-code${window}`,
			'template-code',
			async () => {
				await fenced(ctx);
				const { worker, blobs } = needed(deps);
				if (target.ownerTokenId === null) {
					throw new TemplateRestoreError(
						'template_needs_owner_token',
						'the site has no owner token to install the template code with'
					);
				}
				const bytes = await blobs.get(template.bundleKey);
				if (bytes === null) {
					throw new TemplateRestoreError(
						'template_missing',
						'the template bundle is missing'
					);
				}
				let lock: Uint8Array | null;
				try {
					const bundle = await parseBundle(bytes);
					const listed = bundle.manifest.sections.some(
						(section) => section.name === 'composer.lock'
					);
					lock = listed ? bundle.section('composer.lock') : null;
				} catch (error) {
					return bundleRefusal(error);
				}
				if (lock === null) return { done: true, cursor: 0, summary: null };
				const body: Uint8Array = lock;
				const ownerTokenId = target.ownerTokenId;
				const answer = await deps.custody
					.withOwnerToken(target.siteId, ownerTokenId, (bearer) =>
						worker.installLock(target.hostname, body, cursor, { bearer })
					)
					.catch((error: unknown) => {
						if (isRefusal(error)) {
							throw new TemplateRestoreError(
								'template_code_refused',
								`the site will not install the template code: ${error.message}`
							);
						}
						throw error;
					});
				if (answer === 'absent') {
					throw new TemplateRestoreError(
						'template_code_unsupported',
						'the site does not have the route that installs a template lock yet'
					);
				}
				if (answer.failure !== null) {
					const reason = lockFailureReason(answer.failure.error);
					const removed = await deps.custody
						.withOwnerToken(target.siteId, ownerTokenId, (bearer) =>
							worker.rollbackLock(target.hostname, answer.session, { bearer })
						)
						.then(
							() => true,
							() => false
						);
					throw new TemplateRestoreError(
						'template_code_failed',
						`the site could not install ${answer.failure.name}: ${reason}${
							removed ? '' : '; the partly installed code could not be removed'
						}`
					);
				}
				if (!answer.done && answer.cursor <= cursor) {
					throw new TemplateRestoreError(
						'template_code_stalled',
						'the site did not advance through the template lock'
					);
				}
				if (!answer.done && window === MAX_LOCK_WINDOWS - 1) {
					throw new TemplateRestoreError(
						'template_code_stalled',
						'the template lock took more calls than a lock of this size should'
					);
				}
				return {
					done: answer.done,
					cursor: answer.cursor,
					summary: {
						skippedPackages: answer.skippedPackages.map((entry) => ({
							name: entry.name,
							reason: lockSkipReason(entry.reason)
						})),
						patches: answer.patches
					}
				};
			},
			{ finish: false }
		);
		summary = next.summary;
		if (next.done) break;
		cursor = next.cursor;
	}
	await runStep(ctx, 'template-code', 'template-code', async () => undefined);
	return summary;
}
