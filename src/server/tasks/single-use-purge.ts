import type { CollegeDBClient } from '@earth-app/collegedb';
import { defineTask } from 'nitropack/runtime';
import { ensureCollegeDB, type CollegeDBEnv } from '../db/collegedb';
import { withAtomicBatch } from '../db/repos/atomic-shards';

export class SingleUsePurgeFailedError extends Error {
	readonly code = 'PURGE_FAILED';

	constructor() {
		super('the single-use purge failed on a shard');
		this.name = 'SingleUsePurgeFailedError';
	}
}

// each write sweeps its own shard, so this only reaches a shard nobody has written to lately
export async function purgeSingleUse(db: CollegeDBClient, now: number): Promise<number> {
	const shards = await db.runAllShards('DELETE FROM single_use WHERE expires_at <= ?', [now]);
	let removed = 0;
	for (const shard of shards) {
		if (!shard.success) throw new SingleUsePurgeFailedError();
		removed += shard.meta?.changes ?? 0;
	}
	return removed;
}

export default defineTask({
	meta: {
		name: 'single-use-purge',
		description: 'Deletes sign-in codes, challenges and link records past their expiry'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: CollegeDBEnv } }).cloudflare?.env;
		if (!env?.KV) return { result: { skipped: 'the task carries no cloudflare env' } };
		const db = await ensureCollegeDB(withAtomicBatch(env));
		return { result: { removed: await purgeSingleUse(db, Date.now()) } };
	}
});
