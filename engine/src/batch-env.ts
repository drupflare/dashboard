import { fromBase64Url, signingKeyFromSeed } from '@contracts/common';
import { BATCH_WINDOW_MS, batchSecretsOf } from '@contracts/engine-batch';
import { budgetAuthorityOf, type SiteAuthStub } from './adapters/authority';
import { usageCountsOf } from './adapters/counts';
import type { BatchDeps, ReplayStore } from './batch';
import type { EngineEnv } from './env';

// the control key is read from its seed here and handed to the adapter that signs; it is never
// part of a response
export async function buildBatchDeps(env: EngineEnv, now: number = Date.now()): Promise<BatchDeps> {
	const { privateKey } = await signingKeyFromSeed(fromBase64Url(env.CONTROL_SEED));
	return {
		...batchSecretsOf({
			budget: env.BUDGET_SECRET,
			counts: env.COUNTS_SECRET,
			start: env.START_SECRET
		}),
		now,
		replays: new D1ReplayStore(env.DB),
		authority: budgetAuthorityOf({
			siteAuth: (siteId) =>
				env.SITE_AUTH.get(env.SITE_AUTH.idFromName(siteId)) as unknown as SiteAuthStub,
			controlKey: privateKey,
			now: Date.now
		}),
		counts: usageCountsOf(env.USAGE_COUNTER)
	};
}

// an atomic insert settles a race between two copies of one request; rows older than twice the
// window cannot match a request the window still accepts, so they are pruned on the way
export class D1ReplayStore implements ReplayStore {
	constructor(private readonly db: D1Database) {}

	async claim(id: string, now: number): Promise<boolean> {
		await this.db
			.prepare('DELETE FROM engine_replays WHERE seen_at < ?')
			.bind(now - 2 * BATCH_WINDOW_MS)
			.run();
		const result = await this.db
			.prepare(
				'INSERT INTO engine_replays (id, seen_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING'
			)
			.bind(id, now)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}
}
