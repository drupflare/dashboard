import type { CollegeDBClient } from '@earth-app/collegedb';
import type { AddOnHolding } from '../../domain/entitlements';
import { DIRECTORY_KEY } from '../collegedb';

export interface BillingAccount {
	organizationId: string;
	stripeCustomerId: string | null;
	subscriptionId: string | null;
	planId: string;
	addOns: AddOnHolding[];
	status: string;
	entitlementState: string;
	revision: number;
	lastEventAt: number;
	billingEmail: string | null;
	billingName: string | null;
	billingCountry: string | null;
	lastInvoiceId: string | null;
	reviewReason: string | null;
	createdAt: number;
	updatedAt: number;
}

interface AccountRow {
	organization_id: string;
	stripe_customer_id: string | null;
	subscription_id: string | null;
	plan_id: string;
	add_ons: string;
	status: string;
	entitlement_state: string;
	revision: number;
	last_event_at: number;
	billing_email: string | null;
	billing_name: string | null;
	billing_country: string | null;
	last_invoice_id: string | null;
	review_reason: string | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS = `organization_id, stripe_customer_id, subscription_id, plan_id, add_ons, status,
	entitlement_state, revision, last_event_at, billing_email, billing_name, billing_country,
	last_invoice_id, review_reason, created_at, updated_at`;

function parseAddOns(raw: string): AddOnHolding[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is AddOnHolding =>
				typeof item === 'object' &&
				item !== null &&
				typeof item.id === 'string' &&
				Number.isInteger(item.quantity) &&
				item.quantity > 0
		);
	} catch {
		return [];
	}
}

function toAccount(row: AccountRow): BillingAccount {
	return {
		organizationId: row.organization_id,
		stripeCustomerId: row.stripe_customer_id,
		subscriptionId: row.subscription_id,
		planId: row.plan_id,
		addOns: parseAddOns(row.add_ons),
		status: row.status,
		entitlementState: row.entitlement_state,
		revision: row.revision,
		lastEventAt: row.last_event_at,
		billingEmail: row.billing_email,
		billingName: row.billing_name,
		billingCountry: row.billing_country,
		lastInvoiceId: row.last_invoice_id,
		reviewReason: row.review_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function getAccount(
	db: CollegeDBClient,
	organizationId: string
): Promise<BillingAccount | null> {
	const row = await db.first<AccountRow>(
		organizationId,
		`SELECT ${COLUMNS} FROM billing_accounts WHERE organization_id = ?`,
		[organizationId]
	);
	return row ? toAccount(row) : null;
}

// the free plan is the baseline, so an organisation with no row is read as one
export async function ensureAccount(
	db: CollegeDBClient,
	organizationId: string,
	freePlanId: string,
	now: number
): Promise<BillingAccount> {
	await db.run(
		organizationId,
		`INSERT OR IGNORE INTO billing_accounts (organization_id, plan_id, add_ons, status,
		 entitlement_state, revision, last_event_at, created_at, updated_at)
		 VALUES (?, ?, '[]', 'none', 'pending', 0, 0, ?, ?)`,
		[organizationId, freePlanId, now, now]
	);
	const account = await getAccount(db, organizationId);
	if (!account) throw new Error(`billing account for ${organizationId} is missing after insert`);
	return account;
}

export async function linkCustomer(
	db: CollegeDBClient,
	customerId: string,
	organizationId: string
): Promise<'linked' | 'conflict'> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT OR IGNORE INTO billing_customers (stripe_customer_id, organization_id) VALUES (?, ?)`,
		[customerId, organizationId]
	);
	return (await findOrgByCustomer(db, customerId)) === organizationId ? 'linked' : 'conflict';
}

export async function findOrgByCustomer(
	db: CollegeDBClient,
	customerId: string
): Promise<string | null> {
	const row = await db.first<{ organization_id: string }>(
		DIRECTORY_KEY,
		'SELECT organization_id FROM billing_customers WHERE stripe_customer_id = ?',
		[customerId]
	);
	return row?.organization_id ?? null;
}

export interface SubscriptionApply {
	organizationId: string;
	customerId: string;
	subscriptionId: string;
	planId: string;
	addOns: readonly AddOnHolding[];
	status: string;
	entitlementState: string;
	eventAt: number;
	now: number;
}

// an event older than the last one applied changes nothing; null means it was stale
export async function applySubscription(
	db: CollegeDBClient,
	input: SubscriptionApply
): Promise<number | null> {
	const row = await db.first<{ revision: number }>(
		input.organizationId,
		`INSERT INTO billing_accounts (organization_id, stripe_customer_id, subscription_id, plan_id,
		 add_ons, status, entitlement_state, revision, last_event_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		 ON CONFLICT (organization_id) DO UPDATE SET
		 stripe_customer_id = excluded.stripe_customer_id,
		 subscription_id = excluded.subscription_id, plan_id = excluded.plan_id,
		 add_ons = excluded.add_ons, status = excluded.status,
		 entitlement_state = excluded.entitlement_state,
		 revision = billing_accounts.revision + 1, last_event_at = excluded.last_event_at,
		 updated_at = excluded.updated_at
		 WHERE excluded.last_event_at >= billing_accounts.last_event_at
		 RETURNING revision`,
		[
			input.organizationId,
			input.customerId,
			input.subscriptionId,
			input.planId,
			JSON.stringify(input.addOns),
			input.status,
			input.entitlementState,
			input.eventAt,
			input.now,
			input.now
		]
	);
	return row?.revision ?? null;
}

export interface AccountPatch {
	stripeCustomerId?: string;
	subscriptionId?: string;
	status?: string;
	// null clears the stored value, which is how a removed address reaches the account
	billingEmail?: string | null;
	billingName?: string | null;
	billingCountry?: string | null;
	lastInvoiceId?: string;
	reviewReason?: string;
}

const PATCH_COLUMNS: Record<keyof AccountPatch, string> = {
	stripeCustomerId: 'stripe_customer_id',
	subscriptionId: 'subscription_id',
	status: 'status',
	billingEmail: 'billing_email',
	billingName: 'billing_name',
	billingCountry: 'billing_country',
	lastInvoiceId: 'last_invoice_id',
	reviewReason: 'review_reason'
};

// the same staleness rule as a subscription event; the patch never bumps the revision because it
// changes no plan or entitlement
export async function patchAccount(
	db: CollegeDBClient,
	organizationId: string,
	patch: AccountPatch,
	eventAt: number,
	now: number
): Promise<boolean> {
	const keys = (Object.keys(PATCH_COLUMNS) as (keyof AccountPatch)[]).filter(
		(key) => patch[key] !== undefined
	);
	if (keys.length === 0) return false;
	const sets = keys.map((key) => `${PATCH_COLUMNS[key]} = ?`);
	const row = await db.first<{ organization_id: string }>(
		organizationId,
		`UPDATE billing_accounts SET ${sets.join(', ')}, last_event_at = max(last_event_at, ?),
		 updated_at = ? WHERE organization_id = ? AND last_event_at <= ?
		 RETURNING organization_id`,
		[...keys.map((key) => patch[key]), eventAt, now, organizationId, eventAt]
	);
	return row !== null;
}

export interface BillingDetails {
	name: string | null;
	email: string | null;
	country: string | null;
}

// a person's own save: it leaves last_event_at alone, so no webhook that Stripe created just
// before it can be read as stale and dropped
export async function setBillingDetails(
	db: CollegeDBClient,
	organizationId: string,
	details: BillingDetails,
	now: number
): Promise<void> {
	await db.run(
		organizationId,
		`UPDATE billing_accounts SET billing_name = ?, billing_email = ?, billing_country = ?,
		 updated_at = ? WHERE organization_id = ?`,
		[details.name, details.email, details.country, now, organizationId]
	);
}

export interface PendingInput {
	sessionId: string;
	organizationId: string;
	mode: string;
	now: number;
}

export async function addPending(db: CollegeDBClient, input: PendingInput): Promise<void> {
	await db.run(
		input.organizationId,
		`INSERT OR IGNORE INTO billing_pending (session_id, organization_id, mode, created_at)
		 VALUES (?, ?, ?, ?)`,
		[input.sessionId, input.organizationId, input.mode, input.now]
	);
}

// true when a pending purchase was there to clear
export async function clearPending(
	db: CollegeDBClient,
	organizationId: string,
	sessionId: string
): Promise<boolean> {
	const row = await db.first<{ session_id: string }>(
		organizationId,
		`DELETE FROM billing_pending WHERE session_id = ? AND organization_id = ?
		 RETURNING session_id`,
		[sessionId, organizationId]
	);
	return row !== null;
}

export interface CreditInput {
	organizationId: string;
	meter: string;
	units: number;
	sourceId: string;
	now: number;
}

// false means the source id was already credited and nothing changed
export async function addCredit(db: CollegeDBClient, input: CreditInput): Promise<boolean> {
	const row = await db.first<{ source_id: string }>(
		input.organizationId,
		`INSERT INTO billing_credits (source_id, organization_id, meter, units, created_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_id) DO NOTHING RETURNING source_id`,
		[input.sourceId, input.organizationId, input.meter, input.units, input.now]
	);
	return row !== null;
}

// purchased units per meter; nothing consumes a credit yet
export async function creditBalances(
	db: CollegeDBClient,
	organizationId: string
): Promise<Record<string, number>> {
	const { results } = await db.all<{ meter: string; units: number }>(
		organizationId,
		`SELECT meter, SUM(units) AS units FROM billing_credits WHERE organization_id = ?
		 GROUP BY meter ORDER BY meter`,
		[organizationId]
	);
	return Object.fromEntries(results.map((row) => [row.meter, row.units]));
}

export async function hasEvent(db: CollegeDBClient, eventId: string): Promise<boolean> {
	const row = await db.first<{ event_id: string }>(
		DIRECTORY_KEY,
		'SELECT event_id FROM stripe_events WHERE event_id = ?',
		[eventId]
	);
	return row !== null;
}

export async function recordEvent(
	db: CollegeDBClient,
	eventId: string,
	type: string,
	now: number
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		'INSERT OR IGNORE INTO stripe_events (event_id, type, processed_at) VALUES (?, ?, ?)',
		[eventId, type, now]
	);
}
