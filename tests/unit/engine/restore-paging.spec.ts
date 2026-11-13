import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../../contracts/src/common';
import type { OffloadedFile } from '../../../engine/src/ports';
import {
	cutParts,
	GROUP_BYTES,
	GROUP_PARTS,
	groupParts,
	restoreRoute,
	sha256Stream,
	statementEnds
} from '../../../engine/src/restore-paging';
import {
	copiedBytes,
	FILE_BATCH_BYTES,
	FILE_BATCH_FILES,
	takeBatch
} from '../../../engine/src/workflows/offloaded-files';
import {
	FILES_BODY_BYTES,
	MAX_RESTORE_PAGED_BYTES,
	RESTORE_PART_BYTES,
	restoreCeiling,
	SINGLE_RESTORE_BYTES
} from '../../../src/shared/restore-limits';
import { splitLikeTheWorker } from './backup-fakes';

const bytes = (text: string) => new TextEncoder().encode(text);
const sliceAt = (data: Uint8Array, cuts: number[]) =>
	cuts.map((end, index) => new TextDecoder().decode(data.subarray(cuts[index - 1] ?? 0, end)));

describe('statement ends', () => {
	it('ignores a semicolon inside a quote and inside a comment', () => {
		const text = 'INSERT INTO t VALUES (\'a;b\'); -- not; here\nSELECT "x;y";\n';
		const ends = statementEnds(bytes(text));
		expect(ends).toHaveLength(2);
		expect(text.slice(0, ends[0])).toBe("INSERT INTO t VALUES ('a;b');");
	});

	it('reads a doubled quote as content', () => {
		expect(statementEnds(bytes("INSERT INTO t VALUES ('it''s;fine');"))).toHaveLength(1);
	});

	it('refuses text that ends inside a statement or a quote', () => {
		expect(() => statementEnds(bytes('INSERT INTO t VALUES (1)'))).toThrow(
			/inside a statement/
		);
		expect(() => statementEnds(bytes("INSERT INTO t VALUES ('open);"))).toThrow(
			/inside a statement/
		);
	});

	it('accepts blanks and a comment after the last statement', () => {
		expect(statementEnds(bytes('SELECT 1;\n-- done\n'))).toEqual([10]);
	});
});

describe('cutParts', () => {
	const row = (n: number) => `INSERT INTO t VALUES (${n}, 'row ${n}; a semicolon');\n`;

	it('is empty for no text and one cut for text that fits', () => {
		expect(cutParts(new Uint8Array(0))).toEqual([]);
		const small = bytes(row(1));
		expect(cutParts(small)).toEqual([small.length]);
	});

	it('cuts only after a statement and never above the limit', () => {
		const text = Array.from({ length: 50 }, (_, n) => row(n)).join('');
		const data = bytes(text);
		const cuts = cutParts(data, 300);
		expect(cuts.at(-1)).toBe(data.length);
		const parts = sliceAt(data, cuts);
		for (const part of parts) {
			expect(bytes(part).length).toBeLessThanOrEqual(300);
			const read = splitLikeTheWorker(part);
			expect(read.tail).toBe('');
		}
		expect(parts.join('')).toBe(text);
		expect(parts.length).toBeGreaterThan(5);
	});

	it('takes a part of exactly the limit when a statement ends on it', () => {
		const first = 'INSERT INTO t VALUES (1);\n';
		const limit = bytes(first).length;
		const data = bytes(first + 'INSERT INTO t VALUES (2);\n');
		expect(cutParts(data, limit)).toEqual([limit, data.length]);
	});

	it('cuts one byte under the limit before the statement that would pass it', () => {
		const first = 'INSERT INTO t VALUES (1);\n';
		const limit = bytes(first).length - 1;
		expect(() => cutParts(bytes(first), limit)).toThrow(/wider than one part/);
	});

	it('leaves a short last part and drops what follows the last statement', () => {
		const text = `${row(1)}${row(2)}${row(3)}-- end\n`;
		const data = bytes(text);
		const cuts = cutParts(data, bytes(row(1)).length * 2);
		const parts = sliceAt(data, cuts);
		expect(parts).toEqual([`${row(1)}${row(2)}`, row(3)]);
		expect(cutParts(bytes('-- only a comment\n'))).toEqual([]);
	});

	it('refuses a single statement wider than a part', () => {
		const wide = bytes(`INSERT INTO t VALUES ('${'x'.repeat(2_000)}');\n`);
		expect(() => cutParts(wide, 1_000)).toThrow(/wider than one part/);
	});

	it('cuts a dump just above the part size into parts the worker accepts', () => {
		const pad = 'x'.repeat(900);
		const text = Array.from(
			{ length: 2_500 },
			(_, n) => `INSERT INTO t VALUES (${n}, '${pad}');\n`
		).join('');
		const data = bytes(text);
		const cuts = cutParts(data);
		expect(cuts.length).toBe(
			Math.ceil(data.length / RESTORE_PART_BYTES) + (cuts.length > 3 ? 0 : 0)
		);
		let from = 0;
		for (const end of cuts) {
			expect(end - from).toBeLessThanOrEqual(RESTORE_PART_BYTES);
			from = end;
		}
	});
});

describe('groupParts', () => {
	it('keeps parts in order and inside the byte and count caps', () => {
		const sizes = Array.from({ length: 40 }, () => 1_000_000);
		const groups = groupParts(sizes);
		expect(groups.flat()).toEqual(sizes.map((_, index) => index));
		for (const group of groups) {
			expect(group.length).toBeLessThanOrEqual(GROUP_PARTS);
			expect(group.reduce((sum, index) => sum + sizes[index]!, 0)).toBeLessThanOrEqual(
				GROUP_BYTES
			);
		}
		expect(groups).toHaveLength(3);
	});

	it('splits exactly at the byte cap and one byte over', () => {
		expect(groupParts([GROUP_BYTES / 2, GROUP_BYTES / 2])).toEqual([[0, 1]]);
		expect(groupParts([GROUP_BYTES / 2, GROUP_BYTES / 2 + 1])).toEqual([[0], [1]]);
	});

	it('caps the count for many small parts and runs an oversize part alone', () => {
		expect(groupParts(Array.from({ length: GROUP_PARTS + 1 }, () => 10))).toEqual([
			Array.from({ length: GROUP_PARTS }, (_, index) => index),
			[GROUP_PARTS]
		]);
		expect(groupParts([10, GROUP_BYTES + 5, 10])).toEqual([[0], [1], [2]]);
		expect(groupParts([])).toEqual([]);
	});

	it('puts the last short part in its own group when it does not fit', () => {
		const sizes = [...Array.from({ length: 16 }, () => 1_048_576), 5];
		expect(groupParts(sizes)).toEqual([sizes.slice(0, 16).map((_, i) => i), [16]]);
	});
});

describe('restoreRoute', () => {
	it('keeps one body up to the single ceiling without asking the site', () => {
		expect(restoreRoute(SINGLE_RESTORE_BYTES, MAX_RESTORE_PAGED_BYTES, null)).toBe('single');
		expect(restoreRoute(1, SINGLE_RESTORE_BYTES, null)).toBe('single');
	});

	it('asks the site for a body one byte over, then pages or refuses', () => {
		const bytesOver = SINGLE_RESTORE_BYTES + 1;
		expect(restoreRoute(bytesOver, MAX_RESTORE_PAGED_BYTES, null)).toBe('probe');
		expect(restoreRoute(bytesOver, MAX_RESTORE_PAGED_BYTES, true)).toBe('paged');
		expect(restoreRoute(bytesOver, MAX_RESTORE_PAGED_BYTES, false)).toBe('unsupported');
	});

	it('takes exactly the paged ceiling and refuses one byte over', () => {
		expect(restoreRoute(MAX_RESTORE_PAGED_BYTES, MAX_RESTORE_PAGED_BYTES, true)).toBe('paged');
		expect(restoreRoute(MAX_RESTORE_PAGED_BYTES + 1, MAX_RESTORE_PAGED_BYTES, true)).toBe(
			'too_large'
		);
	});

	it('never exceeds the worker ceiling whatever the caller allows', () => {
		expect(restoreRoute(MAX_RESTORE_PAGED_BYTES + 1, MAX_RESTORE_PAGED_BYTES * 4, true)).toBe(
			'too_large'
		);
		expect(restoreRoute(SINGLE_RESTORE_BYTES + 1, SINGLE_RESTORE_BYTES, true)).toBe(
			'too_large'
		);
	});

	it('picks the ceiling by whether the sites page', () => {
		expect(restoreCeiling(false)).toBe(SINGLE_RESTORE_BYTES);
		expect(restoreCeiling(true)).toBe(MAX_RESTORE_PAGED_BYTES);
		expect(FILES_BODY_BYTES).toBe(SINGLE_RESTORE_BYTES);
	});
});

describe('sha256Stream', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('hashes written chunks as one body', async () => {
		const stream = sha256Stream();
		await stream.write(bytes('hello '));
		await stream.write(bytes('world'));
		expect(await stream.digest()).toBe(await sha256Hex('hello world'));
	});

	it('uses a digest stream where the runtime has one', async () => {
		const written: Uint8Array[] = [];
		class FakeDigestStream {
			digest = Promise.resolve(new Uint8Array(32).fill(171).buffer);
			constructor(readonly algorithm: string) {}
			getWriter() {
				return {
					write: async (chunk: Uint8Array) => {
						written.push(chunk);
					},
					close: async () => undefined
				};
			}
		}
		vi.stubGlobal('crypto', { ...globalThis.crypto, DigestStream: FakeDigestStream });
		const stream = sha256Stream();
		await stream.write(bytes('abc'));
		expect(await stream.digest()).toBe('ab'.repeat(32));
		expect(written).toHaveLength(1);
	});
});

describe('the file batches', () => {
	const file = (n: number, size: number): OffloadedFile => ({
		uri: `public://f${String(n).padStart(4, '0')}.bin`,
		size,
		contentType: null,
		sha256: null,
		modified: 1
	});

	it('takes files until the count cap', () => {
		const files = Array.from({ length: FILE_BATCH_FILES + 5 }, (_, n) => file(n, 10));
		expect(takeBatch(files)).toHaveLength(FILE_BATCH_FILES);
	});

	it('takes files until the byte cap, exactly at it and one byte over', () => {
		expect(
			takeBatch([file(1, FILE_BATCH_BYTES / 2), file(2, FILE_BATCH_BYTES / 2)])
		).toHaveLength(2);
		expect(
			takeBatch([file(1, FILE_BATCH_BYTES / 2), file(2, FILE_BATCH_BYTES / 2 + 1)])
		).toHaveLength(1);
	});

	it('takes a file larger than the byte cap on its own', () => {
		const taken = takeBatch([file(1, FILE_BATCH_BYTES * 3), file(2, 10)]);
		expect(taken.map((item) => item.uri)).toEqual([file(1, 0).uri]);
		expect(takeBatch([])).toEqual([]);
	});

	it('prices a file as two hex characters a byte plus its rows', () => {
		expect(copiedBytes(1_000, 3)).toBe(2_000 + 3 * 1_024);
	});
});
