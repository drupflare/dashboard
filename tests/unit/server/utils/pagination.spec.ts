import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	DEFAULT_LIMIT,
	MAX_LIMIT,
	decodeCursor,
	encodeCursor,
	resolveLimit,
	toPage
} from '../../../../src/server/utils/pagination';
import { thrownBy } from './support';

const cursorSchema = z.object({ id: z.string(), at: z.number().int() });

describe('cursors', () => {
	it('round-trips a value as base64url', () => {
		const cursor = encodeCursor({ id: 'site_1', at: 1700000000 });
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeCursor(cursor, cursorSchema)).toEqual({ id: 'site_1', at: 1700000000 });
	});

	it('refuses a cursor with a character outside base64url', () => {
		const cursor = encodeCursor({ id: 'a', at: 1 });
		expect(thrownBy(() => decodeCursor(`${cursor}%`, cursorSchema))).toMatchObject({
			code: 'validation'
		});
	});

	it('refuses a cursor that is not JSON', () => {
		const cursor = Buffer.from('not json').toString('base64url');
		expect(thrownBy(() => decodeCursor(cursor, cursorSchema))).toMatchObject({
			code: 'validation'
		});
	});

	it('refuses a cursor whose JSON has the wrong shape', () => {
		const cursor = Buffer.from(JSON.stringify({ id: 1 })).toString('base64url');
		expect(thrownBy(() => decodeCursor(cursor, cursorSchema))).toMatchObject({
			code: 'validation'
		});
	});

	it('refuses an empty cursor', () => {
		expect(thrownBy(() => decodeCursor('', cursorSchema))).toMatchObject({
			code: 'validation'
		});
	});
});

describe('resolveLimit', () => {
	it('uses the default when no limit is given', () => {
		expect(resolveLimit(undefined)).toBe(DEFAULT_LIMIT);
		expect(DEFAULT_LIMIT).toBe(25);
	});

	it('keeps a limit inside the range', () => {
		expect(resolveLimit(10)).toBe(10);
	});

	it('caps a limit above the maximum', () => {
		expect(resolveLimit(1000)).toBe(MAX_LIMIT);
		expect(MAX_LIMIT).toBe(100);
	});

	it.each([0, -3, 1.5])('refuses %s', (limit) => {
		expect(thrownBy(() => resolveLimit(limit))).toMatchObject({ code: 'validation' });
	});
});

describe('toPage', () => {
	type Row = { id: string; at: number };
	const cursorOf = (row: Row) => ({ id: row.id, at: row.at });
	const rows: Row[] = [
		{ id: 'a', at: 1 },
		{ id: 'b', at: 2 },
		{ id: 'c', at: 3 }
	];

	it('returns no next cursor when the rows fit the limit', () => {
		expect(toPage(rows.slice(0, 2), 2, cursorOf)).toEqual({
			items: rows.slice(0, 2),
			nextCursor: null
		});
	});

	it('returns no next cursor for an empty result', () => {
		expect(toPage([], 2, cursorOf)).toEqual({ items: [], nextCursor: null });
	});

	it('trims the extra row and points the cursor at the last item kept', () => {
		const page = toPage(rows, 2, cursorOf);
		expect(page.items).toEqual(rows.slice(0, 2));
		expect(page.nextCursor).not.toBeNull();
		expect(decodeCursor(page.nextCursor as string, cursorSchema)).toEqual({ id: 'b', at: 2 });
	});
});
