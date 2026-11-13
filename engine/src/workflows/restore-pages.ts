import { sha256Hex } from '@contracts/common';
import { MAX_RESTORE_PAGED_BYTES } from '../../../src/shared/restore-limits';
import { BackupError } from '../backup-parts';
import type { BackupDeps } from '../ports';
import {
	cutParts,
	groupParts,
	restoreRoute,
	sha256Stream,
	type RestoreRoute
} from '../restore-paging';
import { PermanentError } from '../step';
import { fenced, runStep, type Ctx } from './common';

// the worker takes 8192, but the plan is one step result and a step result stays under 1 MiB
const MAX_PARTS = 2048;

export interface PagedTarget {
	siteId: string;
	hostname: string;
	ownerTokenId: string;
	// the import label, so the apply step finds the upload once it is assembled
	label: string;
}

// a part is the bytes from..to of one stored blob, each blob holding whole statements
export interface Piece {
	key: string;
	from: number;
	to: number;
	sha256: string;
}

interface Plan {
	pieces: Piece[];
	bytes: number;
	sha256: string;
}

// the restore step ends here on both routes, since the work before it never finishes the step
// and returns the clock the apply wait counts from
export function finishRestore(ctx: Ctx): Promise<number> {
	return runStep(ctx, 'restore.finish', 'restore', async () => ctx.deps.now());
}

// what the route is for a body of this size, asking the site only when the size needs paging
export async function chooseRoute(
	deps: BackupDeps,
	target: Omit<PagedTarget, 'label'>,
	bytes: number,
	ceilingBytes: number
): Promise<'single' | 'paged'> {
	let route: RestoreRoute = restoreRoute(bytes, ceilingBytes, null);
	if (route === 'probe') {
		const supported = await deps.custody.withOwnerToken(
			target.siteId,
			target.ownerTokenId,
			(bearer) => deps.worker.pagedRestoreSupported(target.hostname, { bearer })
		);
		route = restoreRoute(bytes, ceilingBytes, supported);
	}
	if (route === 'too_large') {
		throw new BackupError(
			'restore_too_large',
			`the dump is ${bytes} bytes, over the ${Math.min(ceilingBytes, MAX_RESTORE_PAGED_BYTES)} a site accepts in a restore`
		);
	}
	if (route === 'unsupported') {
		throw new BackupError(
			'restore_unsupported',
			`${target.siteId} runs a release without the paged restore, and the dump is ${bytes} bytes`
		);
	}
	return route === 'single' ? 'single' : 'paged';
}

async function blob(deps: BackupDeps, key: string): Promise<Uint8Array> {
	const bytes = await deps.blobs.get(key);
	if (bytes === null) throw new BackupError('part_missing', 'a part of the dump is missing');
	return bytes;
}

// cuts every stored blob into parts and hashes each part and the whole, reading one blob at a time
async function planPieces(deps: BackupDeps, keys: readonly string[]): Promise<Plan> {
	const pieces: Piece[] = [];
	const whole = sha256Stream();
	let bytes = 0;
	for (const key of keys) {
		const stored = await blob(deps, key);
		let from = 0;
		for (const to of cutParts(stored)) {
			const part = stored.subarray(from, to);
			pieces.push({ key, from, to, sha256: await sha256Hex(part) });
			await whole.write(part);
			bytes += part.byteLength;
			from = to;
		}
	}
	return { pieces, bytes, sha256: await whole.digest() };
}

// a permanent refusal ends the upload on the site, so nothing stays half sent
async function abortOnRefusal<T>(
	deps: BackupDeps,
	target: PagedTarget,
	upload: string | null,
	work: () => Promise<T>
): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (upload !== null && error instanceof PermanentError) {
			await abortUpload(deps, target, upload);
		}
		throw error;
	}
}

// sends the stored blobs as one paged upload. Every call after the plan is its own workflow step,
// and each step starts from what the site holds, so a step that died after some parts went in puts
// only the rest. The plan step names the parts once; a retry reads the same bytes at the same
// places and so puts the same part again
export async function landPaged(
	ctx: Ctx,
	deps: BackupDeps,
	target: PagedTarget,
	keys: readonly string[],
	ceilingBytes: number
): Promise<number> {
	const withToken = <T>(use: (bearer: string) => Promise<T>) =>
		deps.custody.withOwnerToken(target.siteId, target.ownerTokenId, use);
	const stepOf = <T>(name: string, work: () => Promise<T>) =>
		runStep(ctx, name, 'restore', work, { finish: false });
	const finish = () => finishRestore(ctx);

	const plan = await stepOf('restore.plan', async () => {
		await fenced(ctx);
		const planned = await planPieces(deps, keys);
		if (planned.bytes > Math.min(ceilingBytes, MAX_RESTORE_PAGED_BYTES)) {
			throw new BackupError(
				'restore_too_large',
				`the dump is ${planned.bytes} bytes, over what a site accepts in a restore`
			);
		}
		if (planned.pieces.length > MAX_PARTS) {
			throw new BackupError(
				'restore_too_large',
				`the dump needs ${planned.pieces.length} parts, over the ${MAX_PARTS} a site accepts`
			);
		}
		return planned;
	});

	// a site that already holds an import under this label has been sent the dump
	const begun = await stepOf('restore.begin', async () => {
		await fenced(ctx);
		return withToken(async (bearer) => {
			const state = await deps.worker.importState(target.hostname, target.label, { bearer });
			if (state !== 'absent') return { upload: null as string | null };
			const { upload } = await deps.worker.beginRestore(
				target.hostname,
				{
					bytes: plan.bytes,
					parts: plan.pieces.length,
					sha256: plan.sha256,
					label: target.label
				},
				{ bearer }
			);
			return { upload: upload as string | null };
		});
	});
	const { upload } = begun;
	if (upload === null) return finish();

	const groups = groupParts(plan.pieces.map((piece) => piece.to - piece.from));
	for (const [index, group] of groups.entries()) {
		await stepOf(`restore.put.${index}`, () =>
			abortOnRefusal(deps, target, upload, async () => {
				await fenced(ctx);
				await withToken(async (bearer) => {
					const held = await deps.worker.restoreStatus(target.hostname, upload, {
						bearer
					});
					if (held === null) {
						throw new BackupError(
							'restore_rejected',
							'the site no longer holds the upload'
						);
					}
					const have = new Set(held.receivedParts);
					for (const number of group) {
						if (have.has(number)) continue;
						const piece = plan.pieces[number]!;
						const part = (await blob(deps, piece.key)).subarray(piece.from, piece.to);
						if ((await sha256Hex(part)) !== piece.sha256) {
							throw new BackupError(
								'part_changed',
								`part ${number} changed after it was planned`
							);
						}
						await deps.worker.putRestorePart(
							target.hostname,
							upload,
							number,
							part,
							piece.sha256,
							{ bearer }
						);
					}
				});
			})
		);
	}

	// the first call checks and hashes the parts, each later one assembles a bounded share
	const stop = (why: string) =>
		stepOf('restore.stalled', async () => {
			await abortUpload(deps, target, upload);
			throw new BackupError('restore_stalled', why);
		});
	const limit = plan.pieces.length + 3;
	let assembled = -1;
	let stalled = 0;
	for (let call = 0; ; call++) {
		if (call >= limit) return stop('the site did not finish assembling the dump') as never;
		const answer = await stepOf(`restore.commit.${call}`, () =>
			abortOnRefusal(deps, target, upload, async () => {
				await fenced(ctx);
				return withToken(async (bearer) => {
					const committed = await deps.worker.commitRestore(target.hostname, upload, {
						bearer
					});
					if (!committed.gone) return committed;
					// the call that finished the upload answered and its result was lost
					const state = await deps.worker.importState(target.hostname, target.label, {
						bearer
					});
					if (state === 'absent') {
						throw new BackupError(
							'restore_rejected',
							'the site no longer holds the upload'
						);
					}
					return { ...committed, done: true };
				});
			})
		);
		if (answer.done) break;
		stalled = call > 0 && answer.assembledParts <= assembled ? stalled + 1 : 0;
		assembled = answer.assembledParts;
		if (stalled >= 2) {
			return stop('the site stopped making progress assembling the dump') as never;
		}
	}
	return finish();
}

async function abortUpload(deps: BackupDeps, target: PagedTarget, upload: string): Promise<void> {
	await deps.custody
		.withOwnerToken(target.siteId, target.ownerTokenId, (bearer) =>
			deps.worker.abortRestore(target.hostname, upload, { bearer })
		)
		.catch(() => undefined);
}
