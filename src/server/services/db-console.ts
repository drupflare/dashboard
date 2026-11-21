import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { DIRECTORY_KEY } from '../db/collegedb';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import type { Principal } from '../domain/authorize';
import { CHECK_OPTIONS, maskRow } from '../domain/db-console';
import { capped, checkStatement, ROW_CAP, TIME_CAP_MS } from '../domain/sql-allow';
import { principalActor } from './owner-tokens';

export const ALL_SHARDS = 'all';
export const DIRECTORY_SHARD = 'directory';

type Row = Record<string, unknown>;

export interface ConsoleBackend {
	shards(): Promise<{ shard: string; sizeBytes: number | null }[]>;
	rows(shard: string, sql: string): Promise<Row[]>;
	plan(shard: string, sql: string): Promise<Row[]>;
	count(table: string): Promise<{ shard: string; count: number | null }[]>;
}

export interface ConsoleServices {
	db: CollegeDBClient;
	backend: ConsoleBackend;
	now: () => number;
	newId: () => string;
	timeoutMs?: number;
}

export const queryBody = z.strictObject({
	statement: z.string().min(1).max(4000),
	shard: z.string().min(1).max(64).default(DIRECTORY_SHARD),
	explain: z.boolean().default(false)
});

export const queryResultView = z.object({
	shard: z.string(),
	columns: z.array(z.string()),
	rows: z.array(z.record(z.string(), z.unknown())),
	truncated: z.boolean(),
	explain: z.boolean()
});
export type QueryResultView = z.infer<typeof queryResultView>;

export const savedQueryBody = z.strictObject({
	name: z.string().trim().min(1).max(80),
	statement: z.string().min(1).max(4000)
});

export const savedQueryView = z.object({
	id: z.string(),
	name: z.string(),
	statement: z.string(),
	createdBy: z.string(),
	createdAt: z.number()
});

// the production backend: the directory shard through its routing key, the others by binding name
export function collegeBackend(db: CollegeDBClient): ConsoleBackend {
	return {
		async shards() {
			const sizes = await db.getDatabaseSizesAllShards();
			return sizes.map((s) => ({ shard: s.shard, sizeBytes: s.success ? s.size : null }));
		},
		async rows(shard, sql) {
			if (shard === DIRECTORY_SHARD) return (await db.all<Row>(DIRECTORY_KEY, sql)).results;
			return (await db.allShard<Row>(shard, sql)).results;
		},
		async plan(shard, sql) {
			if (shard === DIRECTORY_SHARD)
				return (await db.explain<Row>(DIRECTORY_KEY, sql)).results;
			return (await db.explainShard<Row>(shard, sql)).results;
		},
		async count(table) {
			const counted = await db.countAllShards(table);
			return counted.shards.map((s) => ({
				shard: s.shard,
				count: s.success ? s.count : null
			}));
		}
	};
}

export const consoleServicesOf = (db: CollegeDBClient): ConsoleServices => ({
	db,
	backend: collegeBackend(db),
	now: () => nowUtc().toMillis(),
	newId: () => `dbq_${crypto.randomUUID()}`
});

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new ApiError('unprocessable', 'The query took too long', { reason: 'time_cap' })
				),
			ms
		);
	});
	return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export function refusal(reason: string): ApiError {
	return new ApiError('unprocessable', reason, { reason: 'statement_refused' });
}

// every statement is audited with its text, refused ones too
export async function runQuery(
	services: ConsoleServices,
	input: { statement: string; shard: string; explain: boolean; principal: Principal }
): Promise<QueryResultView[]> {
	const actor = principalActor(input.principal);
	const now = services.now();
	const verdict = checkStatement(input.statement, CHECK_OPTIONS);
	if (!verdict.ok) {
		await appendPlatformAudit(services.db, {
			actor,
			action: 'admin.db.refused',
			target: input.shard,
			detail: { statement: input.statement.slice(0, 2000), reason: verdict.reason },
			now
		});
		throw refusal(verdict.reason);
	}
	const known = await services.backend.shards();
	const names = known.map((s) => s.shard);
	let targets: string[];
	if (input.shard === ALL_SHARDS) targets = names;
	else if (input.shard === DIRECTORY_SHARD || names.includes(input.shard))
		targets = [input.shard];
	else throw new ApiError('not_found', 'No shard has this name');

	const sql = capped(verdict.statement);
	const results: QueryResultView[] = [];
	for (const shard of targets) {
		const raw = await withTimeout(
			input.explain ? services.backend.plan(shard, sql) : services.backend.rows(shard, sql),
			services.timeoutMs ?? TIME_CAP_MS
		);
		const truncated = raw.length > ROW_CAP;
		const rows = (truncated ? raw.slice(0, ROW_CAP) : raw).map(maskRow);
		results.push({
			shard,
			columns: Object.keys(rows[0] ?? {}),
			rows,
			truncated,
			explain: input.explain
		});
	}
	await appendPlatformAudit(services.db, {
		actor,
		action: 'admin.db.read',
		target: input.shard,
		detail: {
			statement: verdict.statement,
			explain: input.explain,
			rows: results.reduce((n, r) => n + r.rows.length, 0)
		},
		now
	});
	return results;
}

export async function listShards(
	services: ConsoleServices,
	table?: string
): Promise<{ shards: { shard: string; sizeBytes: number | null; rows?: number | null }[] }> {
	const sizes = await services.backend.shards();
	if (table === undefined) return { shards: sizes };
	if (!/^[a-z_][a-z0-9_]*$/.test(table))
		throw refusal('A table name has letters, digits and underscores');
	const counts = new Map((await services.backend.count(table)).map((c) => [c.shard, c.count]));
	return { shards: sizes.map((s) => ({ ...s, rows: counts.get(s.shard) ?? null })) };
}

// #region saved queries

interface SavedRow {
	id: string;
	name: string;
	statement: string;
	created_by: string;
	created_at: number;
}

const toSaved = (row: SavedRow) => ({
	id: row.id,
	name: row.name,
	statement: row.statement,
	createdBy: row.created_by,
	createdAt: row.created_at
});

export async function listSavedQueries(services: ConsoleServices) {
	const { results } = await services.db.all<SavedRow>(
		DIRECTORY_KEY,
		'SELECT id, name, statement, created_by, created_at FROM db_console_queries ORDER BY created_at DESC, id DESC LIMIT 100',
		[]
	);
	return results.map(toSaved);
}

// a saved statement has to pass the same check, so a saved query is never worse than a typed one
export async function saveQuery(
	services: ConsoleServices,
	input: { name: string; statement: string; principal: Principal }
) {
	const verdict = checkStatement(input.statement, CHECK_OPTIONS);
	if (!verdict.ok) throw refusal(verdict.reason);
	const actor = principalActor(input.principal);
	const now = services.now();
	const row: SavedRow = {
		id: services.newId(),
		name: input.name,
		statement: verdict.statement,
		created_by: actor,
		created_at: now
	};
	await services.db.run(
		DIRECTORY_KEY,
		'INSERT INTO db_console_queries (id, name, statement, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
		[row.id, row.name, row.statement, row.created_by, row.created_at]
	);
	await appendPlatformAudit(services.db, {
		actor,
		action: 'admin.db.save',
		target: row.id,
		detail: { name: row.name, statement: row.statement },
		now
	});
	return toSaved(row);
}

export async function deleteSavedQuery(
	services: ConsoleServices,
	input: { id: string; principal: Principal }
): Promise<void> {
	const result = await services.db.run(
		DIRECTORY_KEY,
		'DELETE FROM db_console_queries WHERE id = ?',
		[input.id]
	);
	if ((result.meta.changes ?? 0) === 0)
		throw new ApiError('not_found', 'No saved query has this id');
	await appendPlatformAudit(services.db, {
		actor: principalActor(input.principal),
		action: 'admin.db.delete',
		target: input.id,
		detail: {},
		now: services.now()
	});
}

// #endregion
