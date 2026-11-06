import type { D1Database } from '@cloudflare/workers-types';
import { type CollegeDBEnv, discoverShards } from '../collegedb';

interface BatchStatement {
	sql: string;
	bindings?: unknown[];
}

// collegedb runs a batch as separate statements on a plain D1 binding, so an early statement
// survives a later failure. A shard that offers runBatch over D1's own batch gets one transaction
function atomicShard(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, name) {
			if (name === 'atomicBatch') return true;
			if (name === 'runBatch') {
				return (statements: BatchStatement[]) =>
					target.batch(
						statements.map((statement) =>
							target.prepare(statement.sql).bind(...(statement.bindings ?? []))
						)
					);
			}
			const value: unknown = Reflect.get(target, name, target);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

const wrapped = new WeakMap<object, CollegeDBEnv>();

// the same env with every shard binding replaced; one copy per env, so the client caches stay shared
export function withAtomicBatch(env: CollegeDBEnv): CollegeDBEnv {
	const cached = wrapped.get(env);
	if (cached) return cached;
	const shards = Object.fromEntries(
		Object.entries(discoverShards(env)).map(([name, db]) => [name, atomicShard(db)])
	);
	const next: CollegeDBEnv = { ...env, ...shards };
	wrapped.set(env, next);
	return next;
}
