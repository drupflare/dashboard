import type { CollegeDBClient } from '@earth-app/collegedb';
import { OWNER_TOKEN_SQL } from '../../../shared/custody/records';

export interface OwnerTokenRow {
	version: number;
	current: string;
	previous: string | null;
}

interface Row {
	version: number;
	current_envelope: string;
	previous_envelope: string | null;
}

export async function getOwnerToken(
	db: CollegeDBClient,
	siteId: string
): Promise<OwnerTokenRow | null> {
	const row = await db.first<Row>(siteId, OWNER_TOKEN_SQL.select, [siteId]);
	if (!row) return null;
	return { version: row.version, current: row.current_envelope, previous: row.previous_envelope };
}

// the write names the version it read; null means another writer changed the row first
export async function putOwnerToken(
	db: CollegeDBClient,
	siteId: string,
	value: { current: string; previous: string | null },
	expected: number | null,
	now: number
): Promise<number | null> {
	const row =
		expected === null
			? await db.first<{ version: number }>(siteId, OWNER_TOKEN_SQL.insert, [
					siteId,
					value.current,
					value.previous,
					now
				])
			: await db.first<{ version: number }>(siteId, OWNER_TOKEN_SQL.update, [
					value.current,
					value.previous,
					now,
					siteId,
					expected
				]);
	return row?.version ?? null;
}
