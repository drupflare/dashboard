import type { CollegeDBClient } from '@earth-app/collegedb';
import { DEFAULT_ON_CATEGORIES, type OptionalCategory } from '../../../shared/notifications';
import { DIRECTORY_KEY } from '../collegedb';

interface Row {
	category: OptionalCategory;
	enabled: number;
}

// a stored choice wins; a category with no row takes its default
export async function listPreferences(
	db: CollegeDBClient,
	userId: string
): Promise<Partial<Record<OptionalCategory, boolean>>> {
	const { results } = await db.all<Row>(
		DIRECTORY_KEY,
		'SELECT category, enabled FROM notification_preferences WHERE user_id = ?',
		[userId]
	);
	const out: Partial<Record<OptionalCategory, boolean>> = {};
	for (const category of DEFAULT_ON_CATEGORIES) out[category] = true;
	for (const row of results) out[row.category] = row.enabled === 1;
	return out;
}

export async function setPreference(
	db: CollegeDBClient,
	input: { userId: string; category: OptionalCategory; enabled: boolean; at: number }
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO notification_preferences (user_id, category, enabled, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT (user_id, category) DO UPDATE SET enabled = excluded.enabled,
		 updated_at = excluded.updated_at`,
		[input.userId, input.category, input.enabled ? 1 : 0, input.at]
	);
}
