import { createError } from 'h3';
import { type CollegeDBEnv, ensureCollegeDB } from './collegedb';

export type SchemaLoader = (env: CollegeDBEnv) => Promise<unknown>;

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

export const ensureSchema = createSchemaGate(ensureCollegeDB);

export async function requireSchema(
	ensure: (env: CollegeDBEnv) => Promise<void>,
	env: CollegeDBEnv
): Promise<void> {
	try {
		await ensure(env);
	} catch {
		throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
	}
}
