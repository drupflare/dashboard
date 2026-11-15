import type { CollegeDBClient } from '@earth-app/collegedb';

export const REVISION_KINDS = ['release', 'edit'] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export interface SiteRevision {
	id: string;
	siteId: string;
	kind: RevisionKind;
	releaseId: string | null;
	bundleKey: string | null;
	note: string | null;
	createdAt: number;
}

interface Row {
	id: string;
	site_id: string;
	kind: RevisionKind;
	release_id: string | null;
	bundle_key: string | null;
	note: string | null;
	created_at: number;
}

const toRevision = (row: Row): SiteRevision => ({
	id: row.id,
	siteId: row.site_id,
	kind: row.kind,
	releaseId: row.release_id,
	bundleKey: row.bundle_key,
	note: row.note,
	createdAt: row.created_at
});

export async function getSiteRevision(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	id: string
): Promise<SiteRevision | null> {
	const { results } = await db.all<Row>(
		organizationId,
		`SELECT id, site_id, kind, release_id, bundle_key, note, created_at FROM site_revisions
		 WHERE organization_id = ? AND site_id = ? AND id = ?`,
		[organizationId, siteId, id]
	);
	const row = results[0];
	return row === undefined ? null : toRevision(row);
}

// newest first; the engine store writes a release row on every change of release
export async function listSiteRevisions(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	limit: number
): Promise<SiteRevision[]> {
	const { results } = await db.all<Row>(
		organizationId,
		`SELECT id, site_id, kind, release_id, bundle_key, note, created_at FROM site_revisions
		 WHERE organization_id = ? AND site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, limit]
	);
	return results.map(toRevision);
}
