import { PAIRING_STATES } from '@contracts/fleet-link';
import {
	OPERATION_STATUSES,
	OPERATION_TYPES,
	STEP_STATES,
	VERIFICATION_STATES
} from '@contracts/operations';
import { RELEASE_KINDS } from '@contracts/releases';
import { SITE_CATEGORIES, SITE_CONFIGS, SITE_KINDS } from '@contracts/sites';
import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { PENDING_SECRET_KINDS } from '../../shared/custody/records';
import { DEPARTMENT_KINDS, DEPARTMENT_ROLES } from '../../shared/departments';
import { ENVIRONMENT_KINDS, ENVIRONMENT_STATUSES } from '../../shared/environments';
import { ESTATE_SCHEMA_STATEMENTS } from '../../shared/estate-sql';
import { OPTIONAL_CATEGORIES } from '../../shared/notifications';
import { ASSIGNMENT_KINDS, CLASSIFICATIONS } from '../../shared/policies';
import { SUPPORT_GRANT_SCOPES } from '../../shared/support';
import { TRANSFER_STATES, TRANSFER_STEPS } from '../domain/transfer';
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
	createdAt: integer('created_at').notNull(),
	lastUsedAt: integer('last_used_at')
});

export const delegations = sqliteTable('delegations', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	batchId: text('batch_id').notNull(),
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
	expiresAt: integer('expires_at'),
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
	boxFoundAs: text('box_found_as'),
	boxMissingSince: integer('box_missing_since'),
	readyAt: integer('ready_at'),
	dataSchemaVersion: integer('data_schema_version'),
	costCenterId: text('cost_center_id'),
	departmentId: text('department_id'),
	classification: text('classification', { enum: CLASSIFICATIONS }),
	technicalOwner: text('technical_owner'),
	businessOwner: text('business_owner'),
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

export const siteEnvironments = sqliteTable('site_environments', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	kind: text('kind', { enum: ENVIRONMENT_KINDS }).notNull(),
	name: text('name').notNull(),
	host: text('host').notNull(),
	status: text('status', { enum: ENVIRONMENT_STATUSES }).notNull(),
	envSiteId: text('env_site_id'),
	sourceBackupId: text('source_backup_id'),
	ttlAt: integer('ttl_at'),
	createdAt: integer('created_at').notNull(),
	deletedAt: integer('deleted_at')
});

export const releases = sqliteTable('releases', {
	id: text('id').primaryKey(),
	kind: text('kind', { enum: RELEASE_KINDS }).notNull(),
	version: text('version').notNull(),
	manifestDigest: text('manifest_digest').notNull(),
	schemaVersion: integer('schema_version').notNull(),
	acceptsSchema: integer('accepts_schema').notNull(),
	publishedAt: integer('published_at').notNull(),
	advisoryAt: integer('advisory_at'),
	createdAt: integer('created_at').notNull()
});

export const releaseRollouts = sqliteTable('release_rollouts', {
	id: text('id').primaryKey(),
	releaseId: text('release_id').notNull(),
	operationId: text('operation_id').notNull(),
	status: text('status', { enum: ['rolling', 'complete', 'halted', 'reverted'] }).notNull(),
	state: text('state').notNull(),
	progress: text('progress').notNull(),
	previous: text('previous').notNull(),
	firstRingAt: integer('first_ring_at'),
	lastRingAt: integer('last_ring_at'),
	stopRequested: integer('stop_requested').notNull(),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const repairs = sqliteTable('repairs', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	repairId: text('repair_id').notNull(),
	rung: text('rung').notNull(),
	status: text('status', {
		enum: ['running', 'succeeded', 'failed', 'refused', 'undone']
	}).notNull(),
	observationBefore: text('observation_before').notNull(),
	observationAfter: text('observation_after'),
	operationId: text('operation_id').notNull(),
	undoOf: text('undo_of'),
	createdAt: integer('created_at').notNull(),
	finishedAt: integer('finished_at')
});

export const ladderSwitches = sqliteTable(
	'ladder_switches',
	{
		scope: text('scope', { enum: ['global', 'organization', 'site'] }).notNull(),
		scopeId: text('scope_id').notNull(),
		auto: integer('auto').notNull(),
		updatedAt: integer('updated_at').notNull(),
		updatedBy: text('updated_by').notNull()
	},
	(table) => [primaryKey({ columns: [table.scope, table.scopeId] })]
);

export const platformAudit = sqliteTable('platform_audit', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	actor: text('actor').notNull(),
	action: text('action').notNull(),
	target: text('target').notNull(),
	detail: text('detail').notNull(),
	createdAt: integer('created_at').notNull()
});

export const ABUSE_SOURCES = ['report', 'automatic'] as const;
export const ABUSE_STATES = ['open', 'reviewing', 'actioned', 'dismissed'] as const;

export const abuseReports = sqliteTable('abuse_reports', {
	id: text('id').primaryKey(),
	siteId: text('site_id').notNull(),
	organizationId: text('organization_id').notNull(),
	source: text('source', { enum: ABUSE_SOURCES }).notNull(),
	reason: text('reason').notNull(),
	state: text('state', { enum: ABUSE_STATES }).notNull(),
	reviewer: text('reviewer'),
	notes: text('notes'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const platformFlags = sqliteTable('platform_flags', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	setBy: text('set_by').notNull(),
	setAt: integer('set_at').notNull()
});

export const supportGrants = sqliteTable('support_grants', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	grantedBy: text('granted_by').notNull(),
	scope: text('scope', { enum: SUPPORT_GRANT_SCOPES }).notNull(),
	reason: text('reason').notNull(),
	createdAt: integer('created_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	revokedAt: integer('revoked_at'),
	revokedBy: text('revoked_by')
});

export const breakGlassEvents = sqliteTable('break_glass_events', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	adminUserId: text('admin_user_id').notNull(),
	reason: text('reason').notNull(),
	startedAt: integer('started_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	ownersNotified: integer('owners_notified').notNull()
});

export const dbConsoleQueries = sqliteTable('db_console_queries', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	statement: text('statement').notNull(),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull()
});

export const MAIL_STATUSES = ['sent', 'failed', 'skipped-paused', 'skipped-preference'] as const;

export const mailLog = sqliteTable('mail_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	category: text('category').notNull(),
	class: text('class', { enum: ['essential', 'optional'] }).notNull(),
	status: text('status', { enum: MAIL_STATUSES }).notNull(),
	at: integer('at').notNull()
});

export const notificationPreferences = sqliteTable(
	'notification_preferences',
	{
		userId: text('user_id').notNull(),
		category: text('category', { enum: OPTIONAL_CATEGORIES }).notNull(),
		enabled: integer('enabled').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.userId, table.category] })]
);

export const templateBundles = sqliteTable('template_bundles', {
	id: text('id').primaryKey(),
	entryId: text('entry_id').notNull(),
	commitSha: text('commit_sha').notNull(),
	status: text('status', { enum: ['building', 'ready', 'failed'] }).notNull(),
	bundleKey: text('bundle_key'),
	manifest: text('manifest'),
	failure: text('failure'),
	createdAt: integer('created_at').notNull()
});

export const siteAccessRules = sqliteTable('site_access_rules', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	environment: text('environment').notNull(),
	preset: text('preset').notNull(),
	config: text('config').notNull(),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull(),
	revokedAt: integer('revoked_at')
});

export const siteConfigChanges = sqliteTable('site_config_changes', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	operationId: text('operation_id').notNull(),
	key: text('key').notNull(),
	before: text('before').notNull(),
	after: text('after').notNull(),
	actor: text('actor').notNull(),
	status: text('status', { enum: ['pending', 'applied', 'unverified', 'failed'] }).notNull(),
	createdAt: integer('created_at').notNull(),
	revertedBy: text('reverted_by')
});

export const customReleases = sqliteTable('custom_releases', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	sha256: text('sha256').notNull(),
	fileName: text('file_name').notNull(),
	bundleKey: text('bundle_key').notNull(),
	recipe: text('recipe').notNull(),
	createdAt: integer('created_at').notNull()
});

export const siteRevisions = sqliteTable('site_revisions', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull(),
	kind: text('kind', { enum: ['release', 'edit'] }).notNull(),
	releaseId: text('release_id'),
	bundleKey: text('bundle_key'),
	note: text('note'),
	createdAt: integer('created_at').notNull()
});

export const siteStrata = sqliteTable('site_strata', {
	siteId: text('site_id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	allocation: text('allocation', { enum: ['light', 'detailed'] }).notNull(),
	appliedAt: integer('applied_at'),
	confirmedFreeAt: integer('confirmed_free_at'),
	updatedAt: integer('updated_at').notNull(),
	store: text('store', { enum: ['none', 'ready', 'failed'] })
		.notNull()
		.default('none'),
	storeReason: text('store_reason')
});

export const orgSso = sqliteTable('org_sso', {
	organizationId: text('organization_id').primaryKey(),
	slug: text('slug').notNull().unique(),
	issuer: text('issuer').notNull(),
	clientId: text('client_id').notNull(),
	clientSecretEnvelope: text('client_secret_envelope').notNull(),
	allowedDomains: text('allowed_domains').notNull(),
	roleMap: text('role_map').notNull(),
	groupClaim: text('group_claim').notNull(),
	defaultRole: text('default_role', { enum: ['viewer', 'billing', 'developer', 'admin'] })
		.notNull()
		.default('viewer'),
	enabled: integer('enabled').notNull().default(0),
	lastVerifiedAt: integer('last_verified_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const costCenters = sqliteTable('cost_centers', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	code: text('code').notNull(),
	name: text('name').notNull(),
	departmentId: text('department_id'),
	ownerContact: text('owner_contact'),
	createdAt: integer('created_at').notNull()
});

export const pilots = sqliteTable('pilots', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	name: text('name').notNull(),
	state: text('state', { enum: ['planned', 'running', 'decided'] }).notNull(),
	startDate: text('start_date').notNull(),
	sponsor: text('sponsor'),
	technicalOwner: text('technical_owner'),
	baselineHostingSpendCents: integer('baseline_hosting_spend_cents'),
	baselineStaffHours: real('baseline_staff_hours'),
	baselineLatencyMs: real('baseline_latency_ms'),
	baselineRestoreMinutes: real('baseline_restore_minutes'),
	baselineRollbackMinutes: real('baseline_rollback_minutes'),
	baselinePatchDays: real('baseline_patch_days'),
	successCriteria: text('success_criteria').notNull().default(''),
	decision: text('decision', { enum: ['continue', 'extend', 'stop'] }),
	decidedAt: integer('decided_at'),
	continuationCostCents: integer('continuation_cost_cents'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const pilotSites = sqliteTable('pilot_sites', {
	pilotId: text('pilot_id').notNull(),
	organizationId: text('organization_id').notNull(),
	siteId: text('site_id').notNull()
});

export const pilotObservations = sqliteTable('pilot_observations', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	pilotId: text('pilot_id').notNull(),
	at: integer('at').notNull(),
	kind: text('kind', {
		enum: ['exception', 'failure', 'unsupported', 'manual-work', 'note']
	}).notNull(),
	minutes: integer('minutes'),
	text: text('text').notNull()
});

export const trustDocuments = sqliteTable('trust_documents', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	kind: text('kind', {
		enum: ['hecvat', 'vpat', 'dpa', 'mapping', 'policy', 'report']
	}).notNull(),
	version: text('version').notNull(),
	objectKey: text('object_key').notNull().unique(),
	contentType: text('content_type').notNull(),
	sizeBytes: integer('size_bytes').notNull(),
	sha256: text('sha256').notNull(),
	publishedAt: integer('published_at'),
	retiredAt: integer('retired_at'),
	createdAt: integer('created_at').notNull(),
	createdBy: text('created_by').notNull()
});

export const procurementRecords = sqliteTable('procurement_records', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	kind: text('kind', { enum: ['quote', 'po', 'invoice', 'contract'] }).notNull(),
	reference: text('reference').notNull(),
	signatory: text('signatory'),
	amount: text('amount'),
	issuedOn: text('issued_on'),
	dueOn: text('due_on'),
	notes: text('notes'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const orgContacts = sqliteTable('org_contacts', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	role: text('role', { enum: ['technical', 'billing', 'legal', 'recovery'] }).notNull(),
	name: text('name').notNull(),
	email: text('email').notNull(),
	verifiedAt: integer('verified_at'),
	notifyOn: integer('notify_on').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const siteTransfers = sqliteTable('site_transfers', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	toOrganizationId: text('to_organization_id').notNull(),
	siteId: text('site_id').notNull(),
	state: text('state').notNull(),
	keepDelegationId: text('keep_delegation_id'),
	proposedBy: text('proposed_by').notNull(),
	proposedAt: integer('proposed_at').notNull(),
	expiresAt: integer('expires_at').notNull(),
	decidedBy: text('decided_by'),
	decidedAt: integer('decided_at'),
	completedAt: integer('completed_at')
});

export const siteTransferSteps = sqliteTable(
	'site_transfer_steps',
	{
		organizationId: text('organization_id').notNull(),
		transferId: text('transfer_id').notNull(),
		step: text('step').notNull(),
		doneAt: integer('done_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.transferId, table.step] })]
);

export const siteMoves = sqliteTable(
	'site_moves',
	{
		transferId: text('transfer_id').notNull(),
		role: text('role').notNull(),
		organizationId: text('organization_id').notNull(),
		siteId: text('site_id').notNull(),
		fromOrganizationId: text('from_organization_id').notNull(),
		toOrganizationId: text('to_organization_id').notNull(),
		siteState: text('site_state'),
		epochBefore: integer('epoch_before'),
		createdAt: integer('created_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.transferId, table.role] })]
);

export const clientWorkspaces = sqliteTable('client_workspaces', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	name: text('name').notNull(),
	contactName: text('contact_name'),
	contactEmail: text('contact_email'),
	notes: text('notes'),
	contractNotes: text('contract_notes'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export const clientWorkspaceSites = sqliteTable(
	'client_workspace_sites',
	{
		organizationId: text('organization_id').notNull(),
		workspaceId: text('workspace_id').notNull(),
		siteId: text('site_id').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.siteId] })]
);

export const departments = sqliteTable('departments', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	parentId: text('parent_id'),
	name: text('name').notNull(),
	kind: text('kind', { enum: DEPARTMENT_KINDS }).notNull(),
	siteQuota: integer('site_quota'),
	createdAt: integer('created_at').notNull()
});

export const departmentMembers = sqliteTable(
	'department_members',
	{
		organizationId: text('organization_id').notNull(),
		departmentId: text('department_id').notNull(),
		userId: text('user_id').notNull(),
		role: text('role', { enum: DEPARTMENT_ROLES }).notNull(),
		grantedBy: text('granted_by').notNull(),
		grantedAt: integer('granted_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.departmentId, table.userId] })]
);

export const policyGroups = sqliteTable('policy_groups', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	name: text('name').notNull(),
	rules: text('rules').notNull(),
	createdAt: integer('created_at').notNull()
});

export const policyAssignments = sqliteTable(
	'policy_assignments',
	{
		organizationId: text('organization_id').notNull(),
		groupId: text('group_id').notNull(),
		targetKind: text('target_kind', { enum: ASSIGNMENT_KINDS }).notNull(),
		targetId: text('target_id').notNull(),
		assignedBy: text('assigned_by').notNull(),
		assignedAt: integer('assigned_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.groupId, table.targetKind, table.targetId] })]
);

export const orgClassificationMap = sqliteTable(
	'org_classification_map',
	{
		organizationId: text('organization_id').notNull(),
		label: text('label', { enum: CLASSIFICATIONS }).notNull(),
		displayName: text('display_name').notNull()
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.label] })]
);

export const BUDGET_SCOPES = ['org', 'site'] as const;
export const BUDGET_ENFORCEMENTS = ['block', 'alert'] as const;

export const budgets = sqliteTable('budgets', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	scope: text('scope', { enum: BUDGET_SCOPES }).notNull(),
	siteId: text('site_id'),
	percent: real('percent').notNull(),
	enforcement: text('enforcement', { enum: BUDGET_ENFORCEMENTS }).notNull(),
	setBy: text('set_by').notNull(),
	setAt: integer('set_at').notNull()
});

export const budgetAlertsSent = sqliteTable(
	'budget_alerts_sent',
	{
		organizationId: text('organization_id').notNull(),
		scopeKey: text('scope_key').notNull(),
		period: text('period').notNull(),
		alertKey: text('alert_key').notNull(),
		sentAt: integer('sent_at').notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.scopeKey, table.period, table.alertKey]
		})
	]
);

export const serviceAccounts = sqliteTable('service_accounts', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	departmentId: text('department_id'),
	name: text('name').notNull(),
	ownerUserId: text('owner_user_id').notNull(),
	expiresAt: integer('expires_at').notNull(),
	disabledAt: integer('disabled_at'),
	createdAt: integer('created_at').notNull()
});

export const serviceAccountKeys = sqliteTable('service_account_keys', {
	keyId: text('key_id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	serviceAccountId: text('service_account_id').notNull()
});

export const ACCESS_REVIEW_STATES = ['open', 'closed'] as const;
export const ACCESS_REVIEW_ITEM_KINDS = [
	'member',
	'grant',
	'delegation',
	'api-key',
	'service-account'
] as const;
export const ACCESS_REVIEW_DECISIONS = ['pending', 'keep', 'revoke'] as const;
export const ACCESS_REVIEW_INTERVALS = ['off', 'quarterly', 'yearly'] as const;

export const accessReviews = sqliteTable('access_reviews', {
	id: text('id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	scope: text('scope').notNull(),
	state: text('state', { enum: ACCESS_REVIEW_STATES }).notNull(),
	dueAt: integer('due_at').notNull(),
	createdBy: text('created_by').notNull(),
	createdAt: integer('created_at').notNull(),
	closedAt: integer('closed_at')
});

export const accessReviewItems = sqliteTable(
	'access_review_items',
	{
		organizationId: text('organization_id').notNull(),
		reviewId: text('review_id').notNull(),
		kind: text('kind', { enum: ACCESS_REVIEW_ITEM_KINDS }).notNull(),
		subjectRef: text('subject_ref').notNull(),
		subjectUserId: text('subject_user_id'),
		label: text('label').notNull(),
		detail: text('detail').notNull(),
		decision: text('decision', { enum: ACCESS_REVIEW_DECISIONS }).notNull(),
		decidedBy: text('decided_by'),
		decidedAt: integer('decided_at'),
		reason: text('reason'),
		appliedAt: integer('applied_at'),
		applyError: text('apply_error'),
		departmentId: text('department_id')
	},
	(table) => [primaryKey({ columns: [table.reviewId, table.kind, table.subjectRef] })]
);

export const accessReviewSchedules = sqliteTable('access_review_schedules', {
	organizationId: text('organization_id').primaryKey(),
	interval: text('interval', { enum: ACCESS_REVIEW_INTERVALS }).notNull(),
	lastOpenedAt: integer('last_opened_at'),
	setBy: text('set_by').notNull(),
	setAt: integer('set_at').notNull()
});

export const orgSettings = sqliteTable(
	'org_settings',
	{
		organizationId: text('organization_id').notNull(),
		setting: text('setting').notNull(),
		value: text('value').notNull(),
		setBy: text('set_by').notNull(),
		setAt: integer('set_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.organizationId, table.setting] })]
);

export const TABLES = [
	schemaMeta,
	users,
	identities,
	organizations,
	members,
	invites,
	apiKeys,
	delegations,
	siteTransfers,
	siteTransferSteps,
	siteMoves,
	clientWorkspaces,
	clientWorkspaceSites,
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
	siteEnvironments,
	releases,
	releaseRollouts,
	repairs,
	ladderSwitches,
	platformAudit,
	templateBundles,
	siteAccessRules,
	siteConfigChanges,
	customReleases,
	siteRevisions,
	siteStrata,
	orgSso,
	costCenters,
	departments,
	departmentMembers,
	policyGroups,
	policyAssignments,
	orgClassificationMap,
	pilots,
	pilotSites,
	pilotObservations,
	budgets,
	budgetAlertsSent,
	serviceAccounts,
	serviceAccountKeys,
	accessReviews,
	accessReviewItems,
	accessReviewSchedules,
	orgSettings,
	supportGrants,
	breakGlassEvents,
	dbConsoleQueries,
	mailLog,
	notificationPreferences,
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
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS delegations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	batch_id TEXT NOT NULL,
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
	`CREATE TABLE IF NOT EXISTS site_transfers (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	to_organization_id TEXT NOT NULL CHECK (to_organization_id <> organization_id),
	site_id TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quoted(TRANSFER_STATES)})),
	keep_delegation_id TEXT,
	proposed_by TEXT NOT NULL,
	proposed_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_by TEXT,
	decided_at INTEGER,
	completed_at INTEGER
)`,
	`CREATE TABLE IF NOT EXISTS site_transfer_steps (
	organization_id TEXT NOT NULL,
	transfer_id TEXT NOT NULL,
	step TEXT NOT NULL CHECK (step IN (${quoted(TRANSFER_STEPS)})),
	done_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, transfer_id, step)
)`,
	`CREATE TABLE IF NOT EXISTS site_moves (
	transfer_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('incoming', 'tombstone')),
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	from_organization_id TEXT NOT NULL,
	to_organization_id TEXT NOT NULL,
	site_state TEXT,
	epoch_before INTEGER,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (transfer_id, role)
)`,
	`CREATE INDEX IF NOT EXISTS site_moves_site ON site_moves (organization_id, site_id)`,
	`CREATE TABLE IF NOT EXISTS client_workspaces (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	name TEXT NOT NULL,
	contact_name TEXT,
	contact_email TEXT,
	notes TEXT,
	contract_notes TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS client_workspace_sites (
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, site_id)
)`,
	`CREATE TABLE IF NOT EXISTS site_grants (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(SITE_GRANT_ROLES)})),
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
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
	box_found_as TEXT,
	box_missing_since INTEGER,
	ready_at INTEGER,
	data_schema_version INTEGER CHECK (data_schema_version IS NULL OR data_schema_version >= 0),
	cost_center_id TEXT,
	department_id TEXT,
	classification TEXT CHECK (classification IS NULL OR classification IN (${quoted(CLASSIFICATIONS)})),
	technical_owner TEXT,
	business_owner TEXT,
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
	`CREATE TABLE IF NOT EXISTS site_environments (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('staging', 'dev', 'preview')),
	name TEXT NOT NULL,
	host TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed', 'deleting', 'deleted')),
	env_site_id TEXT,
	source_backup_id TEXT,
	ttl_at INTEGER,
	created_at INTEGER NOT NULL,
	deleted_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS site_environments_site ON site_environments (organization_id, site_id, created_at, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_environments_host ON site_environments (host)
	WHERE deleted_at IS NULL`,
	`CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,
	`CREATE INDEX IF NOT EXISTS members_org ON members (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS invites_org ON invites (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS api_keys_org ON api_keys (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash ON api_keys (key_hash)`,
	`CREATE INDEX IF NOT EXISTS api_key_lookup_org ON api_key_lookup (organization_id, key_id)`,
	`CREATE INDEX IF NOT EXISTS delegations_org ON delegations (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS delegations_batch ON delegations (organization_id, batch_id)`,
	`CREATE INDEX IF NOT EXISTS delegations_agency ON delegations (agency_organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS site_transfers_org ON site_transfers (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS site_transfers_to ON site_transfers (to_organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS site_transfers_open ON site_transfers (site_id)
	WHERE state = 'proposed'`,
	`CREATE INDEX IF NOT EXISTS client_workspaces_org ON client_workspaces (organization_id, id)`,
	`CREATE INDEX IF NOT EXISTS client_workspace_sites_workspace
	ON client_workspace_sites (organization_id, workspace_id)`,
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
	`CREATE TABLE IF NOT EXISTS plane_connections (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	provider TEXT NOT NULL CHECK (provider IN ('cloudflare')),
	account_id TEXT NOT NULL,
	account_name TEXT NOT NULL,
	token_kind TEXT NOT NULL CHECK (token_kind IN ('user', 'account')),
	token_id TEXT,
	minted INTEGER NOT NULL DEFAULT 0 CHECK (minted IN (0, 1)),
	credential_envelope TEXT,
	capabilities TEXT NOT NULL,
	workers_subdomain TEXT,
	expires_on TEXT,
	state TEXT NOT NULL CHECK (state IN ('active', 'invalid', 'revoked')),
	created_at INTEGER NOT NULL,
	last_validated_at INTEGER NOT NULL,
	revoked_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS plane_connections_org ON plane_connections (organization_id, id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS plane_connections_account
	ON plane_connections (organization_id, provider, account_id) WHERE state <> 'revoked'`,
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
	ownership_epoch INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS custom_domains_site ON custom_domains (organization_id, site_id, hostname)`,
	`CREATE TABLE IF NOT EXISTS releases (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN (${quoted(RELEASE_KINDS)})),
	version TEXT NOT NULL,
	manifest_digest TEXT NOT NULL,
	schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
	accepts_schema INTEGER NOT NULL CHECK (accepts_schema >= 0),
	published_at INTEGER NOT NULL,
	advisory_at INTEGER,
	created_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS releases_kind_version ON releases (kind, version)`,
	`CREATE TABLE IF NOT EXISTS release_rollouts (
	id TEXT PRIMARY KEY,
	release_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('rolling', 'complete', 'halted', 'reverted')),
	state TEXT NOT NULL,
	progress TEXT NOT NULL,
	previous TEXT NOT NULL,
	first_ring_at INTEGER,
	last_ring_at INTEGER,
	stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS release_rollouts_release ON release_rollouts (release_id, created_at)`,
	`CREATE TABLE IF NOT EXISTS repairs (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	repair_id TEXT NOT NULL,
	rung TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'refused', 'undone')),
	observation_before TEXT NOT NULL,
	observation_after TEXT,
	operation_id TEXT NOT NULL,
	undo_of TEXT,
	created_at INTEGER NOT NULL,
	finished_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS repairs_site_time ON repairs (organization_id, site_id, created_at)`,
	`CREATE TABLE IF NOT EXISTS ladder_switches (
	scope TEXT NOT NULL CHECK (scope IN ('global', 'organization', 'site')),
	scope_id TEXT NOT NULL,
	auto INTEGER NOT NULL CHECK (auto IN (0, 1)),
	updated_at INTEGER NOT NULL,
	updated_by TEXT NOT NULL,
	PRIMARY KEY (scope, scope_id)
)`,
	`CREATE TABLE IF NOT EXISTS platform_audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target TEXT NOT NULL,
	detail TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS abuse_reports (
	id TEXT PRIMARY KEY,
	site_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('report', 'automatic')),
	reason TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('open', 'reviewing', 'actioned', 'dismissed')),
	reviewer TEXT,
	notes TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS abuse_reports_state_time ON abuse_reports (state, created_at)`,
	`CREATE TABLE IF NOT EXISTS platform_flags (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS support_grants (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	granted_by TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN (${quoted(SUPPORT_GRANT_SCOPES)})),
	reason TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER,
	revoked_by TEXT
)`,
	`CREATE INDEX IF NOT EXISTS support_grants_org ON support_grants (organization_id, expires_at)`,
	`CREATE TABLE IF NOT EXISTS break_glass_events (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	admin_user_id TEXT NOT NULL,
	reason TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	owners_notified INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS break_glass_admin ON break_glass_events (admin_user_id, started_at)`,
	`CREATE INDEX IF NOT EXISTS break_glass_org ON break_glass_events (organization_id, expires_at)`,
	`CREATE TABLE IF NOT EXISTS db_console_queries (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	statement TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS mail_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	category TEXT NOT NULL,
	class TEXT NOT NULL CHECK (class IN ('essential', 'optional')),
	status TEXT NOT NULL CHECK (status IN (${quoted(MAIL_STATUSES)})),
	at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS mail_log_at ON mail_log (at)`,
	`CREATE TABLE IF NOT EXISTS notification_preferences (
	user_id TEXT NOT NULL,
	category TEXT NOT NULL CHECK (category IN (${quoted(OPTIONAL_CATEGORIES)})),
	enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, category)
)`,
	`CREATE TABLE IF NOT EXISTS template_bundles (
	id TEXT PRIMARY KEY,
	entry_id TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
	bundle_key TEXT,
	manifest TEXT,
	failure TEXT,
	created_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS template_bundles_entry ON template_bundles (entry_id, status, created_at)`,
	`CREATE TABLE IF NOT EXISTS site_access_rules (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	environment TEXT NOT NULL,
	preset TEXT NOT NULL,
	config TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	revoked_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS site_access_rules_site ON site_access_rules (organization_id, site_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS site_config_changes (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	key TEXT NOT NULL,
	before TEXT NOT NULL,
	after TEXT NOT NULL,
	actor TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'unverified', 'failed')),
	created_at INTEGER NOT NULL,
	reverted_by TEXT
)`,
	`CREATE INDEX IF NOT EXISTS site_config_changes_site ON site_config_changes (organization_id, site_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS site_config_changes_operation ON site_config_changes (organization_id, operation_id)`,
	`CREATE TABLE IF NOT EXISTS site_revisions (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('release', 'edit')),
	release_id TEXT,
	bundle_key TEXT,
	note TEXT,
	created_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS site_revisions_site ON site_revisions (site_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS custom_releases (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
	file_name TEXT NOT NULL,
	bundle_key TEXT NOT NULL,
	recipe TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS custom_releases_org_sha ON custom_releases (organization_id, sha256)`,
	`CREATE TABLE IF NOT EXISTS site_strata (
	site_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	allocation TEXT NOT NULL CHECK (allocation IN ('light', 'detailed')),
	applied_at INTEGER,
	confirmed_free_at INTEGER,
	updated_at INTEGER NOT NULL,
	store TEXT NOT NULL DEFAULT 'none' CHECK (store IN ('none', 'ready', 'failed')),
	store_reason TEXT
)`,
	`CREATE TABLE IF NOT EXISTS org_sso (
	organization_id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	issuer TEXT NOT NULL,
	client_id TEXT NOT NULL,
	client_secret_envelope TEXT NOT NULL,
	allowed_domains TEXT NOT NULL,
	role_map TEXT NOT NULL,
	group_claim TEXT NOT NULL,
	default_role TEXT NOT NULL DEFAULT 'viewer' CHECK (default_role IN ('viewer', 'billing', 'developer', 'admin')),
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	last_verified_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS cost_centers (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	code TEXT NOT NULL,
	name TEXT NOT NULL,
	department_id TEXT,
	owner_contact TEXT,
	created_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS cost_centers_org_code ON cost_centers (organization_id, code)`,
	`CREATE TABLE IF NOT EXISTS departments (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	parent_id TEXT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN (${quoted(DEPARTMENT_KINDS)})),
	site_quota INTEGER CHECK (site_quota IS NULL OR site_quota >= 0),
	created_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS departments_org_sibling_name ON departments (organization_id, COALESCE(parent_id, ''), lower(name))`,
	`CREATE TABLE IF NOT EXISTS department_members (
	organization_id TEXT NOT NULL,
	department_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN (${quoted(DEPARTMENT_ROLES)})),
	granted_by TEXT NOT NULL,
	granted_at INTEGER NOT NULL,
	PRIMARY KEY (department_id, user_id)
)`,
	`CREATE INDEX IF NOT EXISTS department_members_user ON department_members (organization_id, user_id)`,
	`CREATE TABLE IF NOT EXISTS pilots (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	name TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'decided')),
	start_date TEXT NOT NULL,
	sponsor TEXT,
	technical_owner TEXT,
	baseline_hosting_spend_cents INTEGER,
	baseline_staff_hours REAL,
	baseline_latency_ms REAL,
	baseline_restore_minutes REAL,
	baseline_rollback_minutes REAL,
	baseline_patch_days REAL,
	success_criteria TEXT NOT NULL DEFAULT '',
	decision TEXT CHECK (decision IS NULL OR decision IN ('continue', 'extend', 'stop')),
	decided_at INTEGER,
	continuation_cost_cents INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS pilots_org ON pilots (organization_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS pilot_sites (
	pilot_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	PRIMARY KEY (pilot_id, site_id)
)`,
	`CREATE TABLE IF NOT EXISTS pilot_observations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	pilot_id TEXT NOT NULL,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('exception', 'failure', 'unsupported', 'manual-work', 'note')),
	minutes INTEGER,
	text TEXT NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS pilot_observations_pilot ON pilot_observations (organization_id, pilot_id, at, id)`,
	`CREATE TABLE IF NOT EXISTS trust_documents (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('hecvat', 'vpat', 'dpa', 'mapping', 'policy', 'report')),
	version TEXT NOT NULL,
	object_key TEXT NOT NULL UNIQUE,
	content_type TEXT NOT NULL,
	size_bytes INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	published_at INTEGER,
	retired_at INTEGER,
	created_at INTEGER NOT NULL,
	created_by TEXT NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS procurement_records (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('quote', 'po', 'invoice', 'contract')),
	reference TEXT NOT NULL,
	signatory TEXT,
	amount TEXT,
	issued_on TEXT,
	due_on TEXT,
	notes TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS procurement_records_org ON procurement_records (organization_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS org_contacts (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('technical', 'billing', 'legal', 'recovery')),
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	verified_at INTEGER,
	notify_on INTEGER NOT NULL DEFAULT 0 CHECK (notify_on IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS org_contacts_role ON org_contacts (organization_id, role)`,
	`CREATE TABLE IF NOT EXISTS policy_groups (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	name TEXT NOT NULL,
	rules TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS policy_groups_org_name ON policy_groups (organization_id, lower(name))`,
	`CREATE TABLE IF NOT EXISTS policy_assignments (
	organization_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	target_kind TEXT NOT NULL CHECK (target_kind IN (${quoted(ASSIGNMENT_KINDS)})),
	target_id TEXT NOT NULL,
	assigned_by TEXT NOT NULL,
	assigned_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, target_kind, target_id)
)`,
	`CREATE INDEX IF NOT EXISTS policy_assignments_org ON policy_assignments (organization_id)`,
	`CREATE TABLE IF NOT EXISTS org_classification_map (
	organization_id TEXT NOT NULL,
	label TEXT NOT NULL CHECK (label IN (${quoted(CLASSIFICATIONS)})),
	display_name TEXT NOT NULL,
	PRIMARY KEY (organization_id, label)
)`,
	`CREATE TABLE IF NOT EXISTS budgets (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('org', 'site')),
	site_id TEXT,
	percent REAL NOT NULL,
	enforcement TEXT NOT NULL CHECK (enforcement IN ('block', 'alert')),
	set_by TEXT NOT NULL,
	set_at INTEGER NOT NULL,
	CHECK ((scope = 'org' AND site_id IS NULL) OR (scope = 'site' AND site_id IS NOT NULL))
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS budgets_org ON budgets (organization_id) WHERE scope = 'org'`,
	`CREATE UNIQUE INDEX IF NOT EXISTS budgets_site ON budgets (organization_id, site_id) WHERE scope = 'site'`,
	`CREATE TABLE IF NOT EXISTS budget_alerts_sent (
	organization_id TEXT NOT NULL,
	scope_key TEXT NOT NULL,
	period TEXT NOT NULL,
	alert_key TEXT NOT NULL,
	sent_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, scope_key, period, alert_key)
)`,
	`CREATE TABLE IF NOT EXISTS service_accounts (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	department_id TEXT,
	name TEXT NOT NULL,
	owner_user_id TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	disabled_at INTEGER,
	created_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS service_accounts_org ON service_accounts (organization_id, created_at, id)`,
	`CREATE INDEX IF NOT EXISTS service_accounts_owner ON service_accounts (organization_id, owner_user_id)`,
	`CREATE TABLE IF NOT EXISTS service_account_keys (
	key_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	service_account_id TEXT NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS service_account_keys_account ON service_account_keys (organization_id, service_account_id)`,
	`CREATE TABLE IF NOT EXISTS access_reviews (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quoted(ACCESS_REVIEW_STATES)})),
	due_at INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	closed_at INTEGER
)`,
	`CREATE INDEX IF NOT EXISTS access_reviews_org ON access_reviews (organization_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS access_review_items (
	organization_id TEXT NOT NULL,
	review_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN (${quoted(ACCESS_REVIEW_ITEM_KINDS)})),
	subject_ref TEXT NOT NULL,
	subject_user_id TEXT,
	label TEXT NOT NULL,
	detail TEXT NOT NULL,
	decision TEXT NOT NULL CHECK (decision IN (${quoted(ACCESS_REVIEW_DECISIONS)})),
	decided_by TEXT,
	decided_at INTEGER,
	reason TEXT,
	applied_at INTEGER,
	apply_error TEXT,
	department_id TEXT,
	PRIMARY KEY (review_id, kind, subject_ref)
)`,
	`CREATE INDEX IF NOT EXISTS access_review_items_subject ON access_review_items (organization_id, subject_user_id)`,
	`CREATE TABLE IF NOT EXISTS access_review_schedules (
	organization_id TEXT PRIMARY KEY,
	interval TEXT NOT NULL CHECK (interval IN (${quoted(ACCESS_REVIEW_INTERVALS)})),
	last_opened_at INTEGER,
	set_by TEXT NOT NULL,
	set_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS org_settings (
	organization_id TEXT NOT NULL,
	setting TEXT NOT NULL,
	value TEXT NOT NULL,
	set_by TEXT NOT NULL,
	set_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, setting)
)`,
	`CREATE TABLE IF NOT EXISTS usage_intervals (
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	hour_start TEXT NOT NULL,
	issued INTEGER NOT NULL DEFAULT 0 CHECK (issued >= 0),
	acked INTEGER NOT NULL DEFAULT 0 CHECK (acked >= 0),
	accounting TEXT NOT NULL CHECK (accounting IN ('exact', 'estimated', 'unaccounted')),
	settlement TEXT NOT NULL CHECK (settlement IN ('open', 'closed', 'invoiced', 'adjusted')),
	invoice_ref TEXT,
	closed_at INTEGER,
	PRIMARY KEY (site_id, hour_start)
)`,
	`CREATE TABLE IF NOT EXISTS usage_adjustments (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	site_id TEXT NOT NULL,
	interval_start TEXT NOT NULL,
	delta INTEGER NOT NULL CHECK (delta <> 0),
	reason TEXT NOT NULL,
	invoice_ref TEXT,
	set_by TEXT NOT NULL,
	at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS usage_adjustments_interval ON usage_adjustments (site_id, interval_start)`,
	`CREATE TABLE IF NOT EXISTS budget_states (
	site_id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('ok', 'over-budget')),
	reason TEXT CHECK (reason IN ('site-budget', 'org-budget')),
	mode TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
	block_at_views INTEGER CHECK (block_at_views >= 0),
	written_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS engine_replays (
	id TEXT PRIMARY KEY,
	seen_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS engine_replays_seen ON engine_replays (seen_at)`,
	...ESTATE_SCHEMA_STATEMENTS,
	...BILLING_SCHEMA_STATEMENTS
];

// collegedb splits schema text on ';', so trigger bodies run one at a time
export const SCHEMA_TRIGGERS: string[] = [
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
	`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
	`CREATE TRIGGER IF NOT EXISTS platform_audit_no_update BEFORE UPDATE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'platform_audit is append-only'); END`,
	`CREATE TRIGGER IF NOT EXISTS platform_audit_no_delete BEFORE DELETE ON platform_audit
BEGIN SELECT RAISE(ABORT, 'platform_audit is append-only'); END`
];
