import type { CollegeDBClient } from '@earth-app/collegedb';

export async function putSingleUse(
	db: CollegeDBClient,
	key: string,
	value: string,
	expiresAt: number,
	now: number
): Promise<void> {
	await db.run(
		key,
		`INSERT INTO single_use (key, value, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
		[key, value, expiresAt]
	);
	// rows nobody takes again would pile up, so each write sweeps the expired ones on its shard
	await db.run(key, 'DELETE FROM single_use WHERE expires_at <= ?', [now]);
}

export async function getSingleUse(
	db: CollegeDBClient,
	key: string,
	now: number
): Promise<string | null> {
	const row = await db.first<{ value: string }>(
		key,
		'SELECT value FROM single_use WHERE key = ? AND expires_at > ?',
		[key, now]
	);
	return row?.value ?? null;
}

// one statement deletes the row and returns it, so of any number of parallel callers one gets the
// value; an expired row is deleted too and answers null
export async function takeSingleUse(
	db: CollegeDBClient,
	key: string,
	now: number
): Promise<string | null> {
	const row = await db.first<{ value: string; expires_at: number }>(
		key,
		'DELETE FROM single_use WHERE key = ? RETURNING value, expires_at',
		[key]
	);
	return row && row.expires_at > now ? row.value : null;
}

// deletes only when the stored value is the one offered, so a wrong guess leaves the row alone
export async function takeSingleUseIf(
	db: CollegeDBClient,
	key: string,
	value: string,
	now: number
): Promise<boolean> {
	const row = await db.first<{ key: string }>(
		key,
		'DELETE FROM single_use WHERE key = ? AND value = ? AND expires_at > ? RETURNING key',
		[key, value, now]
	);
	return row !== null;
}
