import type { CollegeDBClient } from '@earth-app/collegedb';

export interface SiteHome {
	id: string;
	organizationId: string;
}

export class SiteLookupError extends Error {
	readonly code = 'SITE_LOOKUP';

	constructor(shard: string) {
		super(`the site lookup failed on ${shard}`);
		this.name = 'SiteLookupError';
	}
}

// sites shard by organisation and a site route names no organisation, so every shard answers one
// primary key read. A site id on more than one shard has no safe owner, so it finds nothing; a
// shard that fails to answer stops the lookup instead of hiding a possible second owner
export async function findSiteHome(db: CollegeDBClient, id: string): Promise<SiteHome | null> {
	const shards = await db.allAllShards<{ id: string; organization_id: string }>(
		'SELECT id, organization_id FROM sites WHERE id = ?',
		[id]
	);
	const rows: { id: string; organization_id: string }[] = [];
	for (const [index, shard] of shards.entries()) {
		if (!shard.success) throw new SiteLookupError(`shard ${index}`);
		rows.push(...shard.results);
	}
	const [row] = rows;
	if (rows.length !== 1 || !row) return null;
	return { id: row.id, organizationId: row.organization_id };
}
