import type { CollegeDBClient } from '@earth-app/collegedb';
import { IMPORT_RUN_SQL, type ImportRun } from '../../../shared/import-hours';

export async function listImportRunsSince(
	db: CollegeDBClient,
	organizationId: string,
	since: number
): Promise<ImportRun[]> {
	const { results } = await db.all<{ started_at: number; wall_ms: number | null }>(
		organizationId,
		IMPORT_RUN_SQL.since,
		[organizationId, since]
	);
	return results.map((row) => ({ startedAt: row.started_at, wallMs: row.wall_ms }));
}
