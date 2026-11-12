import type { Operation } from '@contracts/operations';
import type { SiteCategory, SiteConfig, SiteKind, SitePlane } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';
import { BatchFailedError } from './accounts';

type OperationStep = Operation['steps'][number];

export interface StoredOperation {
	operation: Operation;
	version: number;
}

export interface NewOperation {
	id: string;
	organizationId: string;
	accountId: string | null;
	siteId: string | null;
	type: Operation['type'];
	status: Operation['status'];
	idempotencyKey: string;
	targetIds: string[];
	preconditions: string[];
	planDigest: string;
	blastRadius: Operation['blastRadius'];
	rollbackPoint: string | null;
	verification: Operation['verification'];
	budget: Operation['budget'];
	// the plan's steps, written with the operation so the engine finds each one by id
	steps: { id: string; name: string }[];
	// the operation this one retries
	retryOf?: string | null;
	// what the engine was started with, kept so a retry can start it again
	inputs?: unknown;
	now: number;
}

export interface NewSite {
	id: string;
	organizationId: string;
	name: string;
	kind: SiteKind;
	category: SiteCategory;
	plane: SitePlane;
	config: SiteConfig;
	primaryHostname: string | null;
	now: number;
}

interface OperationRow {
	id: string;
	organization_id: string;
	type: Operation['type'];
	status: Operation['status'];
	idempotency_key: string;
	target_ids: string;
	preconditions: string;
	plan_digest: string;
	fencing_epoch: number;
	blast_radius: string;
	rollback_point: string | null;
	cursor: string | null;
	verification: Operation['verification'];
	final_observation: string | null;
	budget: string;
	retry_of: string | null;
	created_at: number;
	updated_at: number;
	version: number;
}

interface StepRow {
	operation_id: string;
	id: string;
	name: string;
	state: OperationStep['state'];
	attempt: number;
	started_at: number | null;
	finished_at: number | null;
	error: string | null;
}

const OPERATION_COLUMNS = `id, organization_id, type, status, idempotency_key, target_ids,
	preconditions, plan_digest, fencing_epoch, blast_radius, rollback_point, cursor, verification,
	final_observation, budget, retry_of, created_at, updated_at, version`;
const STEP_COLUMNS = 'operation_id, id, name, state, attempt, started_at, finished_at, error';

const isoOf = (ms: number) => new Date(ms).toISOString();

function toStep(row: StepRow): OperationStep {
	return {
		id: row.id,
		name: row.name,
		state: row.state,
		attempt: row.attempt,
		startedAt: row.started_at === null ? null : isoOf(row.started_at),
		finishedAt: row.finished_at === null ? null : isoOf(row.finished_at),
		error: row.error
	};
}

// org ids are stored as given; personal ids do not match the contract prefix
function toStored(row: OperationRow, steps: OperationStep[]): StoredOperation {
	return {
		version: row.version,
		operation: {
			id: row.id as Operation['id'],
			orgId: row.organization_id as Operation['orgId'],
			type: row.type,
			status: row.status,
			idempotencyKey: row.idempotency_key,
			targetIds: JSON.parse(row.target_ids) as string[],
			preconditions: JSON.parse(row.preconditions) as string[],
			planDigest: row.plan_digest,
			fencingEpoch: row.fencing_epoch,
			blastRadius: JSON.parse(row.blast_radius) as Operation['blastRadius'],
			rollbackPoint: row.rollback_point,
			cursor: row.cursor,
			steps,
			verification: row.verification,
			finalObservation:
				row.final_observation === null
					? null
					: (JSON.parse(row.final_observation) as NonNullable<
							Operation['finalObservation']
						>),
			budget: JSON.parse(row.budget) as Operation['budget'],
			...(row.retry_of === null ? {} : { retryOf: row.retry_of as Operation['id'] }),
			createdAt: isoOf(row.created_at),
			updatedAt: isoOf(row.updated_at)
		}
	};
}

async function loadSteps(
	db: CollegeDBClient,
	organizationId: string,
	operationIds: string[]
): Promise<Map<string, OperationStep[]>> {
	const steps = new Map<string, OperationStep[]>();
	if (operationIds.length === 0) return steps;
	const marks = operationIds.map(() => '?').join(', ');
	const { results } = await db.all<StepRow>(
		organizationId,
		`SELECT ${STEP_COLUMNS} FROM operation_steps
		 WHERE operation_id IN (${marks}) ORDER BY operation_id, position`,
		operationIds
	);
	for (const row of results) {
		const list = steps.get(row.operation_id) ?? [];
		list.push(toStep(row));
		steps.set(row.operation_id, list);
	}
	return steps;
}

export async function getOperation(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<StoredOperation | null> {
	const row = await db.first<OperationRow>(
		organizationId,
		`SELECT ${OPERATION_COLUMNS} FROM operations WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	if (!row) return null;
	const steps = await loadSteps(db, organizationId, [id]);
	return toStored(row, steps.get(id) ?? []);
}

export async function getOperationByKey(
	db: CollegeDBClient,
	organizationId: string,
	idempotencyKey: string
): Promise<StoredOperation | null> {
	const row = await db.first<OperationRow>(
		organizationId,
		`SELECT ${OPERATION_COLUMNS} FROM operations
		 WHERE organization_id = ? AND idempotency_key = ?`,
		[organizationId, idempotencyKey]
	);
	if (!row) return null;
	const steps = await loadSteps(db, organizationId, [row.id]);
	return toStored(row, steps.get(row.id) ?? []);
}

// newest first; the cursor is the (created_at, id) of the last row of the previous page
export async function listOperationsForSite(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	options: { after?: { createdAt: number; id: string }; count: number }
): Promise<StoredOperation[]> {
	const after = options.after;
	const keyset = after ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
	const cursor = after ? [after.createdAt, after.createdAt, after.id] : [];
	const { results } = await db.all<OperationRow>(
		organizationId,
		`SELECT ${OPERATION_COLUMNS} FROM operations
		 WHERE organization_id = ? AND site_id = ? ${keyset}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[organizationId, siteId, ...cursor, options.count]
	);
	const steps = await loadSteps(
		db,
		organizationId,
		results.map((row) => row.id)
	);
	return results.map((row) => toStored(row, steps.get(row.id) ?? []));
}

// one batch on the org shard; the site row is written only if this call's operation lands
export async function createSiteOperation(
	db: CollegeDBClient,
	site: NewSite,
	operation: NewOperation
): Promise<{ operation: StoredOperation; created: boolean }> {
	const existing = await getOperationByKey(
		db,
		operation.organizationId,
		operation.idempotencyKey
	);
	if (existing) return { operation: existing, created: false };
	const org = operation.organizationId;
	const groups = await db.batch([
		{
			key: org,
			sql: `INSERT OR IGNORE INTO operations (id, organization_id, account_id, site_id, type,
				status, idempotency_key, target_ids, preconditions, plan_digest, fencing_epoch,
				blast_radius, rollback_point, cursor, verification, final_observation, budget,
				retry_of, inputs, created_at, updated_at, version)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0)`,
			bindings: [
				operation.id,
				org,
				operation.accountId,
				operation.siteId,
				operation.type,
				operation.status,
				operation.idempotencyKey,
				JSON.stringify(operation.targetIds),
				JSON.stringify(operation.preconditions),
				operation.planDigest,
				JSON.stringify(operation.blastRadius),
				operation.rollbackPoint,
				operation.verification,
				JSON.stringify(operation.budget),
				operation.retryOf ?? null,
				operation.inputs === undefined ? null : JSON.stringify(operation.inputs),
				operation.now,
				operation.now
			]
		},
		{
			key: org,
			sql: `INSERT INTO sites (id, organization_id, name, kind, category, plane, config,
				account_id, state, primary_hostname, ready_at, created_at, updated_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, NULL, ?, ?
				WHERE (SELECT id FROM operations WHERE organization_id = ? AND idempotency_key = ?) = ?`,
			bindings: [
				site.id,
				site.organizationId,
				site.name,
				site.kind,
				site.category,
				site.plane,
				site.config,
				site.primaryHostname,
				site.now,
				site.now,
				org,
				operation.idempotencyKey,
				operation.id
			]
		},
		...operation.steps.map((step, position) => ({
			key: org,
			sql: `INSERT INTO operation_steps (operation_id, id, position, name, state, attempt,
				started_at, finished_at, error)
				SELECT ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL
				WHERE (SELECT id FROM operations WHERE organization_id = ? AND idempotency_key = ?) = ?`,
			bindings: [
				operation.id,
				step.id,
				position,
				step.name,
				org,
				operation.idempotencyKey,
				operation.id
			]
		}))
	]);
	for (const group of groups) {
		if (group.error !== undefined) throw new BatchFailedError(group.shard, group.error);
	}
	const stored = await getOperationByKey(db, org, operation.idempotencyKey);
	if (!stored) throw new BatchFailedError('unknown', 'the operation is missing after the batch');
	return { operation: stored, created: stored.operation.id === operation.id };
}

// an operation of the site that has not ended; it holds the site, so another one waits
export async function findOpenSiteOperation(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<{ id: string; type: Operation['type'] } | null> {
	return db.first<{ id: string; type: Operation['type'] }>(
		organizationId,
		`SELECT id, type FROM operations
		 WHERE organization_id = ? AND site_id = ?
		 AND status IN ('planned', 'awaiting-approval', 'running', 'verifying')
		 ORDER BY created_at LIMIT 1`,
		[organizationId, siteId]
	);
}

// what the organisation's running operations already use of the change budget
export async function openBlastRadius(
	db: CollegeDBClient,
	organizationId: string
): Promise<{ destructiveSites: number; productionDeploys: number }> {
	const { results } = await db.all<{ blast_radius: string }>(
		organizationId,
		`SELECT blast_radius FROM operations
		 WHERE organization_id = ? AND status IN ('running', 'verifying')`,
		[organizationId]
	);
	const load = { destructiveSites: 0, productionDeploys: 0 };
	for (const row of results) {
		const radius = JSON.parse(row.blast_radius) as Operation['blastRadius'];
		load.destructiveSites += radius.destructiveSites;
		load.productionDeploys += radius.productionDeploys;
	}
	return load;
}

// compare-and-set: the write lands only while the row still has the version the caller read
export async function updateOperationStatus(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	expectedVersion: number,
	status: Operation['status'],
	now: number
): Promise<boolean> {
	const result = await db.run(
		organizationId,
		`UPDATE operations SET status = ?, version = version + 1, updated_at = ?
		 WHERE organization_id = ? AND id = ? AND version = ?`,
		[status, now, organizationId, id, expectedVersion]
	);
	return wasChanged(result);
}

// position is one past the last step; racing writers get a duplicate error
export async function appendOperationStep(
	db: CollegeDBClient,
	organizationId: string,
	operationId: string,
	step: { id: string; name: string; state: OperationStep['state'] }
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			organizationId,
			`INSERT INTO operation_steps (operation_id, id, position, name, state, attempt,
			 started_at, finished_at, error)
			 SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, 0, NULL, NULL, NULL
			 FROM operation_steps WHERE operation_id = ?`,
			[operationId, step.id, step.name, step.state, operationId]
		)
	);
}

// what the engine was started with; null for an operation recorded without it
export async function getOperationInputs(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<unknown> {
	const row = await db.first<{ inputs: string | null }>(
		organizationId,
		'SELECT inputs FROM operations WHERE organization_id = ? AND id = ?',
		[organizationId, id]
	);
	return row?.inputs ? (JSON.parse(row.inputs) as unknown) : null;
}

// the operations that retried this one, newest first
export async function listRetriesOf(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<StoredOperation[]> {
	const { results } = await db.all<OperationRow>(
		organizationId,
		`SELECT ${OPERATION_COLUMNS} FROM operations
		 WHERE organization_id = ? AND retry_of = ? ORDER BY created_at DESC, id DESC`,
		[organizationId, id]
	);
	const steps = await loadSteps(
		db,
		organizationId,
		results.map((row) => row.id)
	);
	return results.map((row) => toStored(row, steps.get(row.id) ?? []));
}
