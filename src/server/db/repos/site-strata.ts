import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	STRATA_STORE_STATES,
	storageCheckOf,
	strataAllocationSchema,
	type StrataAllocation,
	type StrataStorageCheck,
	type StrataStoreState
} from '../../../shared/strata';
import { openConnectionForAccount } from './plane-connections';

// reads the stored connection only; nothing is created or tested on the customer's account
export async function selfManagedStorageCheck(
	db: CollegeDBClient,
	orgId: string,
	accountId: string | null
): Promise<StrataStorageCheck> {
	if (accountId === null) return 'unchecked';
	const connection = await openConnectionForAccount(db, orgId, accountId);
	if (connection === null || connection.state !== 'active') return 'unchecked';
	return storageCheckOf(connection.capabilities.find((item) => item.id === 'storage'));
}

export interface SiteStrata {
	siteId: string;
	organizationId: string;
	allocation: StrataAllocation;
	appliedAt: number | null;
	confirmedFreeAt: number | null;
	updatedAt: number;
	store: StrataStoreState;
	storeReason: string | null;
}

interface Row {
	site_id: string;
	organization_id: string;
	allocation: string;
	applied_at: number | null;
	confirmed_free_at: number | null;
	updated_at: number;
	store: string;
	store_reason: string | null;
}

export async function getSiteStrata(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<SiteStrata | null> {
	const row = await db.first<Row>(
		siteId,
		`SELECT site_id, organization_id, allocation, applied_at, confirmed_free_at, updated_at, store,
		 store_reason FROM site_strata WHERE site_id = ? AND organization_id = ?`,
		[siteId, organizationId]
	);
	if (!row) return null;
	return {
		siteId: row.site_id,
		organizationId: row.organization_id,
		allocation: strataAllocationSchema.parse(row.allocation),
		appliedAt: row.applied_at,
		confirmedFreeAt: row.confirmed_free_at,
		updatedAt: row.updated_at,
		store: STRATA_STORE_STATES.find((state) => state === row.store) ?? 'none',
		storeReason: row.store_reason
	};
}

// the allocation guard keeps a slow apply from marking a choice that changed while it ran
export async function markStrataApplied(
	db: CollegeDBClient,
	next: {
		organizationId: string;
		siteId: string;
		allocation: StrataAllocation;
		now: number;
	}
): Promise<void> {
	await db.run(
		next.siteId,
		`UPDATE site_strata SET applied_at = ?
		 WHERE site_id = ? AND organization_id = ? AND allocation = ?`,
		[next.now, next.siteId, next.organizationId, next.allocation]
	);
}

// a new choice is not applied until the site accepts it, and a confirmation once given stays on record
export async function saveSiteStrata(
	db: CollegeDBClient,
	next: {
		organizationId: string;
		siteId: string;
		allocation: StrataAllocation;
		confirmedFreeAt?: number;
		now: number;
	}
): Promise<void> {
	await db.run(
		next.siteId,
		`INSERT INTO site_strata (site_id, organization_id, allocation, applied_at, confirmed_free_at, updated_at)
		 VALUES (?, ?, ?, NULL, ?, ?)
		 ON CONFLICT (site_id) DO UPDATE SET
		 allocation = excluded.allocation,
		 applied_at = CASE WHEN site_strata.allocation = excluded.allocation THEN site_strata.applied_at ELSE NULL END,
		 confirmed_free_at = COALESCE(excluded.confirmed_free_at, site_strata.confirmed_free_at),
		 updated_at = excluded.updated_at`,
		[next.siteId, next.organizationId, next.allocation, next.confirmedFreeAt ?? null, next.now]
	);
}
