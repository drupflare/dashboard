import type { CollegeDBClient } from '@earth-app/collegedb';
import type { Transfer, TransferState, TransferStep } from '../../domain/transfer';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';
import {
	DELEGATION_COLUMNS,
	toDelegation,
	type Delegation,
	type DelegationRow
} from './organization';

// the other side's rows live in another shard, so a read by that side asks every shard
export class ShardReadError extends Error {
	readonly code = 'SHARD_READ_FAILED';

	constructor() {
		super('a shard did not answer the read');
		this.name = 'ShardReadError';
	}
}

async function everyShard<T>(db: CollegeDBClient, sql: string, params: unknown[]): Promise<T[]> {
	const shards = await db.allAllShards<T>(sql, params);
	const rows: T[] = [];
	for (const shard of shards) {
		if (!shard.success) throw new ShardReadError();
		rows.push(...shard.results);
	}
	return rows;
}

// #region delegations

export async function listDelegationsSent(
	db: CollegeDBClient,
	clientOrgId: string
): Promise<Delegation[]> {
	const { results } = await db.all<DelegationRow>(
		clientOrgId,
		`SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE organization_id = ?
		 ORDER BY created_at, id`,
		[clientOrgId]
	);
	return results.map(toDelegation);
}

export async function listDelegationsReceived(
	db: CollegeDBClient,
	agencyOrgId: string
): Promise<Delegation[]> {
	const rows = await everyShard<DelegationRow>(
		db,
		`SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE agency_organization_id = ?
		 ORDER BY created_at, id`,
		[agencyOrgId]
	);
	return rows.map(toDelegation);
}

// every row of one batch, found by its batch id alone; the rows name the client shard to write to
export async function findDelegationBatch(
	db: CollegeDBClient,
	batchId: string
): Promise<Delegation[]> {
	const rows = await everyShard<DelegationRow>(
		db,
		`SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE batch_id = ? ORDER BY created_at, id`,
		[batchId]
	);
	return rows.map(toDelegation);
}

export async function acceptDelegationBatch(
	db: CollegeDBClient,
	clientOrgId: string,
	batchId: string,
	acceptedBy: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		clientOrgId,
		`UPDATE delegations SET state = 'active', accepted_by = ?, updated_at = ?
		 WHERE organization_id = ? AND batch_id = ? AND state = 'pending'`,
		[acceptedBy, now, clientOrgId, batchId]
	);
	return wasChanged(result);
}

export async function revokeDelegationBatch(
	db: CollegeDBClient,
	clientOrgId: string,
	batchId: string,
	now: number
): Promise<boolean> {
	const result = await db.run(
		clientOrgId,
		`UPDATE delegations SET state = 'revoked', revoked_at = ?, updated_at = ?
		 WHERE organization_id = ? AND batch_id = ? AND state IN ('pending', 'active')`,
		[now, now, clientOrgId, batchId]
	);
	return wasChanged(result);
}

// #endregion

// #region transfers

interface TransferRow {
	id: string;
	organization_id: string;
	to_organization_id: string;
	site_id: string;
	state: TransferState;
	keep_delegation_id: string | null;
	proposed_by: string;
	proposed_at: number;
	expires_at: number;
	decided_by: string | null;
	decided_at: number | null;
}

const TRANSFER_COLUMNS = `id, organization_id, to_organization_id, site_id, state,
	keep_delegation_id, proposed_by, proposed_at, expires_at, decided_by, decided_at`;

function toTransfer(row: TransferRow): Transfer {
	return {
		id: row.id,
		siteId: row.site_id,
		fromOrgId: row.organization_id,
		toOrgId: row.to_organization_id,
		state: row.state,
		keepDelegationId: row.keep_delegation_id,
		proposedBy: row.proposed_by,
		proposedAt: row.proposed_at,
		expiresAt: row.expires_at,
		decidedBy: row.decided_by,
		decidedAt: row.decided_at
	};
}

// a second open proposal for the same site hits the unique index and comes back as a duplicate
export async function insertTransfer(db: CollegeDBClient, t: Transfer): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			t.fromOrgId,
			`INSERT INTO site_transfers (${TRANSFER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
			[
				t.id,
				t.fromOrgId,
				t.toOrgId,
				t.siteId,
				t.state,
				t.keepDelegationId,
				t.proposedBy,
				t.proposedAt,
				t.expiresAt
			]
		)
	);
}

export async function listTransfersOut(
	db: CollegeDBClient,
	fromOrgId: string
): Promise<Transfer[]> {
	const { results } = await db.all<TransferRow>(
		fromOrgId,
		`SELECT ${TRANSFER_COLUMNS} FROM site_transfers WHERE organization_id = ?
		 ORDER BY proposed_at DESC, id`,
		[fromOrgId]
	);
	return results.map(toTransfer);
}

export async function listTransfersIn(db: CollegeDBClient, toOrgId: string): Promise<Transfer[]> {
	const rows = await everyShard<TransferRow>(
		db,
		`SELECT ${TRANSFER_COLUMNS} FROM site_transfers WHERE to_organization_id = ?
		 ORDER BY proposed_at DESC, id`,
		[toOrgId]
	);
	return rows.map(toTransfer);
}

export async function findTransfer(db: CollegeDBClient, id: string): Promise<Transfer | null> {
	const rows = await everyShard<TransferRow>(
		db,
		`SELECT ${TRANSFER_COLUMNS} FROM site_transfers WHERE id = ?`,
		[id]
	);
	const row = rows[0];
	return row ? toTransfer(row) : null;
}

export async function stepsDone(db: CollegeDBClient, t: Transfer): Promise<TransferStep[]> {
	const { results } = await db.all<{ step: TransferStep }>(
		t.fromOrgId,
		`SELECT step FROM site_transfer_steps WHERE organization_id = ? AND transfer_id = ?`,
		[t.fromOrgId, t.id]
	);
	return results.map((row) => row.step);
}

// a repeat of a recorded step is ignored, so a completion that is resumed can replay its moves
export async function recordStep(
	db: CollegeDBClient,
	t: Transfer,
	step: TransferStep,
	doneAt: number
): Promise<void> {
	await db.run(
		t.fromOrgId,
		`INSERT OR IGNORE INTO site_transfer_steps (organization_id, transfer_id, step, done_at)
		 VALUES (?, ?, ?, ?)`,
		[t.fromOrgId, t.id, step, doneAt]
	);
}

// the engine run of a completion; its idempotency key names the transfer and the attempt
export interface TransferRun {
	id: string;
	status: string;
	version: number;
	attempt: number;
	summary: string | null;
}

export const transferRunKey = (transferId: string, attempt: number) =>
	`transfer:${transferId}:${attempt}`;

export async function latestTransferRun(
	db: CollegeDBClient,
	fromOrgId: string,
	transferId: string
): Promise<TransferRun | null> {
	const prefix = `transfer:${transferId}:`;
	const { results } = await db.all<{
		id: string;
		status: string;
		version: number;
		idempotency_key: string;
		final_observation: string | null;
	}>(
		fromOrgId,
		`SELECT id, status, version, idempotency_key, final_observation FROM operations
		 WHERE organization_id = ? AND type = 'site.transfer' AND idempotency_key LIKE ?
		 ORDER BY created_at DESC, id DESC`,
		[fromOrgId, `${prefix}%`]
	);
	const attemptOf = (row: { idempotency_key: string }) =>
		Number(row.idempotency_key.slice(prefix.length));
	const rows = results
		.filter((row) => row.idempotency_key.startsWith(prefix))
		.sort((a, b) => attemptOf(b) - attemptOf(a));
	const row = rows[0];
	if (row === undefined) return null;
	const summary = row.final_observation
		? ((JSON.parse(row.final_observation) as { summary?: string }).summary ?? null)
		: null;
	return {
		id: row.id,
		status: row.status,
		version: row.version,
		attempt: attemptOf(row),
		summary
	};
}

// a hostname of the site that the receiving organisation already holds for another site
export async function transferHostnameCollisions(
	db: CollegeDBClient,
	fromOrgId: string,
	toOrgId: string,
	siteId: string
): Promise<string[]> {
	const { results } = await db.all<{ hostname: string }>(
		fromOrgId,
		'SELECT hostname FROM custom_domains WHERE organization_id = ? AND site_id = ?',
		[fromOrgId, siteId]
	);
	const found: string[] = [];
	for (const { hostname } of results) {
		const held = await db.first<{ site_id: string }>(
			toOrgId,
			'SELECT site_id FROM custom_domains WHERE hostname = ? AND site_id <> ?',
			[hostname, siteId]
		);
		if (held !== null) found.push(hostname);
	}
	return found;
}

// the write names the state it expects, so two answers to one proposal cannot both land
export async function saveTransferState(
	db: CollegeDBClient,
	t: Transfer,
	from: TransferState,
	completedAt: number | null
): Promise<boolean> {
	const result = await db.run(
		t.fromOrgId,
		`UPDATE site_transfers SET state = ?, decided_by = ?, decided_at = ?, completed_at = ?
		 WHERE organization_id = ? AND id = ? AND state = ?`,
		[t.state, t.decidedBy, t.decidedAt, completedAt, t.fromOrgId, t.id, from]
	);
	return wasChanged(result);
}

// #endregion

// #region client workspaces

export interface ClientWorkspaceRecord {
	id: string;
	organizationId: string;
	name: string;
	contactName: string | null;
	contactEmail: string | null;
	notes: string | null;
	contractNotes: string | null;
	createdAt: number;
	updatedAt: number;
}

interface WorkspaceRow {
	id: string;
	organization_id: string;
	name: string;
	contact_name: string | null;
	contact_email: string | null;
	notes: string | null;
	contract_notes: string | null;
	created_at: number;
	updated_at: number;
}

const WORKSPACE_COLUMNS = `id, organization_id, name, contact_name, contact_email, notes,
	contract_notes, created_at, updated_at`;

function toWorkspace(row: WorkspaceRow): ClientWorkspaceRecord {
	return {
		id: row.id,
		organizationId: row.organization_id,
		name: row.name,
		contactName: row.contact_name,
		contactEmail: row.contact_email,
		notes: row.notes,
		contractNotes: row.contract_notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function insertWorkspace(
	db: CollegeDBClient,
	w: ClientWorkspaceRecord
): Promise<void> {
	await db.run(
		w.organizationId,
		`INSERT INTO client_workspaces (${WORKSPACE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			w.id,
			w.organizationId,
			w.name,
			w.contactName,
			w.contactEmail,
			w.notes,
			w.contractNotes,
			w.createdAt,
			w.updatedAt
		]
	);
}

export async function getWorkspace(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<ClientWorkspaceRecord | null> {
	const row = await db.first<WorkspaceRow>(
		orgId,
		`SELECT ${WORKSPACE_COLUMNS} FROM client_workspaces WHERE organization_id = ? AND id = ?`,
		[orgId, id]
	);
	return row ? toWorkspace(row) : null;
}

export async function listWorkspaces(
	db: CollegeDBClient,
	orgId: string
): Promise<ClientWorkspaceRecord[]> {
	const { results } = await db.all<WorkspaceRow>(
		orgId,
		`SELECT ${WORKSPACE_COLUMNS} FROM client_workspaces WHERE organization_id = ?
		 ORDER BY created_at, id`,
		[orgId]
	);
	return results.map(toWorkspace);
}

export async function updateWorkspace(
	db: CollegeDBClient,
	w: ClientWorkspaceRecord
): Promise<void> {
	await db.run(
		w.organizationId,
		`UPDATE client_workspaces SET name = ?, contact_name = ?, contact_email = ?, notes = ?,
		 contract_notes = ?, updated_at = ? WHERE organization_id = ? AND id = ?`,
		[
			w.name,
			w.contactName,
			w.contactEmail,
			w.notes,
			w.contractNotes,
			w.updatedAt,
			w.organizationId,
			w.id
		]
	);
}

export async function deleteWorkspace(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<void> {
	await db.run(
		orgId,
		'DELETE FROM client_workspace_sites WHERE organization_id = ? AND workspace_id = ?',
		[orgId, id]
	);
	await db.run(orgId, 'DELETE FROM client_workspaces WHERE organization_id = ? AND id = ?', [
		orgId,
		id
	]);
}

export async function listWorkspaceSites(
	db: CollegeDBClient,
	orgId: string
): Promise<{ workspaceId: string; siteId: string }[]> {
	const { results } = await db.all<{ workspace_id: string; site_id: string }>(
		orgId,
		`SELECT workspace_id, site_id FROM client_workspace_sites WHERE organization_id = ?
		 ORDER BY created_at, site_id`,
		[orgId]
	);
	return results.map((row) => ({ workspaceId: row.workspace_id, siteId: row.site_id }));
}

// a site sits under one client at a time; the primary key on (organisation, site) holds that
export async function addWorkspaceSite(
	db: CollegeDBClient,
	orgId: string,
	workspaceId: string,
	siteId: string,
	now: number
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			orgId,
			`INSERT INTO client_workspace_sites (organization_id, workspace_id, site_id, created_at)
			 VALUES (?, ?, ?, ?)`,
			[orgId, workspaceId, siteId, now]
		)
	);
}

export async function removeWorkspaceSite(
	db: CollegeDBClient,
	orgId: string,
	workspaceId: string,
	siteId: string
): Promise<boolean> {
	const result = await db.run(
		orgId,
		`DELETE FROM client_workspace_sites WHERE organization_id = ? AND workspace_id = ?
		 AND site_id = ?`,
		[orgId, workspaceId, siteId]
	);
	return wasChanged(result);
}

// #endregion
