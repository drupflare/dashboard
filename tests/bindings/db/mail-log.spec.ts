import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	countMailSentSince,
	mailCountsSince,
	recordMail,
	recordMailSent
} from '../../../src/server/db/repos/mail-log';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

describe('the send log', () => {
	it('counts sent rows at or after the given time', async () => {
		const base = Date.UTC(2026, 10, 21);
		const before = await countMailSentSince(db, base);
		await recordMailSent(db, { category: 'budget-limit', class: 'essential', at: base });
		await recordMailSent(db, { category: 'billing-info', class: 'optional', at: base + 1 });
		await recordMailSent(db, { category: 'billing-info', class: 'optional', at: base - 1 });
		expect(await countMailSentSince(db, base)).toBe(before + 2);
	});
});

describe('the send log by outcome', () => {
	it('counts each outcome since a time and keeps no address or body', async () => {
		const base = Date.UTC(2026, 10, 22);
		const before = await mailCountsSince(db, base);
		await recordMail(db, {
			category: 'ops',
			class: 'optional',
			status: 'skipped-paused',
			at: base
		});
		await recordMail(db, {
			category: 'ops',
			class: 'optional',
			status: 'failed',
			at: base + 1
		});
		await recordMail(db, {
			category: 'ops',
			class: 'optional',
			status: 'failed',
			at: base - 1
		});
		const after = await mailCountsSince(db, base);
		expect(after['skipped-paused']).toBe(before['skipped-paused'] + 1);
		expect(after.failed).toBe(before.failed + 1);
		const row = await db.first<Record<string, unknown>>(
			'mail-log',
			'SELECT * FROM mail_log LIMIT 1',
			[]
		);
		expect(Object.keys(row ?? {}).sort()).toEqual(['at', 'category', 'class', 'id', 'status']);
	});
});
