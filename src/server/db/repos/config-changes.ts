import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	CONFIG_CHANGE_COLUMNS,
	toConfigChange,
	type ConfigChangeRow
} from '../../../../engine/src/config-rows';
import type { ConfigChangeRecord } from '../../../../engine/src/ports';

export type { ConfigChangeRecord };

// changes shard by organisation, as operations do, so the engine's write and these reads agree
export async function getConfigChange(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string
): Promise<ConfigChangeRecord | null> {
	const row = await db.first<ConfigChangeRow>(
		organizationId,
		`SELECT ${CONFIG_CHANGE_COLUMNS} FROM site_config_changes
		 WHERE organization_id = ? AND site_id = ? AND id = ?`,
		[organizationId, siteId, id]
	);
	return row ? toConfigChange(row) : null;
}

// newest first; the cursor is the (created_at, id) of the last row of the previous page
export async function listConfigChanges(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	options: { after?: { createdAt: number; id: string }; count: number; keys?: readonly string[] }
): Promise<ConfigChangeRecord[]> {
	const after = options.after;
	if (options.keys !== undefined && options.keys.length === 0) return [];
	const only = options.keys ? `AND key IN (${options.keys.map(() => '?').join(', ')})` : '';
	const keyset = after ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
	const cursor = after ? [after.createdAt, after.createdAt, after.id] : [];
	const { results } = await db.all<ConfigChangeRow>(
		organizationId,
		`SELECT ${CONFIG_CHANGE_COLUMNS} FROM site_config_changes
		 WHERE organization_id = ? AND site_id = ? ${only} ${keyset}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, ...(options.keys ?? []), ...cursor, options.count]
	);
	return results.map(toConfigChange);
}

// every key one apply touched, which a revert undoes together
export async function listOperationChanges(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	operationId: string
): Promise<ConfigChangeRecord[]> {
	const { results } = await db.all<ConfigChangeRow>(
		organizationId,
		`SELECT ${CONFIG_CHANGE_COLUMNS} FROM site_config_changes
		 WHERE organization_id = ? AND site_id = ? AND operation_id = ? ORDER BY key`,
		[organizationId, siteId, operationId]
	);
	return results.map(toConfigChange);
}
