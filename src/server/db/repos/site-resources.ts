import type { CollegeDBClient } from '@earth-app/collegedb';
import { uniqueOrDuplicate } from '../collegedb';
import type { SITE_RESOURCE_KINDS } from '../schema';

export interface SiteResource {
	id: string;
	siteId: string;
	accountId: string;
	kind: (typeof SITE_RESOURCE_KINDS)[number];
	binding: string;
	name: string;
	providerId: string;
	createdByOperation: string;
	createdAt: number;
	deletedAt: number | null;
}

interface ResourceRow {
	id: string;
	site_id: string;
	account_id: string;
	kind: SiteResource['kind'];
	binding: string;
	name: string;
	provider_id: string;
	created_by_operation: string;
	created_at: number;
	deleted_at: number | null;
}

const COLUMNS = `id, site_id, account_id, kind, binding, name, provider_id, created_by_operation,
	created_at, deleted_at`;

function toResource(row: ResourceRow): SiteResource {
	return {
		id: row.id,
		siteId: row.site_id,
		accountId: row.account_id,
		kind: row.kind,
		binding: row.binding,
		name: row.name,
		providerId: row.provider_id,
		createdByOperation: row.created_by_operation,
		createdAt: row.created_at,
		deletedAt: row.deleted_at
	};
}

export async function insertSiteResource(
	db: CollegeDBClient,
	resource: Omit<SiteResource, 'deletedAt'>
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			resource.siteId,
			`INSERT INTO site_resources (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			[
				resource.id,
				resource.siteId,
				resource.accountId,
				resource.kind,
				resource.binding,
				resource.name,
				resource.providerId,
				resource.createdByOperation,
				resource.createdAt
			]
		)
	);
}

export async function listLiveSiteResources(
	db: CollegeDBClient,
	siteId: string
): Promise<SiteResource[]> {
	const { results } = await db.all<ResourceRow>(
		siteId,
		`SELECT ${COLUMNS} FROM site_resources
		 WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
		[siteId]
	);
	return results.map(toResource);
}
