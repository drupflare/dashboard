import type { D1Database } from '@cloudflare/workers-types';
import type { CommandRequest } from '../../../src/server/domain/fleet';
import type { CommandStatus, SendResult } from '../node-link';
import type { NodeStore } from '../node-store';
import type { NodeCommands, NodeSites } from '../ports';

export interface NodeSessionStub {
	sendCommand(nodeId: string, request: CommandRequest): Promise<SendResult>;
	commandStatus(ref: {
		opId: string;
		stepId: string;
		idempotencyKey: string;
	}): Promise<CommandStatus>;
}

export function nodeCommandsOf(
	session: (nodeId: string) => NodeSessionStub,
	store: Pick<NodeStore, 'get'>
): NodeCommands {
	return {
		async node(nodeId) {
			const record = await store.get(nodeId);
			return record === null
				? null
				: {
						id: record.id,
						orgId: record.orgId,
						state: record.state,
						lastSeenAt: record.lastSeenAt
					};
		},
		send: (nodeId, request) => session(nodeId).sendCommand(nodeId, request),
		status: (nodeId, ref) => session(nodeId).commandStatus(ref)
	};
}

export class D1NodeSites implements NodeSites {
	constructor(private readonly db: D1Database) {}

	async get(siteId: string) {
		const row = await this.db
			.prepare(
				'SELECT organization_id, plane, state, ready_at, node_id FROM sites WHERE id = ?'
			)
			.bind(siteId)
			.first<{
				organization_id: string;
				plane: 'managed' | 'self-managed' | 'self-hosted';
				state: 'active' | 'suspended' | 'tombstoned' | 'purge-eligible' | 'deleted';
				ready_at: number | null;
				node_id: string | null;
			}>();
		return row === null
			? null
			: {
					organizationId: row.organization_id,
					plane: row.plane,
					state: row.state,
					readyAt: row.ready_at,
					nodeId: row.node_id
				};
	}

	async bind(siteId: string, nodeId: string, releaseId: string, now: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE sites SET node_id = ?, release_id = ?, state = 'active',
				ready_at = COALESCE(ready_at, ?), updated_at = ? WHERE id = ?`
			)
			.bind(nodeId, releaseId, now, now, siteId)
			.run();
	}

	async retire(siteId: string, now: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE sites SET state = 'deleted', updated_at = ?
				WHERE id = ? AND ready_at IS NULL`
			)
			.bind(now, siteId)
			.run();
	}
}
