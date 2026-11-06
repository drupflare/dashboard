import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

export interface BillingAccount {
	organizationId: string;
	stripeCustomerId: string | null;
	subscriptionId: string | null;
	planId: string;
	addOnIds: string[];
	status: string;
	entitlementState: string;
	revision: number;
	lastEventAt: number;
	billingEmail: string | null;
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
	add_on_ids: string;
	status: string;
	entitlement_state: string;
	revision: number;
	last_event_at: number;
	billing_email: string | null;
	last_invoice_id: string | null;
	review_reason: string | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS = `organization_id, stripe_customer_id, subscription_id, plan_id, add_on_ids, status,
	entitlement_state, revision, last_event_at, billing_email, last_invoice_id, review_reason,
	created_at, updated_at`;

function parseAddOns(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
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
		addOnIds: parseAddOns(row.add_on_ids),
		status: row.status,
		entitlementState: row.entitlement_state,
		revision: row.revision,
		lastEventAt: row.last_event_at,
		billingEmail: row.billing_email,
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
		`INSERT OR IGNORE INTO billing_accounts (organization_id, plan_id, add_on_ids, status,
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
	addOnIds: readonly string[];
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
		 add_on_ids, status, entitlement_state, revision, last_event_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
		 ON CONFLICT (organization_id) DO UPDATE SET
		 stripe_customer_id = excluded.stripe_customer_id,
		 subscription_id = excluded.subscription_id, plan_id = excluded.plan_id,
		 add_on_ids = excluded.add_on_ids, status = excluded.status,
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
			JSON.stringify(input.addOnIds),
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
	billingEmail?: string;
	lastInvoiceId?: string;
	reviewReason?: string;
}

const PATCH_COLUMNS: Record<keyof AccountPatch, string> = {
	stripeCustomerId: 'stripe_customer_id',
	subscriptionId: 'subscription_id',
	status: 'status',
	billingEmail: 'billing_email',
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
