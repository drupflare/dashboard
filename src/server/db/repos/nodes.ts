import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	NODE_COLUMNS,
	toNodeRecord,
	type NodeRecord,
	type NodeRow
} from '../../../../engine/src/node-store';
import type { HostFacts, Pairing, PairingState } from '../../domain/fleet';
import { DIRECTORY_KEY, uniqueOrDuplicate, wasChanged } from '../collegedb';

export type { NodeRecord };

interface PairingRow {
	id: string;
	organization_id: string;
	claim_token_hash: string;
	state: PairingState;
	created_at: number;
	expires_at: number;
	claimed_node_id: string | null;
}

const PAIRING_COLUMNS = `id, organization_id, claim_token_hash, state, created_at, expires_at,
	claimed_node_id`;

const toPairing = (row: PairingRow): Pairing => ({
	id: row.id,
	orgId: row.organization_id,
	claimTokenHash: row.claim_token_hash,
	state: row.state,
	createdAt: row.created_at,
	expiresAt: row.expires_at,
	claimedNodeId: row.claimed_node_id
});

// #region pairings

// a box presents only a claim token, which names no organisation, so pairings share the directory
// shard and are found by the hash of the token
export async function insertPairing(
	db: CollegeDBClient,
	pairing: Pairing,
	createdBy: string
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO pairings (id, organization_id, claim_token_hash, state, created_by, created_at,
				expires_at, claimed_node_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
			[
				pairing.id,
				pairing.orgId,
				pairing.claimTokenHash,
				pairing.state,
				createdBy,
				pairing.createdAt,
				pairing.expiresAt
			]
		)
	);
}

export async function findPairingByHash(
	db: CollegeDBClient,
	claimTokenHash: string
): Promise<Pairing | null> {
	const row = await db.first<PairingRow>(
		DIRECTORY_KEY,
		`SELECT ${PAIRING_COLUMNS} FROM pairings WHERE claim_token_hash = ?`,
		[claimTokenHash]
	);
	return row ? toPairing(row) : null;
}

// one writer wins: the row has to be pending and inside its expiry at the moment of the write
export async function markPairingClaimed(
	db: CollegeDBClient,
	pairingId: string,
	nodeId: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		`UPDATE pairings SET state = 'claimed', claimed_node_id = ?
		 WHERE id = ? AND state = 'pending' AND expires_at > ?`,
		[nodeId, pairingId, now]
	);
	return wasChanged(result);
}

// puts a pairing back when the node row could not be written, so the box can try again
export async function releasePairing(
	db: CollegeDBClient,
	pairingId: string,
	nodeId: string
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		`UPDATE pairings SET state = 'pending', claimed_node_id = NULL
		 WHERE id = ? AND state = 'claimed' AND claimed_node_id = ?`,
		[pairingId, nodeId]
	);
	return wasChanged(result);
}

// #endregion

// #region nodes

export interface NewNode {
	id: string;
	orgId: string;
	publicKey: string;
	hostFacts: HostFacts;
	now: number;
}

export async function insertNode(db: CollegeDBClient, node: NewNode): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			node.orgId,
			`INSERT INTO nodes (id, organization_id, public_key, host_facts, state, paired_at,
				last_seen_at, last_audit_head, last_envelope_seq, revoked_at)
				VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, -1, NULL)`,
			[node.id, node.orgId, node.publicKey, JSON.stringify(node.hostFacts), node.now]
		)
	);
}

export async function getNode(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<NodeRecord | null> {
	const row = await db.first<NodeRow>(
		orgId,
		`SELECT ${NODE_COLUMNS} FROM nodes WHERE organization_id = ? AND id = ?`,
		[orgId, id]
	);
	return row ? toNodeRecord(row) : null;
}

export async function listNodes(
	db: CollegeDBClient,
	orgId: string,
	options: { after?: string; count: number }
): Promise<NodeRecord[]> {
	const keyset = options.after === undefined ? '' : 'AND id > ?';
	const cursor = options.after === undefined ? [] : [options.after];
	const { results } = await db.all<NodeRow>(
		orgId,
		`SELECT ${NODE_COLUMNS} FROM nodes WHERE organization_id = ? ${keyset} ORDER BY id LIMIT ?`,
		[orgId, ...cursor, options.count]
	);
	return results.map(toNodeRecord);
}

// false when the node is missing or already revoked
export async function revokeNode(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`UPDATE nodes SET state = 'revoked', revoked_at = ?
		 WHERE organization_id = ? AND id = ? AND state = 'active'`,
		[now, orgId, id]
	);
	return wasChanged(result);
}

// #endregion
