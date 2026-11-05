import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const SCHEMA_VERSION = 1;

export const ORGANIZATION_ROLES = ['owner', 'admin', 'developer', 'billing', 'viewer'] as const;
export const SITE_GRANT_ROLES = ['site-admin', 'maintainer', 'viewer'] as const;
export const DELEGATION_ROLES = ['maintainer', 'viewer'] as const;
export const DELEGATION_STATES = ['pending', 'active', 'revoked'] as const;
export const INVITE_STATES = ['pending', 'accepted', 'revoked'] as const;
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

export const schemaMeta = sqliteTable('schema_meta', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	email: text('email').notNull().unique(),
	displayName: text('display_name'),
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
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
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
	idempotencyKeys,
	auditLog
] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

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
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
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
	`CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,
	`CREATE INDEX IF NOT EXISTS members_org ON members (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS invites_org ON invites (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS api_keys_org ON api_keys (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash)`,
	`CREATE INDEX IF NOT EXISTS delegations_org ON delegations (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS site_grants_org ON site_grants (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_grants_active ON site_grants (site_id, user_id)
	WHERE revoked_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS sites_org ON sites (organization_id, id)`
];

// collegedb splits schema text on ';', so trigger bodies run one at a time
export const SCHEMA_TRIGGERS: string[] = [
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`
];
