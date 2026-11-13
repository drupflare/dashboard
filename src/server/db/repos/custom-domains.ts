import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ClaimRow } from '../../domain/domain-attach';
import { DIRECTORY_KEY, wasChanged } from '../collegedb';

export interface AttachedDomain {
	hostname: string;
	since: number;
}

interface DomainDbRow {
	hostname: string;
	updated_at: number;
}

// the domains that serve a site now; a claim that is waiting or released is not listed
export async function listAttachedDomains(
	db: CollegeDBClient,
	orgId: string,
	siteId: string
): Promise<AttachedDomain[]> {
	const { results } = await db.all<DomainDbRow>(
		DIRECTORY_KEY,
		`SELECT hostname, updated_at FROM custom_domains
		 WHERE organization_id = ? AND site_id = ? AND state = 'routed' ORDER BY hostname`,
		[orgId, siteId]
	);
	return results.map((row) => ({ hostname: row.hostname, since: row.updated_at }));
}

interface ClaimDbRow {
	hostname: string;
	organization_id: string;
	site_id: string;
	operation_id: string;
	epoch: number;
	state: ClaimRow['state'];
	provider_id: string | null;
	ownership_epoch: number | null;
	updated_at: number;
}

export async function getClaim(db: CollegeDBClient, hostname: string): Promise<ClaimRow | null> {
	const { results } = await db.all<ClaimDbRow>(
		DIRECTORY_KEY,
		`SELECT hostname, organization_id, site_id, operation_id, epoch, state, provider_id,
		 ownership_epoch, updated_at FROM custom_domains WHERE hostname = ?`,
		[hostname]
	);
	const row = results[0];
	if (row === undefined) return null;
	return {
		hostname: row.hostname,
		organizationId: row.organization_id,
		siteId: row.site_id,
		operationId: row.operation_id,
		epoch: row.epoch,
		state: row.state,
		providerId: row.provider_id,
		ownershipEpoch: row.ownership_epoch,
		updatedAt: row.updated_at
	};
}

// the same reading the engine's ledger uses for a holder: active and suspended sites keep a claim
export async function isHolderLive(db: CollegeDBClient, siteId: string): Promise<boolean> {
	const { results } = await db.all<{ state: string }>(
		DIRECTORY_KEY,
		'SELECT state FROM sites WHERE id = ?',
		[siteId]
	);
	const state = results[0]?.state;
	return state === 'active' || state === 'suspended';
}

// ends a claim that has no provider hostname yet, which is a waiting attach or a proven name that
// is parked; false when the site no longer holds it or the provider already knows the name
export async function releaseWaitingClaim(
	db: CollegeDBClient,
	input: { orgId: string; siteId: string; hostname: string; now: number }
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		`UPDATE custom_domains SET state = 'released', ownership_epoch = NULL, updated_at = ?
		 WHERE hostname = ? AND organization_id = ? AND site_id = ? AND state = 'claimed'
		 AND provider_id IS NULL`,
		[input.now, input.hostname, input.orgId, input.siteId]
	);
	return wasChanged(result);
}
