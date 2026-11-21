import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

// ladder.auto is not here: it lives in ladder_switches so the ladder reads one place
export const PLATFORM_FLAG_KEYS = [
	'signups.paused',
	'notifications.paused',
	'promotion.stopped'
] as const;
export type PlatformFlagKey = (typeof PLATFORM_FLAG_KEYS)[number];

export interface PlatformFlagRow {
	key: PlatformFlagKey;
	value: boolean;
	setBy: string;
	setAt: number;
}

// a flag with no row is off
export async function listPlatformFlags(db: CollegeDBClient): Promise<PlatformFlagRow[]> {
	const { results } = await db.all<{
		key: PlatformFlagKey;
		value: string;
		set_by: string;
		set_at: number;
	}>(DIRECTORY_KEY, 'SELECT key, value, set_by, set_at FROM platform_flags', []);
	return results.map((row) => ({
		key: row.key,
		value: row.value === 'true',
		setBy: row.set_by,
		setAt: row.set_at
	}));
}

// a flag with no row reads as off, so a missing row never pauses anything
export async function isPlatformFlagOn(
	db: CollegeDBClient,
	key: PlatformFlagKey
): Promise<boolean> {
	const row = await db.first<{ value: string }>(
		DIRECTORY_KEY,
		'SELECT value FROM platform_flags WHERE key = ?',
		[key]
	);
	return row?.value === 'true';
}

export async function setPlatformFlag(
	db: CollegeDBClient,
	input: { key: PlatformFlagKey; value: boolean; setBy: string; now: number }
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO platform_flags (key, value, set_by, set_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value,
		 set_by = excluded.set_by, set_at = excluded.set_at`,
		[input.key, input.value ? 'true' : 'false', input.setBy, input.now]
	);
}
