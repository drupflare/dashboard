import type { CollegeDBClient } from '@earth-app/collegedb';
import type { Delegation } from '../../domain/delegation';
import type { DelegationRole } from '../schema';

interface DelegationRow {
	id: string;
	organization_id: string;
	agency_organization_id: string;
	role: DelegationRole;
	site_id: string | null;
	created_by: string;
	created_at: number;
	expires_at: number | null;
	revoked_at: number | null;
}

// the accepted, unrevoked delegations where this organisation is the client; a pending or revoked
// row is not read, and the caller drops an expired one against its own clock
export async function listActiveDelegations(
	db: CollegeDBClient,
	clientOrganizationId: string
): Promise<Delegation[]> {
	const { results } = await db.all<DelegationRow>(
		clientOrganizationId,
		`SELECT id, organization_id, agency_organization_id, role, site_id, created_by, created_at,
		 expires_at, revoked_at FROM delegations
		 WHERE organization_id = ? AND state = 'active' AND revoked_at IS NULL`,
		[clientOrganizationId]
	);
	return results.map((row) => ({
		id: row.id,
		clientOrgId: row.organization_id,
		agencyOrgId: row.agency_organization_id,
		role: row.role,
		sites: row.site_id === null ? 'all' : [row.site_id],
		status: 'active',
		createdBy: row.created_by,
		createdAt: row.created_at,
		...(row.expires_at === null ? {} : { expiresAt: row.expires_at })
	}));
}
