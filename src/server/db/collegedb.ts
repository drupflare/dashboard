import type { D1Database, KVNamespace } from '@cloudflare/workers-types';
import { type CollegeDBClient, createClient, createWorkersKVProvider } from '@earth-app/collegedb';
import {
	SCHEMA_META_STATEMENT,
	SCHEMA_STATEMENTS,
	SCHEMA_TRIGGERS,
	SCHEMA_VERSION,
	checkSchemaVersion
} from './schema';

// directory rows share one shard so the email and provider subject unique indexes hold
export const DIRECTORY_KEY = 'directory';

const SHARD_BINDING = /^DB(_\d+)?$/;

export interface CollegeDBEnv {
	KV: KVNamespace;
	[binding: string]: unknown;
}

export class NoShardsError extends Error {
	readonly code = 'NO_SHARDS';

	constructor() {
		super('no D1 binding found on env; expected DB, DB_2, ...');
		this.name = 'NoShardsError';
	}
}

export class DuplicateRowError extends Error {
	readonly code = 'DUPLICATE_ROW';

	constructor(message: string) {
		super(message);
		this.name = 'DuplicateRowError';
	}
}

export function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

export function wasChanged(result: { meta: { changes?: number } }): boolean {
	return (result.meta.changes ?? 0) > 0;
}

export async function uniqueOrDuplicate<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (isUniqueViolation(error)) throw new DuplicateRowError((error as Error).message);
		throw error;
	}
}

function isD1(value: unknown): boolean {
	return typeof (value as { prepare?: unknown } | undefined)?.prepare === 'function';
}

export function discoverShards(env: Record<string, unknown>): Record<string, D1Database> {
	const names = Object.keys(env)
		.filter((name) => SHARD_BINDING.test(name) && isD1(env[name]))
		.sort();
	if (names.length === 0) throw new NoShardsError();
	return Object.fromEntries(names.map((name) => [name, env[name] as D1Database]));
}

export function createCollegeDB(env: CollegeDBEnv): CollegeDBClient {
	return createClient({
		kv: createWorkersKVProvider(env.KV),
		shards: discoverShards(env),
		strategy: 'hash'
	});
}

export async function applySchema(db: CollegeDBClient): Promise<void> {
	await db.runAllShards(SCHEMA_META_STATEMENT);
	const stored = await db.allAllShards<{ value: string }>(
		`SELECT value FROM schema_meta WHERE key = 'schema_version'`
	);
	for (const shard of stored) checkSchemaVersion(shard.results[0]?.value ?? null);
	await db.ensureSchema(SCHEMA_STATEMENTS);
	for (const trigger of SCHEMA_TRIGGERS) await db.runAllShards(trigger);
	await db.runAllShards(
		`INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
		[String(SCHEMA_VERSION)]
	);
}

const clients = new WeakMap<CollegeDBEnv, Promise<CollegeDBClient>>();

export function ensureCollegeDB(env: CollegeDBEnv): Promise<CollegeDBClient> {
	const cached = clients.get(env);
	if (cached) return cached;
	const ready = (async () => {
		const db = createCollegeDB(env);
		await applySchema(db);
		return db;
	})();
	clients.set(env, ready);
	ready.catch(() => clients.delete(env));
	return ready;
}
