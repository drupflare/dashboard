import type { ConfigChangeRecord, ConfigChangeStatus } from './ports';

export interface ConfigChangeRow {
	id: string;
	organization_id: string;
	site_id: string;
	operation_id: string;
	key: string;
	before: string;
	after: string;
	actor: string;
	status: ConfigChangeStatus;
	created_at: number;
	reverted_by: string | null;
}

export const CONFIG_CHANGE_COLUMNS = `id, organization_id, site_id, operation_id, key, before, after,
	actor, status, created_at, reverted_by`;

export const toConfigChange = (row: ConfigChangeRow): ConfigChangeRecord => ({
	id: row.id,
	organizationId: row.organization_id,
	siteId: row.site_id,
	operationId: row.operation_id,
	key: row.key,
	before: row.before,
	after: row.after,
	actor: row.actor,
	status: row.status,
	createdAt: row.created_at,
	revertedBy: row.reverted_by
});

// one row per key per operation, so a replay writes the same id
export const configChangeId = (operationId: string, key: string) => `cfg_${operationId}_${key}`;

// the effective value before a change, and whether it was an override or the deployed value
export interface ConfigBefore {
	value: unknown;
	source: 'kv' | 'var' | 'default';
}

// reverting restores an override only when one was in force; otherwise it clears the key
export function revertValue(beforeText: string): unknown {
	const before = JSON.parse(beforeText) as ConfigBefore;
	return before.source === 'kv' ? before.value : null;
}
