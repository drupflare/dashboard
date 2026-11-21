import type { H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollegeDBEnv } from '../../../../src/server/db/collegedb';
import {
	SCHEMA_UNAVAILABLE,
	createSchemaGate,
	requireSchema
} from '../../../../src/server/db/schema-gate';
import schemaMiddleware from '../../../../src/server/middleware/01.ensure-schema';

const { ensureSchema } = vi.hoisted(() => ({ ensureSchema: vi.fn() }));

vi.mock('../../../../src/server/db/schema-gate', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../src/server/db/schema-gate')>()),
	ensureSchema
}));

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

describe('schema middleware', () => {
	const paths = ['/api/v1/sites', '/docs'];

	function eventWith(context: Record<string, unknown>, path: string) {
		return { path, context } as unknown as H3Event;
	}

	beforeEach(() => {
		ensureSchema.mockReset();
	});

	it('passes a request with bindings when the schema is ok', async () => {
		ensureSchema.mockResolvedValue(undefined);
		for (const path of paths) {
			await expect(
				schemaMiddleware(eventWith({ cloudflare: { env } }, path))
			).resolves.toBeUndefined();
		}
		expect(ensureSchema).toHaveBeenCalledWith(env);
	});

	it('refuses a request with bindings when the schema fails', async () => {
		ensureSchema.mockRejectedValue(new Error('D1 unavailable'));
		for (const path of paths) {
			const error = await schemaMiddleware(eventWith({ cloudflare: { env } }, path)).catch(
				(e: unknown) => e
			);
			expect(error).toMatchObject({ statusCode: 503, data: { code: SCHEMA_UNAVAILABLE } });
		}
	});

	it('passes a request with no bindings through without checking the schema', async () => {
		for (const path of paths) {
			await expect(schemaMiddleware(eventWith({}, path))).resolves.toBeUndefined();
		}
		expect(ensureSchema).not.toHaveBeenCalled();
	});
});
