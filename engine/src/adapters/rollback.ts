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
