import { describe, expect, it } from 'vitest';
import {
	DEFAULT_ALLOCATION,
	STRATA_ALLOCATIONS,
	STRATA_CAPTURES_STATEMENTS,
	STRATA_RECOVERY_SECONDS,
	STRATA_STORAGE_NOTES,
	allocationAllowed,
	statusOf,
	storageCheckOf,
	strataAllocationBodySchema,
	strataStatusSchema
} from '../../../src/shared/strata';

describe('strata allocation', () => {
	it('starts on light, which records no statements', () => {
		expect(DEFAULT_ALLOCATION).toBe('light');
		expect(STRATA_CAPTURES_STATEMENTS).toEqual({ light: false, detailed: true });
	});

	it('allows only light on free and everything on a paid plan', () => {
		expect(STRATA_ALLOCATIONS.filter((value) => allocationAllowed(value, true))).toEqual([
			'light'
		]);
		expect(STRATA_ALLOCATIONS.filter((value) => allocationAllowed(value, false))).toEqual([
			...STRATA_ALLOCATIONS
		]);
	});

	it('reports a site that has not accepted the setting as not applied', () => {
		expect(statusOf('detailed', null)).toEqual({
			allocation: 'detailed',
			capturesStatements: true,
			recoverySeconds: STRATA_RECOVERY_SECONDS,
			applied: false,
			confirmedFreeAt: null,
			store: 'none',
			storeReason: null,
			storage: null
		});
		expect(
			statusOf('light', {
				appliedAt: 5,
				confirmedFreeAt: 3,
				store: 'failed',
				storeReason: 'token_quota'
			})
		).toMatchObject({ store: 'failed', storeReason: 'token_quota' });
		expect(statusOf('light', { appliedAt: 5, confirmedFreeAt: 3 })).toMatchObject({
			applied: true,
			confirmedFreeAt: 3
		});
	});

	it('reads the stored storage capability into a plain verdict', () => {
		expect(storageCheckOf({ state: 'granted' })).toBe('ok');
		expect(storageCheckOf({ state: 'not-enabled' })).toBe('needs_object_storage');
		expect(storageCheckOf({ state: 'missing' })).toBe('needs_wider_token');
		expect(storageCheckOf({ state: 'unknown' })).toBe('unchecked');
		expect(storageCheckOf(undefined)).toBe('unchecked');
	});

	it('carries the storage verdict on a self-managed status and names an action for each failure', () => {
		const status = statusOf('light', null, 'needs_wider_token');
		expect(strataStatusSchema.parse(status).storage).toBe('needs_wider_token');
		expect(statusOf('light', null).storage).toBeNull();
		for (const note of Object.values(STRATA_STORAGE_NOTES)) {
			expect(note.label.length).toBeGreaterThan(0);
			expect(note.action).toMatch(/\.$/);
		}
		expect(STRATA_STORAGE_NOTES.needs_object_storage.label).toBe('Needs Object Storage');
		expect(STRATA_STORAGE_NOTES.needs_wider_token.label).toBe('Needs a Wider Token');
	});

	it('refuses a body with a value outside the list or an extra field', () => {
		expect(strataAllocationBodySchema.safeParse({ allocation: 'detailed' }).success).toBe(true);
		expect(strataAllocationBodySchema.safeParse({ allocation: 'always' }).success).toBe(false);
		expect(
			strataAllocationBodySchema.safeParse({ allocation: 'light', extra: 1 }).success
		).toBe(false);
	});
});
