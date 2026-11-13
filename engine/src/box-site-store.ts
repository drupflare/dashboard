import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { newId } from '@contracts/common';
import { MAX_SITE_MAP } from '@contracts/fleet-link';
import type { BoxSiteChanges, KnownBoxSite } from '../../src/server/domain/box-sites';
import { append, r2HeadStore, type AuditDb, type HeadStore } from '../../src/server/services/audit';

// a status frame is read against the organization's self-hosted rows; past this many the read is not
// trusted to be whole, so nothing is written from it
export const MAX_KNOWN_ROWS = 2 * MAX_SITE_MAP;

// a batch carries this many statements at a time
const CHUNK = 50;

export interface BoxSiteStore {
	// null when the organization holds more rows than a frame can be compared against
	known(orgId: string): Promise<KnownBoxSite[] | null>;
	apply(
		orgId: string,
		nodeId: string,
		changes: BoxSiteChanges,
		now: number
	): Promise<{ created: number }>;
}

interface KnownRow {
	id: string;
	name: string;
	primary_hostname: string | null;
	box_found_as: string | null;
	node_id: string | null;
	state: KnownBoxSite['state'];
	ready_at: number | null;
	box_missing_since: number | null;
}

function auditDbOf(db: D1Database): AuditDb {
	return {
		first: (_key: string, sql: string, bindings: unknown[] = []) =>
			db
				.prepare(sql)
				.bind(...bindings)
				.first(),
		run: (_key: string, sql: string, bindings: unknown[] = []) =>
			db
				.prepare(sql)
				.bind(...bindings)
				.run()
	} as unknown as AuditDb;
}

export class D1BoxSiteStore implements BoxSiteStore {
	private readonly audit: AuditDb;
	private readonly heads: HeadStore;

	constructor(
		private readonly db: D1Database,
		bucket: R2Bucket
	) {
		this.audit = auditDbOf(db);
		this.heads = r2HeadStore(bucket);
	}

	// every query names the organization first, since the table is sharded by it
	async known(orgId: string): Promise<KnownBoxSite[] | null> {
		const { results } = await this.db
			.prepare(
				`SELECT id, name, primary_hostname, box_found_as, node_id, state, ready_at,
					box_missing_since FROM sites
				 WHERE organization_id = ? AND plane = 'self-hosted'
					AND (state IN ('active', 'suspended')
						OR (state = 'deleted' AND box_found_as IS NOT NULL))
				 ORDER BY id LIMIT ?`
			)
			.bind(orgId, MAX_KNOWN_ROWS + 1)
			.all<KnownRow>();
		if (results.length > MAX_KNOWN_ROWS) return null;
		return results.map((row) => ({
			id: row.id,
			name: row.name,
			host: row.primary_hostname,
			foundAs: row.box_found_as,
			nodeId: row.node_id,
			state: row.state,
			readyAt: row.ready_at,
			missingSince: row.box_missing_since
		}));
	}

	async apply(
		orgId: string,
		nodeId: string,
		changes: BoxSiteChanges,
		now: number
	): Promise<{ created: number }> {
		const marks = [
			...changes.markMissing.map((id) =>
				this.db
					.prepare(
						`UPDATE sites SET box_missing_since = ?, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND node_id = ?
							AND box_missing_since IS NULL`
					)
					.bind(now, now, orgId, id, nodeId)
			),
			...changes.markPresent.map((id) =>
				this.db
					.prepare(
						`UPDATE sites SET box_missing_since = NULL, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND node_id = ?
							AND box_missing_since IS NOT NULL`
					)
					.bind(now, orgId, id, nodeId)
			),
			...changes.learn.map((item) =>
				this.db
					.prepare(
						`UPDATE sites SET primary_hostname = ?, box_found_as = ?, updated_at = ?
						 WHERE organization_id = ? AND id = ? AND node_id = ?
							AND primary_hostname IS NULL AND box_found_as IS NOT NULL`
					)
					.bind(item.host, item.host, now, orgId, item.id, nodeId)
			)
		];
		for (let at = 0; at < marks.length; at += CHUNK) {
			await this.db.batch(marks.slice(at, at + CHUNK));
		}

		let created = 0;
		for (const found of changes.create) {
			const id = newId('site');
			// the audit row first, so a row never exists without its record; a failed insert leaves
			// an audit row that names a site the next frame creates again
			await append(
				this.audit,
				orgId,
				{ actor: `node:${nodeId}`, action: 'site.found', target: id, detail: { nodeId } },
				this.heads
			);
			const { meta } = await this.db
				.prepare(
					`INSERT INTO sites (id, organization_id, name, kind, category, plane, config,
						account_id, state, primary_hostname, release_id, node_id, box_found_as,
						box_missing_since, ready_at, created_at, updated_at)
					 SELECT ?, ?, ?, 'drupal', 'cms', 'self-hosted', 'canonical', NULL, 'active', ?,
						NULL, ?, ?, NULL, ?, ?, ?
					 WHERE NOT EXISTS (SELECT 1 FROM sites WHERE organization_id = ? AND node_id = ?
						AND box_found_as = ?)`
				)
				.bind(
					id,
					orgId,
					found.name,
					found.host,
					nodeId,
					found.foundAs,
					now,
					now,
					now,
					orgId,
					nodeId,
					found.foundAs
				)
				.run();
			if (meta.changes === 1) created++;
		}
		return { created };
	}
}
