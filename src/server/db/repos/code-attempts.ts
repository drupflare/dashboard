import type { CollegeDBClient } from '@earth-app/collegedb';

// one statement counts the guess and refuses it once the window's allowance is spent, so
// parallel callers cannot each read the same count
export async function claimAttempt(
	db: CollegeDBClient,
	key: string,
	now: number,
	rule: { limit: number; windowMs: number }
): Promise<number | null> {
	const cutoff = now - rule.windowMs;
	const row = await db.first<{ attempts: number }>(
		key,
		`INSERT INTO code_attempts (key, attempts, window_start) VALUES (?, 1, ?)
		 ON CONFLICT (key) DO UPDATE SET
		 attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
		 window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
		 WHERE window_start <= ? OR attempts < ?
		 RETURNING attempts`,
		[key, now, cutoff, cutoff, now, cutoff, rule.limit]
	);
	return row?.attempts ?? null;
}

export async function clearAttempts(db: CollegeDBClient, key: string): Promise<void> {
	await db.run(key, 'DELETE FROM code_attempts WHERE key = ?', [key]);
}
