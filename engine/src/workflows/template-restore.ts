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
	{ id: 'template-apply', name: 'Wait for the site to apply the template' }
];

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
