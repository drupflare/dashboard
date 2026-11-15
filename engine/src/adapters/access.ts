import type { D1Database } from '@cloudflare/workers-types';
import type { AccessPresetId, AccessRule } from '../../../src/shared/access-presets';
import type { AccessLedger } from '../ports';

interface RuleRow {
	id: string;
	environment: string;
	preset: AccessPresetId;
	config: string;
}

interface EnvironmentRow {
	id: string;
	env_site_id: string | null;
}

export class D1AccessLedger implements AccessLedger {
	constructor(private readonly db: D1Database) {}

	async load(organizationId: string, siteId: string) {
		const rules = await this.db
			.prepare(
				`SELECT id, environment, preset, config FROM site_access_rules
				 WHERE organization_id = ? AND site_id = ? AND revoked_at IS NULL
				 ORDER BY created_at ASC, id ASC`
			)
			.bind(organizationId, siteId)
			.all<RuleRow>();
		const environments = await this.db
			.prepare(
				`SELECT id, env_site_id FROM site_environments
				 WHERE organization_id = ? AND site_id = ? AND deleted_at IS NULL
				 ORDER BY created_at DESC, id DESC`
			)
			.bind(organizationId, siteId)
			.all<EnvironmentRow>();
		return {
			rules: rules.results.map((row): AccessRule => ({
				id: row.id,
				environment: row.environment,
				preset: row.preset,
				config: JSON.parse(row.config) as Record<string, unknown>
			})),
			environments: environments.results.map((row) => ({
				id: row.id,
				siteId: row.env_site_id
			}))
		};
	}

	async parentOf(organizationId: string, environmentId: string): Promise<string | null> {
		const row = await this.db
			.prepare(
				`SELECT site_id FROM site_environments
				 WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`
			)
			.bind(organizationId, environmentId)
			.first<{ site_id: string }>();
		return row?.site_id ?? null;
	}
}
