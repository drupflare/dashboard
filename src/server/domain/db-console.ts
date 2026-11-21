import type { CheckOptions } from './sql-allow';

export const MASK = '[masked]';

// a column name that is secret wherever it appears; the console refuses a statement that names one
// and masks a result column that carries one (a star select brings them in under their own name)
export const MASKED_COLUMNS: ReadonlySet<string> = new Set([
	'key_hash',
	'token_hash',
	'claim_token_hash',
	'request_hash',
	'session_id',
	'ciphertext',
	'current_envelope',
	'previous_envelope',
	'credential_envelope',
	'key_envelope',
	'client_secret_envelope',
	'code_hash',
	'owner_token',
	'secret'
]);

// tables whose rows are secret throughout: one-time values, stored responses and sealed material
export const DENIED_TABLES: ReadonlySet<string> = new Set([
	'single_use',
	'code_attempts',
	'owner_tokens',
	'pending_secrets',
	'import_credentials',
	'idempotency_keys'
]);

// columns whose names look sensitive and were read and judged clear, as `table.column`
export const REVIEWED_CLEAR: ReadonlySet<string> = new Set([
	'platform_flags.key',
	'schema_meta.key',
	'nodes.last_envelope_seq',
	'api_key_lookup.key_id',
	'assessments.idempotency_key',
	'audit_log.hash',
	'audit_log.prev_hash',
	'budget_alerts_sent.alert_key',
	'budget_alerts_sent.scope_key',
	'cost_centers.code',
	'custom_releases.bundle_key',
	'nodes.public_key',
	'operations.idempotency_key',
	'operations.plan_digest',
	'passkeys.public_key',
	'plane_connections.token_id',
	'plane_connections.token_kind',
	'policy_assignments.assigned_at',
	'policy_assignments.assigned_by',
	'procurement_records.signatory',
	'releases.manifest_digest',
	'service_account_keys.key_id',
	'site_config_changes.key',
	'site_discovery.etag',
	'site_revisions.bundle_key',
	'template_bundles.bundle_key',
	'trust_documents.object_key',
	'pending_secrets.key_version',
	'import_credentials.host_key_fingerprint',
	'import_credentials.host_key_type',
	'import_credentials.public_key'
]);

// what makes a column name worth a look when a table is added
export const SENSITIVE_NAME =
	/(hash|secret|token|key|session|code|digest|cipher|nonce|salt|sig|password|credential|private|dek|kek|seed|verifier|challenge|envelope|jwk|wrapped)/i;

export const CHECK_OPTIONS: CheckOptions = {
	deniedTables: DENIED_TABLES,
	maskedColumns: MASKED_COLUMNS
};

export function isClassified(table: string, column: string): boolean {
	return (
		MASKED_COLUMNS.has(column.toLowerCase()) ||
		DENIED_TABLES.has(table.toLowerCase()) ||
		REVIEWED_CLEAR.has(`${table}.${column}`.toLowerCase())
	);
}

export function maskRow(row: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(row).map(([name, value]) => [
			name,
			MASKED_COLUMNS.has(name.toLowerCase()) ? MASK : value
		])
	);
}
