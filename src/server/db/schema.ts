import { PAIRING_STATES } from '@contracts/fleet-link';
import {
	OPERATION_STATUSES,
	OPERATION_TYPES,
	STEP_STATES,
	VERIFICATION_STATES
} from '@contracts/operations';
import { SITE_CATEGORIES, SITE_CONFIGS, SITE_KINDS } from '@contracts/sites';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { PENDING_SECRET_KINDS } from '../../shared/custody/records';
import { BILLING_SCHEMA_STATEMENTS, BILLING_TABLES } from './billing-schema';

export const SCHEMA_VERSION = 1;

export const ORGANIZATION_ROLES = ['owner', 'admin', 'developer', 'billing', 'viewer'] as const;
export const SITE_GRANT_ROLES = ['site-admin', 'maintainer', 'viewer'] as const;
export const DELEGATION_ROLES = ['maintainer', 'viewer'] as const;
export const DELEGATION_STATES = ['pending', 'active', 'revoked'] as const;
export const INVITE_STATES = ['pending', 'accepted', 'revoked'] as const;
export const SITE_RESOURCE_KINDS = ['kv', 'r2', 'd1'] as const;
export const SITE_LEDGER_KINDS = [...SITE_RESOURCE_KINDS, 'script', 'route'] as const;
export const OPEN_OPERATION_STATUSES = [
	'planned',
	'awaiting-approval',
	'running',
	'verifying'
] as const;
export const SITE_PLANES = ['managed', 'self-managed', 'self-hosted'] as const;
export const SITE_STATES = [
	'active',
	'suspended',
	'tombstoned',
	'purge-eligible',
	'deleted'
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export type SiteGrantRole = (typeof SITE_GRANT_ROLES)[number];
export type DelegationRole = (typeof DELEGATION_ROLES)[number];
export type DelegationState = (typeof DELEGATION_STATES)[number];
export type InviteState = (typeof INVITE_STATES)[number];

export class SchemaVersionError extends Error {
	readonly code = 'SCHEMA_VERSION';

	constructor(readonly stored: string) {
		super(`schema version ${stored} is not readable by this code (knows ${SCHEMA_VERSION})`);
		this.name = 'SchemaVersionError';
	}
}

export function checkSchemaVersion(stored: string | null): void {
	if (stored === null) return;
	if (!/^\d+$/.test(stored) || Number(stored) > SCHEMA_VERSION) {
		throw new SchemaVersionError(stored);
	}
}

// after the schema has run, the row must exist and match; a missing or newer one means do not serve
export function requireSchemaVersion(stored: string | null): void {
	if (stored !== String(SCHEMA_VERSION)) throw new SchemaVersionError(stored ?? 'missing');
}

export const schemaMeta = sqliteTable('schema_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	email: text('email').notNull().unique(),
	displayName: text('display_name'),
	platformRole: text('platform_role'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const identities = sqliteTable('identities', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	provider: text('provider').notNull(),
	providerSubject: text('provider_subject').notNull(),
	email: text('email'),
	verified: integer('verified').notNull().default(0),
	createdAt: integer('created_at').notNull()
});

export const organizations = sqliteTable('organizations', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	personal: integer('personal').notNull().default(0),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const members = sqliteTable('members', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	userId: text('user_id').notNull(),
	role: text('role').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const invites = sqliteTable('invites', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	email: text('email').notNull(),
	role: text('role').notNull(),
	tokenHash: text('token_hash').notNull(),
	state: text('state').notNull(),
	invitedBy: text('invited_by').notNull(),
	expiresAt: integer('expires_at').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const apiKeys = sqliteTable('api_keys', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	name: text('name').notNull(),
	keyHash: text('key_hash').notNull(),
	scopes: text('scopes').notNull(),
	createdBy: text('created_by').notNull(),
	expiresAt: integer('expires_at'),
	revokedAt: integer('revoked_at'),
	createdAt: integer('created_at').notNull()
});

export const delegations = sqliteTable('delegations', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	agencyOrganizationId: text('agency_organization_id').notNull(),
	role: text('role').notNull(),
	siteId: text('site_id'),
	state: text('state').notNull(),
	expiresAt: integer('expires_at'),
	createdBy: text('created_by').notNull(),
	acceptedBy: text('accepted_by'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	revokedAt: integer('revoked_at')
});

export const siteGrants = sqliteTable('site_grants', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	userId: text('user_id').notNull(),
	role: text('role').notNull(),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull(),
	revokedAt: integer('revoked_at')
});

export const sites = sqliteTable('sites', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	name: text('name').notNull(),
	plane: text('plane').notNull(),
	state: text('state').notNull(),
	accountId: text('account_id'),
	category: text('category').notNull().default('cms'),
	config: text('config').notNull().default('canonical'),
	kind: text('kind').notNull().default('drupal'),
	primaryHostname: text('primary_hostname'),
	releaseId: text('release_id'),
	adminName: text('admin_name'),
	adminMail: text('admin_mail'),
	adoptedFrom: text('adopted_from'),
	adoptedTo: text('adopted_to'),
	importedFrom: text('imported_from'),
	nodeId: text('node_id'),
	readyAt: integer('ready_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const operations = sqliteTable('operations', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	accountId: text('account_id'),
	siteId: text('site_id'),
	type: text('type').notNull(),
	status: text('status').notNull(),
	idempotencyKey: text('idempotency_key').notNull(),
	targetIds: text('target_ids').notNull(),
	preconditions: text('preconditions').notNull(),
	planDigest: text('plan_digest').notNull(),
	fencingEpoch: integer('fencing_epoch').notNull(),
	blastRadius: text('blast_radius').notNull(),
	rollbackPoint: text('rollback_point'),
	cursor: text('cursor'),
	verification: text('verification').notNull(),
	finalObservation: text('final_observation'),
	budget: text('budget').notNull(),
	retryOf: text('retry_of'),
	inputs: text('inputs'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	version: integer('version').notNull().default(0)
});

export const operationSteps = sqliteTable('operation_steps', {
	operationId: text('operation_id').notNull(),
	id: text('id').notNull(),
	position: integer('position').notNull(),
	name: text('name').notNull(),
	state: text('state').notNull(),
	attempt: integer('attempt').notNull().default(0),
	startedAt: integer('started_at'),
	finishedAt: integer('finished_at'),
	error: text('error')
});

export const siteResources = sqliteTable('site_resources', {
	id: text('id').primaryKey(),
	siteId: text('site_id').notNull(),
	accountId: text('account_id').notNull(),
	kind: text('kind').notNull(),
	binding: text('binding').notNull(),
	name: text('name').notNull(),
	providerId: text('provider_id'),
	createdByOperation: text('created_by_operation').notNull(),
	createdAt: integer('created_at').notNull(),
	missingAt: integer('missing_at'),
	deletedAt: integer('deleted_at'),
	fingerprint: text('fingerprint')
});

export const siteDiscovery = sqliteTable('site_discovery', {
	siteId: text('site_id').primaryKey(),
	document: text('document').notNull(),
	etag: text('etag'),
	fetchedAt: integer('fetched_at').notNull()
});

export const idempotencyKeys = sqliteTable('idempotency_keys', {
	organizationId: text('organization_id').notNull(),
	idempotencyKey: text('idempotency_key').notNull(),
	route: text('route').notNull(),
	requestHash: text('request_hash').notNull(),
	responseStatus: integer('response_status'),
	responseBody: text('response_body'),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull()
});

export const auditLog = sqliteTable('audit_log', {
	organizationId: text('organization_id').notNull(),
	seq: integer('seq').notNull(),
	prevHash: text('prev_hash').notNull(),
	hash: text('hash').notNull(),
	actor: text('actor').notNull(),
	action: text('action').notNull(),
	target: text('target').notNull(),
	detail: text('detail').notNull(),
	createdAt: integer('created_at').notNull()
});

export const codeAttempts = sqliteTable('code_attempts', {
	key: text('key').primaryKey(),
	attempts: integer('attempts').notNull(),
	windowStart: integer('window_start').notNull()
});

export const ownerTokens = sqliteTable('owner_tokens', {
	siteId: text('site_id').primaryKey(),
	version: integer('version').notNull(),
	currentEnvelope: text('current_envelope').notNull(),
	previousEnvelope: text('previous_envelope'),
	updatedAt: integer('updated_at').notNull()
});

export const pendingSecrets = sqliteTable('pending_secrets', {
	siteId: text('site_id').notNull(),
	kind: text('kind', { enum: PENDING_SECRET_KINDS }).notNull(),
	ciphertext: text('ciphertext').notNull(),
	keyVersion: integer('key_version').notNull(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	revealedAt: integer('revealed_at')
});

export const backups = sqliteTable('backups', {
	id: text('id').primaryKey(),
	siteId: text('site_id').notNull(),
	organizationId: text('organization_id').notNull(),
	operationId: text('operation_id').notNull(),
	bytes: integer('bytes').notNull(),
	sha256: text('sha256').notNull(),
	parts: integer('parts').notNull(),
	restorable: integer('restorable').notNull(),
	verified: integer('verified').notNull().default(0),
	label: text('label'),
	createdAt: integer('created_at').notNull(),
	deletedAt: integer('deleted_at')
});

export const passkeys = sqliteTable('passkeys', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	publicKey: text('public_key').notNull(),
	counter: integer('counter').notNull(),
	transports: text('transports').notNull(),
	deviceType: text('device_type').notNull(),
	backedUp: integer('backed_up').notNull(),
	name: text('name').notNull(),
	createdAt: integer('created_at').notNull(),
	lastUsedAt: integer('last_used_at')
});

export const singleUse = sqliteTable('single_use', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at').notNull()
});

export const pairings = sqliteTable('pairings', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	claimTokenHash: text('claim_token_hash').notNull().unique(),
	state: text('state', { enum: PAIRING_STATES }).notNull(),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	claimedNodeId: text('claimed_node_id')
});

export const nodes = sqliteTable('nodes', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	publicKey: text('public_key').notNull(),
	hostFacts: text('host_facts').notNull(),
	state: text('state', { enum: ['active', 'revoked'] }).notNull(),
	pairedAt: integer('paired_at').notNull(),
	lastSeenAt: integer('last_seen_at'),
	lastAuditHead: text('last_audit_head'),
	lastEnvelopeSeq: integer('last_envelope_seq').notNull().default(-1),
	revokedAt: integer('revoked_at')
});

export const apiKeyLookup = sqliteTable('api_key_lookup', {
	lookupId: text('lookup_id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	keyId: text('key_id').notNull()
});

export const TABLES = [
	schemaMeta,
	users,
	identities,
	organizations,
	members,
	invites,
	apiKeys,
	delegations,
	siteGrants,
	sites,
	operations,
	operationSteps,
	siteResources,
	siteDiscovery,
	idempotencyKeys,
	auditLog,
	codeAttempts,
	ownerTokens,
	pendingSecrets,
	backups,
	passkeys,
	singleUse,
	apiKeyLookup,
	pairings,
	nodes,
	...BILLING_TABLES
] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

const SITE_CATEGORY_COLUMN = `category TEXT NOT NULL DEFAULT 'cms' CHECK (category IN (${quoted(SITE_CATEGORIES)}))`;
const SITE_CONFIG_COLUMN = `config TEXT NOT NULL DEFAULT 'canonical' CHECK (config IN (${quoted(SITE_CONFIGS)}))`;
const SITE_KIND_COLUMN = `kind TEXT NOT NULL DEFAULT 'drupal' CHECK (kind IN (${quoted(SITE_KINDS)}))`;

export const SCHEMA_META_STATEMENT = `CREATE TABLE IF NOT EXISTS schema_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
)`;

export const SCHEMA_STATEMENTS: string[] = [
	SCHEMA_META_STATEMENT,
	`CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	display_name TEXT,
	platform_role TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS identities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	provider TEXT NOT NULL,
	provider_subject TEXT NOT NULL,
	email TEXT,
	verified INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	UNIQUE (provider, provider_subject)
)`,
	`CREATE TABLE IF NOT EXISTS organizations (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	personal INTEGER NOT NULL DEFAULT 0,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS members (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(ORGANIZATION_ROLES)})),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (organization_id, user_id)
)`,
	`CREATE TABLE IF NOT EXISTS invites (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	email TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(ORGANIZATION_ROLES)})),
	token_hash TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quoted(INVITE_STATES)})),
	invited_by TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	name TEXT NOT NULL,
	key_hash TEXT NOT NULL,
	scopes TEXT NOT NULL,
	created_by TEXT NOT NULL,
	expires_at INTEGER,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS delegations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	agency_organization_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(DELEGATION_ROLES)})),
	site_id TEXT,
	state TEXT NOT NULL CHECK (state IN (${quoted(DELEGATION_STATES)})),
	expires_at INTEGER,
	created_by TEXT NOT NULL,
	accepted_by TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	revoked_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS site_grants (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(SITE_GRANT_ROLES)})),
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS sites (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	name TEXT NOT NULL,
	plane TEXT NOT NULL CHECK (plane IN (${quoted(SITE_PLANES)})),
	state TEXT NOT NULL CHECK (state IN (${quoted(SITE_STATES)})),
	account_id TEXT,
	${SITE_CATEGORY_COLUMN},
	${SITE_CONFIG_COLUMN},
	${SITE_KIND_COLUMN},
	primary_hostname TEXT,
	release_id TEXT,
	admin_name TEXT,
	admin_mail TEXT,
	adopted_from TEXT,
	adopted_to TEXT,
	imported_from TEXT,
	node_id TEXT,
	ready_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS operations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	account_id TEXT,
	site_id TEXT,
	type TEXT NOT NULL CHECK (type IN (${quoted(OPERATION_TYPES)})),
	status TEXT NOT NULL CHECK (status IN (${quoted(OPERATION_STATUSES)})),
	idempotency_key TEXT NOT NULL,
	target_ids TEXT NOT NULL,
	preconditions TEXT NOT NULL,
	plan_digest TEXT NOT NULL,
	fencing_epoch INTEGER NOT NULL,
	blast_radius TEXT NOT NULL,
	rollback_point TEXT,
	cursor TEXT,
	verification TEXT NOT NULL CHECK (verification IN (${quoted(VERIFICATION_STATES)})),
	final_observation TEXT,
	budget TEXT NOT NULL,
	retry_of TEXT,
	inputs TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	version INTEGER NOT NULL DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS operation_steps (
	operation_id TEXT NOT NULL,
	id TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quoted(STEP_STATES)})),
	attempt INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER,
	finished_at INTEGER,
	error TEXT,
	PRIMARY KEY (operation_id, id)
)`,
	`CREATE TABLE IF NOT EXISTS site_resources (
	id TEXT PRIMARY KEY,
	site_id TEXT NOT NULL,
	account_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN (${quoted(SITE_LEDGER_KINDS)})),
	binding TEXT NOT NULL,
	name TEXT NOT NULL,
	provider_id TEXT,
	created_by_operation TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	missing_at INTEGER,
	deleted_at INTEGER,
	fingerprint TEXT
)`,
	`CREATE TABLE IF NOT EXISTS site_discovery (
	site_id TEXT PRIMARY KEY,
	document TEXT NOT NULL,
	etag TEXT,
	fetched_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS idempotency_keys (
	organization_id TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	route TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	response_status INTEGER,
	response_body TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, idempotency_key)
)`,
	`CREATE TABLE IF NOT EXISTS audit_log (
	organization_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	prev_hash TEXT NOT NULL,
	hash TEXT NOT NULL,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target TEXT NOT NULL,
	detail TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, seq)
)`,
	`CREATE TABLE IF NOT EXISTS code_attempts (
	key TEXT PRIMARY KEY,
	attempts INTEGER NOT NULL,
	window_start INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS owner_tokens (
	site_id TEXT PRIMARY KEY,
	version INTEGER NOT NULL,
	current_envelope TEXT NOT NULL,
	previous_envelope TEXT,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS pending_secrets (
	site_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN (${quoted(PENDING_SECRET_KINDS)})),
	ciphertext TEXT NOT NULL,
	key_version INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revealed_at INTEGER,
	PRIMARY KEY (site_id, kind)
)`,
	`CREATE TABLE IF NOT EXISTS backups (
	id TEXT PRIMARY KEY,
	site_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	bytes INTEGER NOT NULL CHECK (bytes >= 0),
	sha256 TEXT NOT NULL,
	parts INTEGER NOT NULL CHECK (parts >= 0),
	restorable INTEGER NOT NULL CHECK (restorable IN (0, 1)),
	verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
	label TEXT,
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS passkeys (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	counter INTEGER NOT NULL,
	transports TEXT NOT NULL,
	device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
	backed_up INTEGER NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS single_use (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	expires_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS api_key_lookup (
	lookup_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	key_id TEXT NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS pairings (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	claim_token_hash TEXT NOT NULL UNIQUE,
	state TEXT NOT NULL CHECK (state IN (${quoted(PAIRING_STATES)})),
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	claimed_node_id TEXT
)`,
	`CREATE TABLE IF NOT EXISTS nodes (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	public_key TEXT NOT NULL,
	host_facts TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
	paired_at INTEGER NOT NULL,
	last_seen_at INTEGER,
	last_audit_head TEXT,
	last_envelope_seq INTEGER NOT NULL DEFAULT -1,
	revoked_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS nodes_org ON nodes (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS pairings_org ON pairings (organization_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id)`,
	`CREATE INDEX IF NOT EXISTS single_use_expiry ON single_use (expires_at)`,
	`CREATE INDEX IF NOT EXISTS pending_secrets_expiry ON pending_secrets (expires_at)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS backups_operation ON backups (operation_id)`,
	`CREATE INDEX IF NOT EXISTS backups_site ON backups (organization_id, site_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,
	`CREATE INDEX IF NOT EXISTS members_org ON members (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS invites_org ON invites (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS api_keys_org ON api_keys (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash)`,
	`CREATE INDEX IF NOT EXISTS delegations_org ON delegations (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS site_grants_org ON site_grants (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_grants_active ON site_grants (site_id, user_id)
	WHERE revoked_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS sites_org ON sites (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS operations_org ON operations (organization_id, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS operations_idempotency
	ON operations (organization_id, idempotency_key)`,
	`CREATE INDEX IF NOT EXISTS operations_site ON operations (site_id, created_at)
	WHERE site_id IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS operations_account ON operations (account_id, created_at)
	WHERE account_id IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS operations_open ON operations (status, updated_at)
	WHERE status IN (${quoted(OPEN_OPERATION_STATUSES)})`,
	`CREATE UNIQUE INDEX IF NOT EXISTS operations_retry_open ON operations (retry_of)
	WHERE retry_of IS NOT NULL AND status IN (${quoted(OPEN_OPERATION_STATUSES)})`,
	`CREATE UNIQUE INDEX IF NOT EXISTS operations_import_open ON operations (organization_id)
	WHERE type = 'site.import' AND status IN (${quoted(OPEN_OPERATION_STATUSES)})`,
	`CREATE INDEX IF NOT EXISTS operations_retry ON operations (organization_id, retry_of)
	WHERE retry_of IS NOT NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS operation_steps_order
	ON operation_steps (operation_id, position)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_resources_live ON site_resources (site_id, binding)
	WHERE deleted_at IS NULL`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_resources_provider
	ON site_resources (account_id, kind, provider_id)
	WHERE kind <> 'script'`,
	`CREATE INDEX IF NOT EXISTS site_resources_operation ON site_resources (created_by_operation)`,
	`CREATE INDEX IF NOT EXISTS site_resources_account ON site_resources (account_id, kind)
	WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS site_discovery_fetched ON site_discovery (fetched_at)`,
	`CREATE TABLE IF NOT EXISTS repo_connections (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket', 'gitea', 'forgejo')),
	external_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	credential_envelope TEXT,
	scopes TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
	created_at INTEGER NOT NULL,
	revoked_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS site_remotes (
	id TEXT PRIMARY KEY,
	site_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	connection_id TEXT NOT NULL,
	repo_full_name TEXT NOT NULL,
	branch TEXT NOT NULL,
	mount_path TEXT NOT NULL,
	interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 5),
	last_pull_status TEXT,
	last_pull_at INTEGER,
	created_at INTEGER NOT NULL,
	last_pull_reason TEXT,
	pull_pending INTEGER NOT NULL DEFAULT 0
)`,
	`CREATE TABLE IF NOT EXISTS repo_deliveries (
	provider TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	PRIMARY KEY (provider, delivery_id)
)`,
	`CREATE TABLE IF NOT EXISTS import_credentials (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	key_envelope TEXT NOT NULL,
	public_key TEXT NOT NULL,
	host TEXT NOT NULL,
	port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
	username TEXT NOT NULL,
	host_key_fingerprint TEXT,
	host_key_type TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS import_credentials_org ON import_credentials (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS import_credentials_expiry ON import_credentials (expires_at)`,
	`CREATE TABLE IF NOT EXISTS import_runs (
	operation_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	wall_ms INTEGER CHECK (wall_ms >= 0)
)`,
	`CREATE INDEX IF NOT EXISTS import_runs_org ON import_runs (organization_id, started_at)`,
	`CREATE INDEX IF NOT EXISTS repo_connections_org ON repo_connections (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS repo_connections_github_install ON repo_connections (external_id)
	WHERE provider = 'github' AND state = 'active'`,
	`CREATE INDEX IF NOT EXISTS site_remotes_site ON site_remotes (organization_id, site_id, id)`,
	`CREATE INDEX IF NOT EXISTS site_remotes_repo ON site_remotes (repo_full_name, branch)`,
	`CREATE TABLE IF NOT EXISTS custom_domains (
	hostname TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	epoch INTEGER NOT NULL CHECK (epoch >= 1),
	state TEXT NOT NULL CHECK (state IN ('claimed', 'routed', 'released')),
	provider_id TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS custom_domains_site ON custom_domains (organization_id, site_id, hostname)`,
	...BILLING_SCHEMA_STATEMENTS
];

// collegedb splits schema text on ';', so trigger bodies run one at a time
export const SCHEMA_TRIGGERS: string[] = [
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`
];
