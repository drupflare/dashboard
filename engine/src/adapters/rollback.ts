import type { D1Database } from '@cloudflare/workers-types';
import type { RollbackDeps } from '../ports';

interface FactsRow {
	data_schema_version: number | null;
}

interface ReleaseRow {
	schema_version: number;
	accepts_schema: number;
}

export function rollbackFactsOf(db: D1Database): RollbackDeps['rollbackFacts'] {
	return async (siteId, targetId) => {
		const site = await db
			.prepare('SELECT data_schema_version FROM sites WHERE id = ?')
			.bind(siteId)
			.first<FactsRow>();
		// a bundle of the site's own organisation stores no data version; the migration check in
		// the workflow is what guards it
		const bundle = await db
			.prepare(
				`SELECT 1 AS hit FROM custom_releases c
				 WHERE c.id = ? AND c.organization_id = (SELECT organization_id FROM sites WHERE id = ?)`
			)
			.bind(targetId, siteId)
			.first<{ hit: number }>();
		if (bundle !== null) {
			return { dataSchemaVersion: 0, target: { schemaVersion: 0, acceptsSchema: 0 } };
		}
		const release = await db
			.prepare('SELECT schema_version, accepts_schema FROM releases WHERE id = ?')
			.bind(targetId)
			.first<ReleaseRow>();
		return {
			dataSchemaVersion: site?.data_schema_version ?? null,
			target:
				release === null
					? null
					: {
							schemaVersion: release.schema_version,
							acceptsSchema: release.accepts_schema
						}
		};
	};
}
