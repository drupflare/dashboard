import { utf8 } from '@contracts/common';
import { RESTORE_PART_BYTES } from '../../../src/shared/restore-limits';
import { BackupError } from '../backup-parts';
import {
	chunkCount,
	chunkStatements,
	FILE_CHUNK_BYTES,
	fileRowStatements,
	mirrorStatement,
	TABLES
} from '../files-convert';
import type { BackupDeps, OffloadedFile } from '../ports';
import { sha256Stream } from '../restore-paging';
import { PermanentError } from '../step';
import { openSite } from './backup-create';
import { fenced, runStep, type Ctx } from './common';

// one workflow step carries at most this many files and this many file bytes; a file larger than
// the byte cap goes alone, streamed, so the cap bounds the work of a step and never a file
export const FILE_BATCH_FILES = 50;
export const FILE_BATCH_BYTES = 8 * 1024 * 1024;

// unreviewed: the files one copy carries, which at the batch size keeps it to about 200 steps
export const MAX_COPIED_FILES = 10_000;

// each file is read this many times before it counts as one that could not be copied
export const FILE_ATTEMPTS = 2;

// the statements of a file are hex, two characters a byte, plus the rows around them
const ROW_BYTES = 1024;
export const copiedBytes = (bytes: number, files: number) => bytes * 2 + files * ROW_BYTES;

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;

export function copiedFilesPrefix(orgId: string, operationId: string): string {
	if (!SEGMENT.test(orgId) || !SEGMENT.test(operationId)) {
		throw new BackupError('bad_key', 'a copied files key part is not an id');
	}
	return `copied-files/${orgId}/${operationId}/`;
}

const pad = (value: number, width: number) => String(value).padStart(width, '0');
const pieceKey = (prefix: string, batch: number, piece: number) =>
	`${prefix}batch-${pad(batch, 5)}-${pad(piece, 5)}.sql`;

// the files of a page that one step takes: in order, until the next would pass a cap, and always
// at least one so a file over the byte cap still moves
export function takeBatch(
	files: readonly OffloadedFile[],
	maxFiles = FILE_BATCH_FILES,
	maxBytes = FILE_BATCH_BYTES
): OffloadedFile[] {
	const taken: OffloadedFile[] = [];
	let bytes = 0;
	for (const file of files) {
		if (taken.length > 0 && (taken.length >= maxFiles || bytes + file.size > maxBytes)) break;
		taken.push(file);
		bytes += file.size;
	}
	return taken;
}

// #region one file as statements

// writes statements into stored pieces of at most one part each
class PieceWriter {
	private text: string[] = [];
	private size = 0;
	pieces = 0;
	bytes = 0;

	constructor(
		private readonly deps: BackupDeps,
		private readonly prefix: string,
		private readonly batch: number
	) {}

	async push(statements: readonly string[]): Promise<void> {
		for (const statement of statements) {
			const line = `${statement}\n`;
			const length = utf8(line).byteLength;
			if (this.size > 0 && this.size + length > RESTORE_PART_BYTES) await this.flush();
			this.text.push(line);
			this.size += length;
		}
	}

	async flush(): Promise<void> {
		if (this.text.length === 0) return;
		await this.deps.blobs.put(
			pieceKey(this.prefix, this.batch, this.pieces),
			utf8(this.text.join(''))
		);
		this.pieces++;
		this.bytes += this.size;
		this.text = [];
		this.size = 0;
	}
}

class FileCopyError extends Error {}

// streams one file from the site into statements: a chunk of the file is held at a time, and the
// digest and the size are checked once the last byte has gone through
async function copyFile(
	deps: BackupDeps,
	hostname: string,
	bearer: string,
	file: OffloadedFile,
	writer: PieceWriter,
	first: boolean,
	nowMs: number
): Promise<void> {
	const streamed = await deps.worker.offloadedStream(hostname, file.uri, { bearer });
	if (streamed.size !== file.size) {
		await streamed.body.cancel();
		throw new FileCopyError('the size differs from the list');
	}
	if (first) await writer.push(TABLES);
	await writer.push(
		fileRowStatements({
			uri: file.uri,
			size: file.size,
			chunks: chunkCount(file.size),
			mime: file.contentType,
			modified: file.modified,
			nowMs
		})
	);
	const hash = file.sha256 === null ? null : sha256Stream();
	const reader = streamed.body.getReader();
	const window = new Uint8Array(FILE_CHUNK_BYTES);
	let filled = 0;
	let seq = 0;
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > file.size) {
			await reader.cancel();
			throw new FileCopyError('the file is longer than the list says');
		}
		await hash?.write(value);
		let at = 0;
		while (at < value.byteLength) {
			const take = Math.min(FILE_CHUNK_BYTES - filled, value.byteLength - at);
			window.set(value.subarray(at, at + take), filled);
			filled += take;
			at += take;
			if (filled === FILE_CHUNK_BYTES) {
				await writer.push(chunkStatements(file.uri, seq++, window));
				filled = 0;
			}
		}
	}
	if (total !== file.size) throw new FileCopyError('the file is shorter than the list says');
	if (filled > 0 || seq === 0) {
		await writer.push(chunkStatements(file.uri, seq, window.subarray(0, filled)));
	}
	if (hash !== null && (await hash.digest()) !== file.sha256?.toLowerCase()) {
		throw new FileCopyError('the digest differs from the list');
	}
	await writer.push([mirrorStatement(file.uri, nowMs)]);
}

// #endregion

export interface CopiedFiles {
	// stored blobs of statements, in the order they replay
	keys: string[];
	// the bytes of those blobs
	bytes: number;
	files: number;
}

export const NO_COPIED_FILES: CopiedFiles = { keys: [], bytes: 0, files: 0 };

interface BatchResult {
	after: string | null;
	done: boolean;
	files: number;
	failed: number;
	pieces: number;
	bytes: number;
	// the source's total on the first page
	total: { files: number; bytes: number } | null;
}

export interface CopyInput {
	orgId: string;
	operationId: string;
	source: { id: string; accountId: string };
	// the stored dump the copied statements join, counted against the one ceiling
	dumpBytes: number;
	ceilingBytes: number;
}

// reads the listing of files held only in R2 and turns each file into statements that replace the
// dump's evicted row with a resident one. Every batch is one workflow step that starts at the last
// file the step before it reported, so a killed step rereads its own batch and writes the same keys
export async function copyOffloaded(
	ctx: Ctx,
	deps: BackupDeps,
	input: CopyInput
): Promise<CopiedFiles> {
	const prefix = copiedFilesPrefix(input.orgId, input.operationId);
	const keys: string[] = [];
	let after: string | null = null;
	let bytes = 0;
	let files = 0;
	let failed = 0;
	for (let batch = 0; ; batch++) {
		const from: string | null = after;
		const result: BatchResult = await runStep(
			ctx,
			`files-copy.${batch}`,
			'files-copy',
			async () => {
				await fenced(ctx);
				const source = await openSite(
					deps,
					{ id: input.source.id, orgId: input.orgId, accountId: input.source.accountId },
					{ notReady: 'site_not_ready', foreign: 'site_not_ready' }
				);
				return deps.custody.withOwnerToken(
					input.source.id,
					source.ownerTokenId,
					async (bearer) => {
						const page = await deps.worker.offloadedPage(
							source.hostname,
							from,
							FILE_BATCH_FILES,
							{ bearer }
						);
						if (page === null) {
							throw new BackupError(
								'files_unsupported',
								'the source site has no route to read files held only in object storage'
							);
						}
						const taken = takeBatch(page.files);
						const total = page.total;
						if (total !== null) {
							if (total.files > MAX_COPIED_FILES) {
								throw new BackupError(
									'files_too_many',
									`the site holds ${total.files} files only in object storage, over the ${MAX_COPIED_FILES} a copy carries`
								);
							}
							if (
								input.dumpBytes + copiedBytes(total.bytes, total.files) >
								input.ceilingBytes
							) {
								throw new BackupError(
									'restore_too_large',
									'the database and the files together are larger than a site accepts in a restore'
								);
							}
						}
						const writer = new PieceWriter(deps, prefix, batch);
						let missed = 0;
						for (const [index, file] of taken.entries()) {
							let copied = false;
							for (let attempt = 1; attempt <= FILE_ATTEMPTS && !copied; attempt++) {
								try {
									await copyFile(
										deps,
										source.hostname,
										bearer,
										file,
										writer,
										from === null && batch === 0 && index === 0,
										deps.now()
									);
									copied = true;
								} catch (error) {
									// a refused token ends the copy; any other error is one attempt used
									if (error instanceof PermanentError) throw error;
								}
							}
							if (!copied) missed++;
						}
						await writer.flush();
						const last = taken.at(-1);
						const all = taken.length === page.files.length;
						return {
							after: last === undefined ? from : last.uri,
							done: all && page.next === null,
							files: taken.length,
							failed: missed,
							pieces: writer.pieces,
							bytes: writer.bytes,
							total
						};
					}
				);
			},
			{ begin: batch === 0, finish: false }
		);
		for (let piece = 0; piece < result.pieces; piece++)
			keys.push(pieceKey(prefix, batch, piece));
		after = result.after;
		bytes += result.bytes;
		files += result.files;
		failed += result.failed;
		if (!result.done) {
			if (result.files === 0) {
				throw new BackupError(
					'files_copy_failed',
					'the list of files did not move forward'
				);
			}
			continue;
		}
		return runStep(
			ctx,
			'files-copy.finish',
			'files-copy',
			async () => {
				if (failed > 0) {
					throw new BackupError(
						'files_copy_failed',
						`${failed} of ${files} files could not be read from the site`
					);
				}
				if (input.dumpBytes + bytes > input.ceilingBytes) {
					throw new BackupError(
						'restore_too_large',
						'the database and the files together are larger than a site accepts in a restore'
					);
				}
				return { keys, bytes, files };
			},
			{ begin: false }
		);
	}
}
