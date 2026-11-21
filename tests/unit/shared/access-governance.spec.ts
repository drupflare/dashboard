import { describe, expect, it } from 'vitest';
import {
	REVIEW_INTERVAL_DAYS,
	reviewCreateBodySchema,
	reviewDecideBodySchema,
	reviewScheduleBodySchema,
	STALE_DAYS
} from '../../../src/shared/access-reviews';
import { offboardBodySchema } from '../../../src/shared/offboarding';
import {
	SERVICE_ACCOUNT_MAX_DAYS,
	serviceAccountCreateBodySchema,
	serviceAccountStateOf
} from '../../../src/shared/service-accounts';

describe('service account body', () => {
	it('requires an expiry and caps it at the constant', () => {
		expect(serviceAccountCreateBodySchema.safeParse({ name: 'Bot' }).success).toBe(false);
		expect(
			serviceAccountCreateBodySchema.safeParse({
				name: 'Bot',
				expiresInDays: SERVICE_ACCOUNT_MAX_DAYS
			}).success
		).toBe(true);
		expect(
			serviceAccountCreateBodySchema.safeParse({
				name: 'Bot',
				expiresInDays: SERVICE_ACCOUNT_MAX_DAYS + 1
			}).success
		).toBe(false);
		expect(
			serviceAccountCreateBodySchema.safeParse({ name: 'Bot', expiresInDays: 0 }).success
		).toBe(false);
	});

	it('refuses an unknown field', () => {
		expect(
			serviceAccountCreateBodySchema.safeParse({ name: 'Bot', expiresInDays: 5, admin: true })
				.success
		).toBe(false);
	});

	it('reads the state from the clock', () => {
		expect(serviceAccountStateOf({ expiresAt: 10, disabledAt: null }, 5)).toBe('active');
		expect(serviceAccountStateOf({ expiresAt: 10, disabledAt: null }, 10)).toBe('expired');
		expect(serviceAccountStateOf({ expiresAt: 10, disabledAt: 3 }, 5)).toBe('disabled');
	});
});

describe('review bodies', () => {
	it('takes the whole organization or a department id, with a bounded due date', () => {
		expect(reviewCreateBodySchema.safeParse({ scope: 'organization' }).success).toBe(true);
		expect(reviewCreateBodySchema.safeParse({ scope: 'd1', dueInDays: 30 }).success).toBe(true);
		expect(reviewCreateBodySchema.safeParse({ scope: 'd1', dueInDays: 400 }).success).toBe(
			false
		);
		expect(reviewCreateBodySchema.safeParse({ scope: '' }).success).toBe(false);
	});

	it('lets a decision be keep or revoke and nothing else', () => {
		const base = { kind: 'member', subjectRef: 'm1' };
		expect(reviewDecideBodySchema.safeParse({ ...base, decision: 'keep' }).success).toBe(true);
		expect(
			reviewDecideBodySchema.safeParse({ ...base, decision: 'revoke', applyNow: true })
				.success
		).toBe(true);
		expect(reviewDecideBodySchema.safeParse({ ...base, decision: 'pending' }).success).toBe(
			false
		);
		expect(
			reviewDecideBodySchema.safeParse({ kind: 'site', subjectRef: 'x', decision: 'keep' })
				.success
		).toBe(false);
	});

	it('knows three intervals and a default of 90 stale days', () => {
		expect(reviewScheduleBodySchema.safeParse({ interval: 'monthly' }).success).toBe(false);
		expect(REVIEW_INTERVAL_DAYS).toEqual({ off: null, quarterly: 91, yearly: 365 });
		expect(STALE_DAYS).toBe(90);
	});
});

describe('offboard body', () => {
	it('is optional in every field and strict', () => {
		expect(offboardBodySchema.safeParse({}).success).toBe(true);
		expect(
			offboardBodySchema.safeParse({ dryRun: true, transferTo: 'u2', keepDelegations: true })
				.success
		).toBe(true);
		expect(offboardBodySchema.safeParse({ force: true }).success).toBe(false);
	});
});
