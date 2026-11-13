import type { CollegeDBClient } from '@earth-app/collegedb';
import { defineTask } from 'nitropack/runtime';
import {
	expiredImportCredentials,
	IMPORT_CREDENTIAL_SQL
} from '../../shared/custody/import-credentials';
import { ensureCollegeDB, wasChanged, type CollegeDBEnv } from '../db/collegedb';
import { withAtomicBatch } from '../db/repos/atomic-shards';

interface ExpiryRow {
	id: string;
	organization_id: string;
	expires_at: number;
}

export class PurgeFailedError extends Error {
	readonly code = 'PURGE_FAILED';

	constructor() {
		super('the import credential purge failed on a shard');
		this.name = 'PurgeFailedError';
	}
}

// a key past its 24 hours goes whether or not an import used it
export async function purgeImportCredentials(db: CollegeDBClient, now: number): Promise<number> {
	const shards = await db.allAllShards<ExpiryRow>(IMPORT_CREDENTIAL_SQL.expired, [now]);
	let removed = 0;
	for (const shard of shards) {
		if (!shard.success) throw new PurgeFailedError();
		const due = expiredImportCredentials(
			shard.results.map((row) => ({
				id: row.id,
				organizationId: row.organization_id,
				expiresAt: row.expires_at
			})),
			now
		);
		for (const row of due) {
			const result = await db.run(row.organizationId, IMPORT_CREDENTIAL_SQL.purge, [
				row.id,
				now
			]);
			if (wasChanged(result)) removed++;
		}
	}
	return removed;
}

export default defineTask({
	meta: {
		name: 'import-credentials-purge',
		description: 'Deletes import keys past their expiry, used or not'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: CollegeDBEnv } }).cloudflare?.env;
		if (!env?.KV) return { result: { skipped: 'the task carries no cloudflare env' } };
		const db = await ensureCollegeDB(withAtomicBatch(env));
		return { result: { removed: await purgeImportCredentials(db, Date.now()) } };
	}
});
