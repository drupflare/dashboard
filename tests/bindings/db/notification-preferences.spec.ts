import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	listPreferences,
	setPreference
} from '../../../src/server/db/repos/notification-preferences';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

const user = () => `usr_${crypto.randomUUID()}`;

describe('notification preferences', () => {
	it('has no row for a user who never chose, so every category reads as off', async () => {
		expect(await listPreferences(db, user())).toEqual({});
	});

	it('stores a choice, replaces it on the same category, and keeps users apart', async () => {
		const a = user();
		const b = user();
		await setPreference(db, { userId: a, category: 'ops', enabled: true, at: 1 });
		await setPreference(db, { userId: a, category: 'billing-info', enabled: true, at: 2 });
		await setPreference(db, { userId: a, category: 'ops', enabled: false, at: 3 });
		expect(await listPreferences(db, a)).toEqual({ ops: false, 'billing-info': true });
		expect(await listPreferences(db, b)).toEqual({});
	});

	it('refuses a category outside the optional set at the table', async () => {
		await expect(
			db.run(
				'directory',
				`INSERT INTO notification_preferences (user_id, category, enabled, updated_at)
				 VALUES ('x', 'budget-limit', 0, 1)`,
				[]
			)
		).rejects.toThrow();
	});
});
