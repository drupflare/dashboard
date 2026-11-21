import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import { startReleaseRollout, stopReleaseRollout } from '../../../../src/server/services/rollouts';
import type { SiteServices } from '../../../../src/server/services/sites';

const body = { designations: { synthetic: [], own: [], canary: [] }, overrides: [] };

describe('startReleaseRollout', () => {
	it('refuses to start a rollout while promotion is stopped', async () => {
		const db = {
			first: async (_key: string, sql: string) =>
				sql.includes('platform_flags') ? { value: 'true' } : null
		} as unknown as CollegeDBClient;
		const services = { getDb: async () => db } as unknown as SiteServices;
		await expect(
			startReleaseRollout(services, { releaseId: 'rel_1', body, idempotencyKey: 'k' })
		).rejects.toMatchObject({ code: 'conflict', details: { reason: 'promotion_stopped' } });
	});
});

describe('stopReleaseRollout', () => {
	const row = {
		id: 'ro_1',
		release_id: 'rel_1',
		operation_id: 'op_1',
		status: 'rolling',
		state: JSON.stringify({ status: 'rolling' }),
		progress: '{}',
		first_ring_at: null,
		last_ring_at: null,
		stop_requested: 0,
		created_at: 1,
		updated_at: 1
	};
	const run = (releaseId: string) => {
		const writes: string[] = [];
		const db = {
			first: async () => row,
			run: async (_key: string, sql: string) => {
				writes.push(sql);
			}
		} as unknown as CollegeDBClient;
		const services = { getDb: async () => db } as unknown as SiteServices;
		return { writes, result: stopReleaseRollout(services, releaseId, 'ro_1') };
	};

	it('stops a rollout through the release it belongs to', async () => {
		const { writes, result } = run('rel_1');
		await result;
		expect(writes.some((sql) => sql.includes('stop_requested = 1'))).toBe(true);
	});

	it('answers not found, and stops nothing, when the path names a different release', async () => {
		const { writes, result } = run('rel_other');
		await expect(result).rejects.toMatchObject({ code: 'not_found' });
		expect(writes).toEqual([]);
	});
});
