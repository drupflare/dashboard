import { defineTask } from 'nitropack/runtime';
import { ApiError } from '../../shared/errors';
import { ensureCollegeDB, type CollegeDBEnv } from '../db/collegedb';
import { withAtomicBatch } from '../db/repos/atomic-shards';
import { productionLadderDeps, tickLadder } from '../services/ladder-tick';
import { siteServices } from '../services/sites';
import { notInstalled } from '../utils/task-skip';

export default defineTask({
	meta: {
		name: 'ladder-tick',
		description: 'Starts the catalogued repairs a site needs when automatic repair is on'
	},
	async run({ context }): Promise<{ result?: unknown }> {
		const env = (context as { cloudflare?: { env?: CollegeDBEnv } }).cloudflare?.env;
		if (!env?.KV) return { result: { skipped: 'the task carries no cloudflare env' } };
		const db = await ensureCollegeDB(withAtomicBatch(env));
		try {
			return { result: await tickLadder(productionLadderDeps(db, siteServices())) };
		} catch (error) {
			if (error instanceof ApiError && error.code === 'not_built') {
				return notInstalled('ladder-tick');
			}
			throw error;
		}
	}
});
