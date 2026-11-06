import type { CollegeDBClient } from '@earth-app/collegedb';
import { defineTask } from 'nitropack/runtime';
import { expiredPendingSecrets, type PendingSecretKind } from '../../shared/custody/records';
import { ensureCollegeDB, wasChanged, type CollegeDBEnv } from '../db/collegedb';
import { withAtomicBatch } from '../db/repos/atomic-shards';

interface ExpiryRow {
	site_id: string;
	kind: PendingSecretKind;
	expires_at: number;
}

export class PurgeFailedError extends Error {
	readonly code = 'PURGE_FAILED';

	constructor() {
		super('the pending secret purge failed on a shard');
		this.name = 'PurgeFailedError';
	}
}

// the select uses the expiry index; the pure function stays the rule for what may go
export async function purgePendingSecrets(db: CollegeDBClient, now: number): Promise<number> {
	const shards = await db.allAllShards<ExpiryRow>(
		'SELECT site_id, kind, expires_at FROM pending_secrets WHERE expires_at <= ?',
		[now]
	);
	let removed = 0;
	for (const shard of shards) {
		if (!shard.success) throw new PurgeFailedError();
		const due = expiredPendingSecrets(
			shard.results.map((row) => ({
				siteId: row.site_id,
				kind: row.kind,
				expiresAt: row.expires_at
			})),
			now
		);
		for (const row of due) {
			const result = await db.run(
				row.siteId,
				'DELETE FROM pending_secrets WHERE site_id = ? AND kind = ? AND expires_at <= ?',
				[row.siteId, row.kind, now]
			);
			if (wasChanged(result)) removed++;
		}
	}
	return removed;
}

export default defineTask({
	meta: {
		name: 'pending-secrets-purge',
		description: 'Deletes first-run secrets past their expiry, read or not'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: CollegeDBEnv } }).cloudflare?.env;
		if (!env?.KV) return { result: { skipped: 'the task carries no cloudflare env' } };
		const db = await ensureCollegeDB(withAtomicBatch(env));
		return { result: { removed: await purgePendingSecrets(db, Date.now()) } };
	}
});
