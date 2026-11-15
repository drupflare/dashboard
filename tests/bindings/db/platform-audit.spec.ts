import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	applySchema,
	createCollegeDB,
	DIRECTORY_KEY,
	ensureCollegeDB
} from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	appendPlatformAudit,
	listPlatformAudit
} from '../../../src/server/db/repos/platform-audit';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: ReturnType<typeof createCollegeDB>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const NOW = 1_790_000_000_000;

describe('platform audit', () => {
	it('lists rows newest first with the detail decoded', async () => {
		await appendPlatformAudit(db, {
			actor: 'user:usr_a',
			action: 'admin.ladder.switch',
			target: 'global',
			detail: { scope: 'global', auto: false },
			now: NOW
		});
		await appendPlatformAudit(db, {
			actor: 'user:usr_a',
			action: 'admin.ladder.switch',
			target: 'global',
			detail: { scope: 'global', auto: true },
			now: NOW + 1
		});

		const rows = await listPlatformAudit(db, 10);

		expect(rows.slice(0, 2).map((row) => row.detail)).toEqual([
			{ scope: 'global', auto: true },
			{ scope: 'global', auto: false }
		]);
	});

	it('pages by id', async () => {
		const [newest] = await listPlatformAudit(db, 1);
		const older = await listPlatformAudit(db, 10, newest!.id);

		expect(older.every((row) => row.id < newest!.id)).toBe(true);
	});

	it('refuses to change or delete a row', async () => {
		await expect(
			db.run(DIRECTORY_KEY, `UPDATE platform_audit SET actor = 'x'`, [])
		).rejects.toThrow(/append-only/);
		await expect(db.run(DIRECTORY_KEY, `DELETE FROM platform_audit`, [])).rejects.toThrow(
			/append-only/
		);
	});
});
