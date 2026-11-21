import { beforeAll, describe, expect, it, vi } from 'vitest';
import { archive, docsRepo, harness, ok } from '../fixtures/mirror-archive';

type Task = {
	meta?: { name?: string };
	run(input: { context: unknown }): Promise<{ result?: unknown }>;
};

let task: Task;

beforeAll(async () => {
	vi.doMock('nitropack/runtime', () => ({ defineTask: (t: unknown) => t }));
	task = (await import('../../../../src/server/tasks/docs-mirror-refresh'))
		.default as unknown as Task;
});

describe('docs-mirror-refresh task', () => {
	it('is named and skips without the cache binding', async () => {
		expect(task.meta?.name).toBe('docs-mirror-refresh');
		expect(await task.run({ context: {} })).toEqual({
			result: { skipped: 'the cache binding is missing' }
		});
	});

	it('refreshes both mirrors once, then reports not due', async () => {
		const gz = await archive('d'.repeat(40), docsRepo());
		const h = harness(() => ok(gz));
		const context = {
			cloudflare: {
				env: {
					CACHE: {
						get: async (key: string, type: string) => {
							const v = h.store.get(key);
							return v === undefined
								? null
								: type === 'json'
									? JSON.parse(v as string)
									: v;
						},
						put: async (key: string, value: string | ArrayBuffer) =>
							void h.store.set(key, value),
						delete: async (key: string) => void h.store.delete(key),
						list: async () => ({ keys: [], list_complete: true })
					}
				}
			}
		};
		vi.stubGlobal('fetch', (url: string, init?: RequestInit) => h.deps.fetch(url, init));
		const first = (await task.run({ context })) as { result: { id: string; status: string }[] };
		expect(first.result.map((r) => [r.id, r.status])).toEqual([
			['worker', 'updated'],
			['spool', 'updated']
		]);
		expect(await task.run({ context })).toEqual({ result: { skipped: 'not due yet' } });
		vi.unstubAllGlobals();
	});
});
