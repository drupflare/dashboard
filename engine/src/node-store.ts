import type { D1Database } from '@cloudflare/workers-types';
import { MAX_SITE_MAP } from '@contracts/fleet-link';
import type { HostFacts, NodeState, NodeUpdate, SiteMapRow } from '../../src/server/domain/fleet';

export const NODE_COLUMNS = `id, organization_id, public_key, host_facts, state, paired_at,
	last_seen_at, last_audit_head, last_envelope_seq, revoked_at`;

export interface NodeRow {
	id: string;
	organization_id: string;
	public_key: string;
	host_facts: string;
	state: NodeState;
	paired_at: number;
	last_seen_at: number | null;
	last_audit_head: string | null;
	last_envelope_seq: number;
	revoked_at: number | null;
}

export interface NodeRecord {
	id: string;
	orgId: string;
	publicKey: string;
	hostFacts: HostFacts;
	state: NodeState;
	pairedAt: number;
	lastSeenAt: number | null;
	lastAuditHead: { seq: number; hash: string } | null;
	lastEnvelopeSeq: number;
	revokedAt: number | null;
}

function parseJson<T>(text: string | null): T | null {
	if (text === null) return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

export function toNodeRecord(row: NodeRow): NodeRecord {
	return {
		id: row.id,
		orgId: row.organization_id,
		publicKey: row.public_key,
		hostFacts: parseJson<HostFacts>(row.host_facts) ?? ({} as HostFacts),
		state: row.state,
		pairedAt: row.paired_at,
		lastSeenAt: row.last_seen_at,
		lastAuditHead: parseJson<{ seq: number; hash: string }>(row.last_audit_head),
		lastEnvelopeSeq: row.last_envelope_seq,
		revokedAt: row.revoked_at
	};
}

export interface NodeStore {
	get(id: string): Promise<NodeRecord | null>;
	// records a message the link accepted; a revoked node's row is left alone
	touch(id: string, update: NodeUpdate): Promise<void>;
	// the self-hosted sites with a hostname that are bound to this node; the organization's unbound
	// ones stand in only when none is bound
	sites(orgId: string, nodeId: string): Promise<SiteMapRow[]>;
}

// a site that is gone no longer reports usage; a suspended one still serves, so it stays
const LIVE_SITE_STATES = `'active', 'suspended'`;

export class D1NodeStore implements NodeStore {
	constructor(private readonly db: D1Database) {}

	async get(id: string): Promise<NodeRecord | null> {
		const row = await this.db
			.prepare(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`)
			.bind(id)
			.first<NodeRow>();
		return row ? toNodeRecord(row) : null;
	}

	async sites(orgId: string, nodeId: string): Promise<SiteMapRow[]> {
		const bound = await this.siteRows('node_id = ?', [orgId, nodeId]);
		return bound.length > 0 ? bound : this.siteRows('node_id IS NULL', [orgId]);
	}

	private async siteRows(binding: string, binds: string[]): Promise<SiteMapRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT organization_id, id, primary_hostname FROM sites
				 WHERE organization_id = ? AND plane = 'self-hosted' AND primary_hostname IS NOT NULL
					AND ready_at IS NOT NULL AND state IN (${LIVE_SITE_STATES}) AND ${binding}
				 ORDER BY id LIMIT ?`
			)
			.bind(...binds, MAX_SITE_MAP + 1)
			.all<{ organization_id: string; id: string; primary_hostname: string }>();
		return results.map((row) => ({
			orgId: row.organization_id,
			siteId: row.id,
			host: row.primary_hostname
		}));
	}

	async touch(id: string, update: NodeUpdate): Promise<void> {
		await this.db
			.prepare(
				`UPDATE nodes SET last_seen_at = ?,
					last_envelope_seq = MAX(last_envelope_seq, ?),
					host_facts = COALESCE(?, host_facts),
					last_audit_head = COALESCE(?, last_audit_head)
				 WHERE id = ? AND state = 'active'`
			)
			.bind(
				update.seenAt,
				update.seq,
				update.hostFacts === undefined ? null : JSON.stringify(update.hostFacts),
				update.auditHead === undefined ? null : JSON.stringify(update.auditHead),
				id
			)
			.run();
	}
}
