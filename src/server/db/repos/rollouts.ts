import type { CollegeDBClient } from '@earth-app/collegedb';
import type { Ring } from '../../domain/cohorts';
import type { RolloutState } from '../../domain/rings';
import { DIRECTORY_KEY } from '../collegedb';

export interface RingProgressRow {
	upgraded: string[];
	failed: string[];
	reverted: string[];
	stuck: string[];
}

export interface RolloutRecord {
	id: string;
	releaseId: string;
	operationId: string;
	status: RolloutState['status'];
	state: RolloutState;
	progress: Partial<Record<Ring, RingProgressRow>>;
	firstRingAt: number | null;
	lastRingAt: number | null;
	stopRequested: boolean;
	createdAt: number;
	updatedAt: number;
}

interface Row {
	id: string;
	release_id: string;
	operation_id: string;
	status: RolloutState['status'];
	state: string;
	progress: string;
	first_ring_at: number | null;
	last_ring_at: number | null;
	stop_requested: number;
	created_at: number;
	updated_at: number;
}

const COLUMNS = `id, release_id, operation_id, status, state, progress, first_ring_at, last_ring_at,
	stop_requested, created_at, updated_at`;

const toRecord = (row: Row): RolloutRecord => ({
	id: row.id,
	releaseId: row.release_id,
	operationId: row.operation_id,
	status: row.status,
	state: JSON.parse(row.state) as RolloutState,
	progress: JSON.parse(row.progress) as RolloutRecord['progress'],
	firstRingAt: row.first_ring_at,
	lastRingAt: row.last_ring_at,
	stopRequested: row.stop_requested === 1,
	createdAt: row.created_at,
	updatedAt: row.updated_at
});

export async function createRollout(
	db: CollegeDBClient,
	input: { id: string; releaseId: string; operationId: string; state: RolloutState; now: number }
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO release_rollouts (id, release_id, operation_id, status, state, progress, previous,
			stop_requested, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', '{}', 0, ?, ?)`,
		[
			input.id,
			input.releaseId,
			input.operationId,
			input.state.status,
			JSON.stringify(input.state),
			input.now,
			input.now
		]
	);
}

export async function getRollout(db: CollegeDBClient, id: string): Promise<RolloutRecord | null> {
	const row = await db.first<Row>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM release_rollouts WHERE id = ?`,
		[id]
	);
	return row ? toRecord(row) : null;
}

// the newest rollout of each release among the ids given
export async function latestRolloutsOf(
	db: CollegeDBClient,
	releaseIds: string[]
): Promise<Map<string, RolloutRecord>> {
	const found = new Map<string, RolloutRecord>();
	for (const releaseId of releaseIds) {
		const row = await db.first<Row>(
			DIRECTORY_KEY,
			`SELECT ${COLUMNS} FROM release_rollouts WHERE release_id = ?
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
			[releaseId]
		);
		if (row) found.set(releaseId, toRecord(row));
	}
	return found;
}

export async function findRollingRollout(db: CollegeDBClient): Promise<RolloutRecord | null> {
	const row = await db.first<Row>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM release_rollouts WHERE status = 'rolling' LIMIT 1`,
		[]
	);
	return row ? toRecord(row) : null;
}

// the same test the engine runs before a repair: the site's ring has begun and the rollout is live
export async function siteInRollingRollout(db: CollegeDBClient, siteId: string): Promise<boolean> {
	const row = await db.first<{ hit: number }>(
		DIRECTORY_KEY,
		`SELECT 1 AS hit FROM release_rollouts r, json_each(r.previous) p
		 WHERE r.status = 'rolling' AND p.key = ? LIMIT 1`,
		[siteId]
	);
	return row !== null;
}

export async function requestStop(db: CollegeDBClient, id: string, now: number): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`UPDATE release_rollouts SET stop_requested = 1, updated_at = ? WHERE id = ? AND status = 'rolling'`,
		[now, id]
	);
}
