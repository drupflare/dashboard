import type { D1Database } from '@cloudflare/workers-types';
import { CONFIG_CHANGE_COLUMNS, toConfigChange, type ConfigChangeRow } from '../config-rows';
import type { ConfigChangeRecord, ConfigLedger } from '../ports';

export class D1ConfigLedger implements ConfigLedger {
	constructor(private readonly db: D1Database) {}

	async forOperation(organizationId: string, operationId: string): Promise<ConfigChangeRecord[]> {
		const { results } = await this.db
			.prepare(
				`SELECT ${CONFIG_CHANGE_COLUMNS} FROM site_config_changes
				WHERE organization_id = ? AND operation_id = ? ORDER BY key`
			)
			.bind(organizationId, operationId)
			.all<ConfigChangeRow>();
		return results.map(toConfigChange);
	}

	async begin(rows: readonly ConfigChangeRecord[]): Promise<void> {
		if (rows.length === 0) return;
		const insert = this.db.prepare(
			`INSERT OR IGNORE INTO site_config_changes (${CONFIG_CHANGE_COLUMNS})
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		await this.db.batch(
			rows.map((row) =>
				insert.bind(
					row.id,
					row.organizationId,
					row.siteId,
					row.operationId,
					row.key,
					row.before,
					row.after,
					row.actor,
					row.status,
					row.createdAt,
					row.revertedBy
				)
			)
		);
	}

	// a row that already settled keeps its status, so a replay never moves an applied change back
	async settle(
		organizationId: string,
		operationId: string,
		status: ConfigChangeRecord['status']
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE site_config_changes SET status = ?
				WHERE organization_id = ? AND operation_id = ? AND status = 'pending'`
			)
			.bind(status, organizationId, operationId)
			.run();
	}

	async markReverted(
		organizationId: string,
		ids: readonly string[],
		operationId: string
	): Promise<void> {
		if (ids.length === 0) return;
		const mark = this.db.prepare(
			`UPDATE site_config_changes SET reverted_by = ?
			WHERE organization_id = ? AND id = ? AND reverted_by IS NULL`
		);
		await this.db.batch(ids.map((id) => mark.bind(operationId, organizationId, id)));
	}
}
