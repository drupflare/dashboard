import type { CollegeDBClient } from '@earth-app/collegedb';

export interface SiteDiscovery {
	siteId: string;
	document: unknown;
	etag: string | null;
	fetchedAt: number;
}

export async function getSiteDiscovery(
	db: CollegeDBClient,
	siteId: string
): Promise<SiteDiscovery | null> {
	const row = await db.first<{
		site_id: string;
		document: string;
		etag: string | null;
		fetched_at: number;
	}>(siteId, 'SELECT site_id, document, etag, fetched_at FROM site_discovery WHERE site_id = ?', [
		siteId
	]);
	if (!row) return null;
	return {
		siteId: row.site_id,
		document: JSON.parse(row.document) as unknown,
		etag: row.etag,
		fetchedAt: row.fetched_at
	};
}

// the latest document and its etag replace whatever the site held
export async function upsertSiteDiscovery(db: CollegeDBClient, next: SiteDiscovery): Promise<void> {
	await db.run(
		next.siteId,
		`INSERT INTO site_discovery (site_id, document, etag, fetched_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (site_id) DO UPDATE SET
		 document = excluded.document, etag = excluded.etag, fetched_at = excluded.fetched_at`,
		[next.siteId, JSON.stringify(next.document), next.etag, next.fetchedAt]
	);
}
