import { describe, expect, it, vi } from 'vitest';
import type { CollegeDBEnv } from '../../../../src/server/db/collegedb';
import {
	SCHEMA_UNAVAILABLE,
	createSchemaGate,
	requireSchema
} from '../../../../src/server/db/schema-gate';

const env = { KV: {} } as unknown as CollegeDBEnv;

function failsOnce() {
	let calls = 0;
	return vi.fn(async () => {
		calls += 1;
		if (calls === 1) throw new Error('D1 unavailable');
	});
}

describe('createSchemaGate', () => {
	it('runs the load once for many concurrent and later callers', async () => {
		const load = vi.fn(async () => {});
		const ensure = createSchemaGate(load);
		await Promise.all([ensure(env), ensure(env), ensure(env)]);
		await ensure(env);
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('does not cache a failed load, so the next call retries', async () => {
		const load = failsOnce();
		const ensure = createSchemaGate(load);
		await expect(ensure(env)).rejects.toThrow('D1 unavailable');
		await expect(ensure(env)).resolves.toBeUndefined();
		await ensure(env);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('treats a load that throws synchronously the same way', async () => {
		let calls = 0;
		const ensure = createSchemaGate(() => {
			calls += 1;
			if (calls === 1) throw new Error('sync failure');
			return Promise.resolve();
		});
		await expect(ensure(env)).rejects.toThrow('sync failure');
		await expect(ensure(env)).resolves.toBeUndefined();
	});
});

describe('requireSchema', () => {
	it('passes through when the schema is ready', async () => {
		const ensure = createSchemaGate(async () => {});
		await expect(requireSchema(ensure, env)).resolves.toBeUndefined();
	});

	it('answers 503 without the cause while the load fails, then recovers', async () => {
		const ensure = createSchemaGate(failsOnce());
		const error = await requireSchema(ensure, env).catch((e: unknown) => e);
		expect(error).toMatchObject({ statusCode: 503, data: { code: SCHEMA_UNAVAILABLE } });
		expect(JSON.stringify(error)).not.toContain('D1 unavailable');
		await expect(requireSchema(ensure, env)).resolves.toBeUndefined();
	});
});
