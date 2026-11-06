import { createError } from 'h3';
import { type CollegeDBEnv, ensureCollegeDB } from './collegedb';
import { withAtomicBatch } from './repos/atomic-shards';
import { requireSchemaVersion } from './schema';

export type SchemaLoader = (env: CollegeDBEnv) => Promise<unknown>;

export const SCHEMA_UNAVAILABLE = 'schema_unavailable';

export function createSchemaGate(load: SchemaLoader): (env: CollegeDBEnv) => Promise<void> {
	let ready: Promise<void> | undefined;
	return (env) => {
		if (ready) return ready;
		const attempt: Promise<void> = Promise.resolve()
			.then(() => load(env))
			.then(
				() => undefined,
				(error: unknown) => {
					if (ready === attempt) ready = undefined;
					throw error;
				}
			);
		ready = attempt;
		return attempt;
	};
}

// the schema has run, so every shard must now hold the version this code reads; a failed read
// or a missing or newer row stops the isolate from serving
export async function loadSchema(env: CollegeDBEnv): Promise<void> {
	const db = await ensureCollegeDB(withAtomicBatch(env));
	const shards = await db.allAllShards<{ value: string }>(
		`SELECT value FROM schema_meta WHERE key = 'schema_version'`
	);
	for (const shard of shards) requireSchemaVersion(shard.results[0]?.value ?? null);
}

export const ensureSchema = createSchemaGate(loadSchema);

export async function requireSchema(
	ensure: (env: CollegeDBEnv) => Promise<void>,
	env: CollegeDBEnv
): Promise<void> {
	try {
		await ensure(env);
	} catch {
		throw createError({
			statusCode: 503,
			statusMessage: 'Service Unavailable',
			data: { code: SCHEMA_UNAVAILABLE }
		});
	}
}
