import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

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
