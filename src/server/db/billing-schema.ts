import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const SUBSCRIPTION_STATUSES = [
	'none',
	'incomplete',
	'incomplete_expired',
	'trialing',
	'active',
	'past_due',
	'canceled',
	'unpaid',
	'paused'
] as const;

export const BILLING_ENTITLEMENT_STATES = ['pending', 'blocked', 'activated', 'revoked'] as const;
export const REVIEW_REASONS = ['refunded', 'disputed'] as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

// one row per organisation, on the organisation's shard
export const billingAccounts = sqliteTable('billing_accounts', {
	organizationId: text('organization_id').primaryKey(),
	stripeCustomerId: text('stripe_customer_id'),
	subscriptionId: text('subscription_id'),
	planId: text('plan_id').notNull(),
	addOns: text('add_ons').notNull(),
	status: text('status').notNull(),
	entitlementState: text('entitlement_state').notNull(),
	revision: integer('revision').notNull(),
	lastEventAt: integer('last_event_at').notNull(),
	billingEmail: text('billing_email'),
	billingName: text('billing_name'),
	billingCountry: text('billing_country'),
	lastInvoiceId: text('last_invoice_id'),
	reviewReason: text('review_reason'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

// the customer id a webhook carries maps to its organisation; the directory shard holds the rows
export const billingCustomers = sqliteTable('billing_customers', {
	stripeCustomerId: text('stripe_customer_id').primaryKey(),
	organizationId: text('organization_id').notNull()
});

export const stripeEvents = sqliteTable('stripe_events', {
	eventId: text('event_id').primaryKey(),
	type: text('type').notNull(),
	processedAt: integer('processed_at').notNull()
});

// one row per one-time pack bought, on the organisation's shard; the source id is the Stripe event
// id, so a replayed event cannot credit twice
export const billingCredits = sqliteTable('billing_credits', {
	sourceId: text('source_id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	meter: text('meter').notNull(),
	units: integer('units').notNull(),
	createdAt: integer('created_at').notNull()
});

// a checkout whose payment has not settled; nothing is granted until it succeeds, fails or expires
export const billingPending = sqliteTable('billing_pending', {
	sessionId: text('session_id').primaryKey(),
	organizationId: text('organization_id').notNull(),
	mode: text('mode').notNull(),
	createdAt: integer('created_at').notNull()
});

export const BILLING_TABLES = [
	billingAccounts,
	billingCustomers,
	stripeEvents,
	billingCredits,
	billingPending
] as const;

export const BILLING_SCHEMA_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS billing_accounts (
	organization_id TEXT PRIMARY KEY,
	stripe_customer_id TEXT,
	subscription_id TEXT,
	plan_id TEXT NOT NULL,
	add_ons TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN (${quoted(SUBSCRIPTION_STATUSES)})),
	entitlement_state TEXT NOT NULL CHECK (entitlement_state IN (${quoted(BILLING_ENTITLEMENT_STATES)})),
	revision INTEGER NOT NULL,
	last_event_at INTEGER NOT NULL,
	billing_email TEXT,
	billing_name TEXT,
	billing_country TEXT,
	last_invoice_id TEXT,
	review_reason TEXT CHECK (review_reason IS NULL OR review_reason IN (${quoted(REVIEW_REASONS)})),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS billing_customers (
	stripe_customer_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS stripe_events (
	event_id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	processed_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS billing_credits (
	source_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	meter TEXT NOT NULL,
	units INTEGER NOT NULL CHECK (units > 0),
	created_at INTEGER NOT NULL
)`,
	`CREATE TABLE IF NOT EXISTS billing_pending (
	session_id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	mode TEXT NOT NULL,
	created_at INTEGER NOT NULL
)`,
	`CREATE INDEX IF NOT EXISTS billing_pending_org ON billing_pending (organization_id)`,
	`CREATE INDEX IF NOT EXISTS billing_customers_org ON billing_customers (organization_id)`,
	`CREATE INDEX IF NOT EXISTS billing_credits_org ON billing_credits (organization_id)`
];
