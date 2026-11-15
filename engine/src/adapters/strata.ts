import type { D1Database } from '@cloudflare/workers-types';
import type { StrataStore } from '../ports';

export class D1StrataStore implements StrataStore {
	constructor(private readonly db: D1Database) {}

	async markApplied(
		organizationId: string,
		siteId: string,
		allocation: 'light' | 'detailed',
		now: number
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE site_strata SET applied_at = ?
				 WHERE site_id = ? AND organization_id = ? AND allocation = ?`
			)
			.bind(now, siteId, organizationId, allocation)
			.run();
	}

	async markStore(
		organizationId: string,
		siteId: string,
		store: { state: 'ready' } | { state: 'failed'; reason: string }
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE site_strata SET store = ?, store_reason = ?
				 WHERE site_id = ? AND organization_id = ?`
			)
			.bind(
				store.state,
				store.state === 'failed' ? store.reason : null,
				siteId,
				organizationId
			)
			.run();
	}
}
