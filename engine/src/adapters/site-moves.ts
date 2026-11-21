import { canonicalJson } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { PermanentError } from '../step';

// one database per organisation key; a batch runs on one shard and either lands whole or not at all
export interface ShardDb {
	all(orgId: string, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
	batch(orgId: string, statements: { sql: string; params: unknown[] }[]): Promise<void>;
}

export function shardDbOf(db: CollegeDBClient): ShardDb {
	return {
		async all(orgId, sql, params = []) {
			const { results } = await db.all<Record<string, unknown>>(orgId, sql, params);
			return results;
		},
		async batch(orgId, statements) {
			const groups = await db.batch(
				statements.map((s) => ({ key: orgId, sql: s.sql, bindings: s.params }))
			);
			for (const group of groups) {
				if (group.error !== undefined)
					throw new Error(`a shard batch failed: ${group.error}`);
			}
		}
	};
}

export interface MovedTable {
	table: string;
	// the column that names the site
	site: string;
	// the column that names the organisation; null for a table keyed by the site alone
	org: string | null;
	pk: string[];
}

// the control-plane rows that follow a site; the order is the order of the copy
export const MOVED_TABLES: readonly MovedTable[] = [
	{ table: 'sites', site: 'id', org: 'organization_id', pk: ['id'] },
	{ table: 'site_resources', site: 'site_id', org: null, pk: ['id'] },
	{ table: 'site_environments', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'site_access_rules', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'backups', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'site_config_changes', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'site_revisions', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'site_discovery', site: 'site_id', org: null, pk: ['site_id'] },
	{ table: 'custom_domains', site: 'site_id', org: 'organization_id', pk: ['hostname'] },
	{ table: 'site_strata', site: 'site_id', org: 'organization_id', pk: ['site_id'] },
	{
		table: 'usage_intervals',
		site: 'site_id',
		org: 'organization_id',
		pk: ['site_id', 'hour_start']
	},
	{ table: 'usage_adjustments', site: 'site_id', org: 'organization_id', pk: ['id'] },
	{ table: 'budget_states', site: 'site_id', org: null, pk: ['site_id'] },
	{ table: 'site_grants', site: 'site_id', org: 'organization_id', pk: ['id'] }
];

// the columns of a site row that belong to the old organisation and are cleared on the move
const SITE_CLEARED = ['cost_center_id', 'department_id', 'technical_owner', 'business_owner'];
// the columns a flip rewrites on the site row, so a read back does not compare them
const SITE_FLIPPED = ['state', 'updated_at', ...SITE_CLEARED];

const CHUNK = 50;
const IDENT = /^[a-z_][a-z0-9_]*$/;

export interface MoveRequest {
	transferId: string;
	siteId: string;
	fromOrgId: string;
	toOrgId: string;
}

export interface Incoming {
	siteState: string | null;
	epochBefore: number | null;
}

export type Mismatch = { table: string; key: string; reason: 'missing' | 'different' };

export interface SiteMoves {
	// the transfer row, held by the sender, says both sides agreed
	accepted(request: MoveRequest): Promise<boolean>;
	// writes the marker row in the target shard and returns what it holds
	begin(request: MoveRequest, now: number, epochBefore: number | null): Promise<Incoming>;
	incoming(request: MoveRequest): Promise<Incoming | null>;
	// both organisations share one database, so the rows are already in one place
	sameShard(request: MoveRequest): Promise<boolean>;
	// a different row already holding a hostname of the site in the target shard
	collisions(request: MoveRequest): Promise<string[]>;
	copy(request: MoveRequest): Promise<{ rows: number }>;
	flip(request: MoveRequest, now: number): Promise<void>;
	flipped(request: MoveRequest): Promise<boolean>;
	// the hostnames the site answers on, read from the flipped row
	hostnames(request: MoveRequest): Promise<string[]>;
	compare(request: MoveRequest): Promise<Mismatch[]>;
	retire(request: MoveRequest, now: number): Promise<{ rows: number }>;
	// the same marker without any delete, for two organisations on one database
	tombstone(request: MoveRequest, now: number): Promise<void>;
	tombstoned(request: MoveRequest): Promise<boolean>;
	// the transfer row lives with the source organisation
	complete(request: MoveRequest, now: number): Promise<void>;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function whereOf(spec: MovedTable, request: MoveRequest): { sql: string; params: unknown[] } {
	return spec.org === null
		? { sql: `${spec.site} = ?`, params: [request.siteId] }
		: {
				sql: `${spec.site} = ? AND ${spec.org} = ?`,
				params: [request.siteId, request.fromOrgId]
			};
}

function keyOf(spec: MovedTable, row: Record<string, unknown>): string {
	return spec.pk.map((column) => String(row[column])).join('|');
}

// a row as the target should hold it: the organisation and the columns a flip rewrites are left out
function normalised(spec: MovedTable, row: Record<string, unknown>): string {
	const skip = new Set<string>([...(spec.org === null ? [] : [spec.org])]);
	if (spec.table === 'sites') for (const column of SITE_FLIPPED) skip.add(column);
	return canonicalJson(
		Object.fromEntries(Object.entries(row).filter(([name]) => !skip.has(name)))
	);
}

function tombstoneStatement(request: MoveRequest, now: number) {
	return {
		sql: `INSERT OR IGNORE INTO site_moves (transfer_id, role, organization_id, site_id,
			from_organization_id, to_organization_id, site_state, epoch_before, created_at)
			VALUES (?, 'tombstone', ?, ?, ?, ?, NULL, NULL, ?)`,
		params: [
			request.transferId,
			request.fromOrgId,
			request.siteId,
			request.fromOrgId,
			request.toOrgId,
			now
		]
	};
}

export function siteMovesOf(shards: ShardDb): SiteMoves {
	async function sourceRows(spec: MovedTable, request: MoveRequest, org = request.fromOrgId) {
		const where = whereOf(spec, request);
		const rows = await shards.all(
			org,
			`SELECT * FROM ${spec.table} WHERE ${where.sql}${spec.table === 'site_grants' ? ' AND revoked_at IS NULL' : ''}`,
			where.params
		);
		return spec.table === 'site_grants' ? stayingGrants(rows, request) : rows;
	}

	// a grant stays only for a person who is a member of the receiving organisation
	async function stayingGrants(rows: Record<string, unknown>[], request: MoveRequest) {
		const found = await shards.all(
			request.toOrgId,
			'SELECT user_id FROM members WHERE organization_id = ?',
			[request.toOrgId]
		);
		const known = new Set(found.map((row) => String(row.user_id)));
		return rows.filter((row) => known.has(String(row.user_id)));
	}

	const sameShard: SiteMoves['sameShard'] = async (request) => {
		const seen = await shards.all(
			request.fromOrgId,
			`SELECT 1 AS found FROM site_moves WHERE transfer_id = ? AND role = 'incoming'`,
			[request.transferId]
		);
		return seen.length > 0;
	};

	const incoming: SiteMoves['incoming'] = async (request) => {
		const rows = await shards.all(
			request.toOrgId,
			`SELECT site_state, epoch_before FROM site_moves WHERE transfer_id = ? AND role = 'incoming'`,
			[request.transferId]
		);
		const row = rows[0];
		if (row === undefined) return null;
		return {
			siteState: text(row.site_state),
			epochBefore: typeof row.epoch_before === 'number' ? row.epoch_before : null
		};
	};

	return {
		incoming,
		sameShard,

		async accepted(request) {
			const rows = await shards.all(
				request.fromOrgId,
				`SELECT 1 AS found FROM site_transfers
				 WHERE id = ? AND organization_id = ? AND to_organization_id = ? AND site_id = ?
				 AND state IN ('accepted', 'completed')`,
				[request.transferId, request.fromOrgId, request.toOrgId, request.siteId]
			);
			return rows.length > 0;
		},

		async begin(request, now, epochBefore) {
			const held = await incoming(request);
			if (held !== null) return held;
			const sites = MOVED_TABLES[0]!;
			const [site] = await sourceRows(sites, request);
			if (site === undefined) {
				throw new PermanentError(
					'site_missing',
					`${request.siteId} is not held by the sender`
				);
			}
			const siteState = text(site.state);
			await shards.batch(request.toOrgId, [
				{
					sql: `INSERT OR IGNORE INTO site_moves (transfer_id, role, organization_id, site_id,
						from_organization_id, to_organization_id, site_state, epoch_before, created_at)
						VALUES (?, 'incoming', ?, ?, ?, ?, ?, ?, ?)`,
					params: [
						request.transferId,
						request.toOrgId,
						request.siteId,
						request.fromOrgId,
						request.toOrgId,
						siteState,
						epochBefore,
						now
					]
				}
			]);
			return { siteState, epochBefore };
		},

		async collisions(request) {
			const found: string[] = [];
			const domains = await shards.all(
				request.fromOrgId,
				'SELECT hostname FROM custom_domains WHERE site_id = ? AND organization_id = ?',
				[request.siteId, request.fromOrgId]
			);
			for (const row of domains) {
				const held = await shards.all(
					request.toOrgId,
					'SELECT site_id FROM custom_domains WHERE hostname = ?',
					[row.hostname]
				);
				// a row of this same site is an earlier copy of this move
				if (held.some((other) => other.site_id !== request.siteId)) {
					found.push(String(row.hostname));
				}
			}
			return found;
		},

		async copy(request) {
			let rows = 0;
			for (const spec of MOVED_TABLES) {
				const found = await sourceRows(spec, request);
				const inserts = found.map((row) => {
					const copy = { ...row };
					// the copy stays hidden until the flip: a deleted site is in no list
					if (spec.table === 'sites') copy.state = 'deleted';
					const columns = Object.keys(copy);
					if (!columns.every((name) => IDENT.test(name))) {
						throw new PermanentError(
							'bad_column',
							`${spec.table} has an unexpected column`
						);
					}
					return {
						sql: `INSERT OR IGNORE INTO ${spec.table} (${columns.join(', ')})
							VALUES (${columns.map(() => '?').join(', ')})`,
						params: columns.map((name) => copy[name])
					};
				});
				for (let at = 0; at < inserts.length; at += CHUNK) {
					await shards.batch(request.toOrgId, inserts.slice(at, at + CHUNK));
				}
				rows += inserts.length;
			}
			return { rows };
		},

		async flip(request, now) {
			const held = await incoming(request);
			if (held === null) {
				throw new PermanentError('not_copied', `${request.siteId} was not copied first`);
			}
			const statements: { sql: string; params: unknown[] }[] = [];
			for (const spec of MOVED_TABLES) {
				if (spec.org === null) continue;
				if (spec.table === 'sites') {
					statements.push({
						sql: `UPDATE sites SET organization_id = ?, state = ?,
							${SITE_CLEARED.map((column) => `${column} = NULL`).join(', ')}, updated_at = ?
							WHERE id = ? AND organization_id = ?`,
						params: [
							request.toOrgId,
							held.siteState ?? 'active',
							now,
							request.siteId,
							request.fromOrgId
						]
					});
					continue;
				}
				statements.push({
					sql: `UPDATE ${spec.table} SET ${spec.org} = ? WHERE ${spec.site} = ? AND ${spec.org} = ?`,
					params: [request.toOrgId, request.siteId, request.fromOrgId]
				});
			}
			await shards.batch(request.toOrgId, statements);
		},

		async flipped(request) {
			const rows = await shards.all(
				request.toOrgId,
				'SELECT state FROM sites WHERE id = ? AND organization_id = ?',
				[request.siteId, request.toOrgId]
			);
			return rows.length > 0 && rows[0]!.state !== 'deleted';
		},

		async hostnames(request) {
			const names: string[] = [];
			const site = await shards.all(
				request.toOrgId,
				'SELECT primary_hostname FROM sites WHERE id = ? AND organization_id = ?',
				[request.siteId, request.toOrgId]
			);
			const primary = text(site[0]?.primary_hostname);
			if (primary !== null) names.push(primary);
			const domains = await shards.all(
				request.toOrgId,
				`SELECT hostname FROM custom_domains
				 WHERE site_id = ? AND organization_id = ? AND state = 'routed'`,
				[request.siteId, request.toOrgId]
			);
			for (const row of domains) names.push(String(row.hostname));
			return names;
		},

		async compare(request) {
			const mismatches: Mismatch[] = [];
			for (const spec of MOVED_TABLES) {
				const source = await sourceRows(spec, request);
				if (source.length === 0) continue;
				const where = whereOf(spec, { ...request, fromOrgId: request.toOrgId });
				const target = await shards.all(
					request.toOrgId,
					`SELECT * FROM ${spec.table} WHERE ${where.sql}`,
					where.params
				);
				const held = new Map(
					target.map((row) => [keyOf(spec, row), normalised(spec, row)])
				);
				for (const row of source) {
					const key = keyOf(spec, row);
					const other = held.get(key);
					if (other === undefined)
						mismatches.push({ table: spec.table, key, reason: 'missing' });
					else if (other !== normalised(spec, row)) {
						mismatches.push({ table: spec.table, key, reason: 'different' });
					}
				}
			}
			return mismatches;
		},

		async retire(request, now) {
			// one database holds the live rows too, so a delete there would take the site itself
			if (await sameShard(request)) {
				throw new PermanentError('same_shard', 'both organisations share one database');
			}
			let rows = 0;
			const statements: { sql: string; params: unknown[] }[] = [];
			for (const spec of [...MOVED_TABLES].reverse()) {
				const where = whereOf(spec, request);
				const found = await shards.all(
					request.fromOrgId,
					`SELECT COUNT(*) AS n FROM ${spec.table} WHERE ${where.sql}`,
					where.params
				);
				rows += Number(found[0]?.n ?? 0);
				statements.push({
					sql: `DELETE FROM ${spec.table} WHERE ${where.sql}`,
					params: where.params
				});
			}
			// the tombstone lands in the same batch as the deletes, so one never exists without the other
			statements.push(tombstoneStatement(request, now));
			await shards.batch(request.fromOrgId, statements);
			return { rows };
		},

		async tombstone(request, now) {
			await shards.batch(request.fromOrgId, [tombstoneStatement(request, now)]);
		},

		async tombstoned(request) {
			const rows = await shards.all(
				request.fromOrgId,
				`SELECT 1 AS found FROM site_moves WHERE transfer_id = ? AND role = 'tombstone'`,
				[request.transferId]
			);
			return rows.length > 0;
		},

		async complete(request, now) {
			await shards.batch(request.fromOrgId, [
				{
					sql: `UPDATE site_transfers SET state = 'completed', completed_at = ?
						WHERE id = ? AND state = 'accepted'`,
					params: [now, request.transferId]
				}
			]);
		}
	};
}
