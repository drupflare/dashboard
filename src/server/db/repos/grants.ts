import type { CollegeDBClient } from '@earth-app/collegedb';
import type { Grant } from '../../domain/policy';
import type { SiteGrantRole } from '../schema';

interface GrantRow {
	organization_id: string;
	site_id: string;
	role: SiteGrantRole;
}

// the live site grants one user holds in one organisation; a revoked grant is not read
export async function listUserSiteGrants(
	db: CollegeDBClient,
	organizationId: string,
	userId: string
): Promise<Grant[]> {
	const { results } = await db.all<GrantRow>(
		organizationId,
		`SELECT organization_id, site_id, role FROM site_grants
		 WHERE organization_id = ? AND user_id = ? AND revoked_at IS NULL`,
		[organizationId, userId]
	);
	return results.map((row) => ({
		level: 'site',
		orgId: row.organization_id,
		targetId: row.site_id,
		role: row.role
	}));
}
