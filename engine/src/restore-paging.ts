import { sha256Hex } from '@contracts/common';
import {
	MAX_RESTORE_PAGED_BYTES,
	RESTORE_PART_BYTES,
	SINGLE_RESTORE_BYTES
} from '../../src/shared/restore-limits';
import { BackupError } from './backup-parts';

// a group of parts is one workflow step: the most it puts, in bytes and in parts. 16 MiB matches
// the worker's own work per commit call, and a 1 MiB part is one request of a few hundred ms, so
// a step stays well under the 60 s a call may take and the 10 minute step default; the count cap
// keeps a dump of many small parts from piling hundreds of requests into one step
export const GROUP_BYTES = 16 * 1024 * 1024;
export const GROUP_PARTS = 64;

const SEMICOLON = 59;
const QUOTE = 39;
const DOUBLE = 34;
const DASH = 45;
const NEWLINE = 10;

const blank = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;

// where each statement of the text ends, read the way the worker reads a part: a quote of either
// kind opens a run to the next one, and a double dash comment runs to the end of its line
export function statementEnds(bytes: Uint8Array): number[] {
	const ends: number[] = [];
	let single = false;
	let double = false;
	let pending = false;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (single) {
			if (byte === QUOTE) single = false;
			continue;
		}
		if (double) {
			if (byte === DOUBLE) double = false;
			continue;
		}
		if (byte === QUOTE) {
			single = true;
			pending = true;
		} else if (byte === DOUBLE) {
			double = true;
			pending = true;
		} else if (byte === DASH && bytes[i + 1] === DASH) {
			const newline = bytes.indexOf(NEWLINE, i);
			i = newline === -1 ? bytes.length : newline;
		} else if (byte === SEMICOLON) {
			// the line break after a statement goes with it, so a part can end on exactly its limit
			const crlf = bytes[i + 1] === 13 && bytes[i + 2] === NEWLINE;
			ends.push(i + 1 + (crlf ? 2 : bytes[i + 1] === NEWLINE ? 1 : 0));
			pending = false;
		} else if (!blank(byte)) {
			pending = true;
		}
	}
	if (pending || single || double) {
		throw new BackupError('restore_unaligned', 'the dump ends inside a statement');
	}
	return ends;
}

// cuts a run of whole statements into parts of at most maxBytes, each ending on a statement end.
// What follows the last statement (blanks, a comment) is dropped, since the parts joined are the
// dump the digest covers and a part of only blanks is no part
export function cutParts(bytes: Uint8Array, maxBytes = RESTORE_PART_BYTES): number[] {
	const ends = statementEnds(bytes);
	const cuts: number[] = [];
	let start = 0;
	let at = 0;
	while (at < ends.length) {
		let end = -1;
		while (at < ends.length && ends[at]! <= start + maxBytes) {
			end = ends[at]!;
			at++;
		}
		if (end <= start) {
			throw new BackupError(
				'restore_unaligned',
				'a statement in the dump is wider than one part'
			);
		}
		cuts.push(end);
		start = end;
	}
	return cuts;
}

// contiguous runs of part indexes, each within maxBytes and maxParts; a part over maxBytes on its
// own is a run of one
export function groupParts(
	sizes: readonly number[],
	maxBytes = GROUP_BYTES,
	maxParts = GROUP_PARTS
): number[][] {
	const groups: number[][] = [];
	let current: number[] = [];
	let bytes = 0;
	sizes.forEach((size, index) => {
		if (current.length > 0 && (bytes + size > maxBytes || current.length >= maxParts)) {
			groups.push(current);
			current = [];
			bytes = 0;
		}
		current.push(index);
		bytes += size;
	});
	if (current.length > 0) groups.push(current);
	return groups;
}

export type RestoreRoute = 'single' | 'paged' | 'probe' | 'unsupported' | 'too_large';

// supported is null until the site has been asked; a body that fits one request never needs to ask
export function restoreRoute(
	bytes: number,
	ceilingBytes: number,
	supported: boolean | null
): RestoreRoute {
	if (bytes <= SINGLE_RESTORE_BYTES) return 'single';
	if (bytes > Math.min(ceilingBytes, MAX_RESTORE_PAGED_BYTES)) return 'too_large';
	if (supported === null) return 'probe';
	return supported ? 'paged' : 'unsupported';
}

export interface Sha256Stream {
	write(bytes: Uint8Array): Promise<void>;
	digest(): Promise<string>;
}

const hex = (buffer: ArrayBuffer) =>
	Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

// Workers hash a stream without holding it; where DigestStream does not exist (the Node test
// runner) the chunks are kept and hashed once
export function sha256Stream(): Sha256Stream {
	const Digest = (
		crypto as unknown as {
			DigestStream?: new (algorithm: string) => {
				getWriter(): { write(bytes: Uint8Array): Promise<void>; close(): Promise<void> };
				digest: Promise<ArrayBuffer>;
			};
		}
	).DigestStream;
	if (Digest !== undefined) {
		const stream = new Digest('SHA-256');
		const writer = stream.getWriter();
		return {
			write: (bytes) => writer.write(bytes),
			async digest() {
				await writer.close();
				return hex(await stream.digest);
			}
		};
	}
	const chunks: Uint8Array[] = [];
	return {
		async write(bytes) {
			chunks.push(new Uint8Array(bytes));
		},
		async digest() {
			const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
			let at = 0;
			for (const chunk of chunks) {
				out.set(chunk, at);
				at += chunk.byteLength;
			}
			return sha256Hex(out);
		}
	};
}
