import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import {
	CUTOVER_STEPS,
	OBSERVATION_OFFSETS_MS,
	SOURCE_WRITE_POLICIES,
	cutoverSchema,
	rollbackBoundary
} from '../../../contracts/src/migration-cutover';
import {
	MAX_ROWS,
	consoleRefusalSchema,
	consoleRequestSchema,
	consoleResponseSchema
} from '../../../contracts/src/site-db-console';

describe('migration cutover', () => {
	const cutover = {
		siteId: newId('site'),
		policy: 'delta',
		state: 'running',
		step: 'snapshot',
		expectedWindowSeconds: 90,
		snapshotMarker: 'dump-001',
		deltaMarker: null,
		destinationWrites: 0,
		choice: null,
		sourceDestroyed: false,
		updatedAt: '2026-11-05T12:00:00Z'
	};

	it('round-trips a cutover', () => {
		expect(cutoverSchema.parse(cutover)).toEqual(cutover);
	});

	it('names the three source-write policies, the ten steps and the four observation points', () => {
		expect(SOURCE_WRITE_POLICIES).toEqual(['freeze', 'read-only', 'delta']);
		expect(CUTOVER_STEPS).toHaveLength(10);
		expect(OBSERVATION_OFFSETS_MS).toEqual([
			5 * 60_000,
			30 * 60_000,
			6 * 3_600_000,
			24 * 3_600_000
		]);
	});

	it('rejects an unknown policy and any record that says the source was destroyed', () => {
		expect(cutoverSchema.safeParse({ ...cutover, policy: 'pause' }).success).toBe(false);
		expect(cutoverSchema.safeParse({ ...cutover, sourceDestroyed: true }).success).toBe(false);
	});

	it('allows a post-write choice only after a destination write', () => {
		const choice = {
			value: 'export-changes',
			writesAtChoice: 3,
			recordedAt: '2026-11-05T13:00:00Z'
		};
		expect(cutoverSchema.safeParse({ ...cutover, destinationWrites: 3, choice }).success).toBe(
			true
		);
		expect(cutoverSchema.safeParse({ ...cutover, destinationWrites: 0, choice }).success).toBe(
			false
		);
		expect(
			cutoverSchema.safeParse({
				...cutover,
				destinationWrites: 3,
				choice: { ...choice, value: 'revert' }
			}).success
		).toBe(false);
		expect(
			cutoverSchema.safeParse({
				...cutover,
				destinationWrites: 3,
				choice: { ...choice, writesAtChoice: 0 }
			}).success
		).toBe(false);
	});

	it('moves the rollback boundary at the first accepted write', () => {
		expect(rollbackBoundary(0)).toBe('dns-reversal');
		expect(rollbackBoundary(1)).toBe('post-write');
		expect(rollbackBoundary(5000)).toBe('post-write');
	});
});

describe('site database console', () => {
	const request = {
		v: 1,
		siteId: newId('site'),
		sql: 'SELECT 1',
		params: ['a', 1, null, true],
		limit: 100,
		timeoutMs: 2000
	};

	it('round-trips a request, a response and a refusal', () => {
		expect(consoleRequestSchema.parse(request)).toEqual(request);
		const response = { columns: ['n'], rows: [[1], [null]], truncated: false, elapsedMs: 3.5 };
		expect(consoleResponseSchema.parse(response)).toEqual(response);
		const refusal = { code: 'not_read_only', message: 'Writes are not allowed.' };
		expect(consoleRefusalSchema.parse(refusal)).toEqual(refusal);
	});

	it('bounds the statement, the row limit and the timeout', () => {
		const bad = (patch: Record<string, unknown>) =>
			consoleRequestSchema.safeParse({ ...request, ...patch }).success;
		expect(bad({ sql: '' })).toBe(false);
		expect(bad({ sql: 'x'.repeat(10_001) })).toBe(false);
		expect(bad({ limit: MAX_ROWS + 1 })).toBe(false);
		expect(bad({ limit: 0 })).toBe(false);
		expect(bad({ timeoutMs: 30_001 })).toBe(false);
		expect(bad({ params: [{ nested: 1 }] })).toBe(false);
		expect(consoleRefusalSchema.safeParse({ code: 'oops', message: '' }).success).toBe(false);
	});
});
