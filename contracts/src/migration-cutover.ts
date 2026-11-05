import { z } from 'zod';
import { isoTimestamp, siteId } from './common';

export const MIGRATION_CUTOVER_VERSION = { major: 1, minor: 0 } as const;

export const SOURCE_WRITE_POLICIES = ['freeze', 'read-only', 'delta'] as const;

export const CUTOVER_STEPS = [
	'lower-ttl',
	'snapshot',
	'capture-delta',
	'validate',
	'owner-approval',
	'apply-write-policy',
	'final-delta',
	'promote',
	'route',
	'observe'
] as const;

export const CUTOVER_STATES = [
	'planned',
	'running',
	'awaiting-approval',
	'promoted',
	'observing',
	'completed',
	'rolled-back',
	'failed'
] as const;

export const POST_WRITE_CHOICES = ['keep-new', 'abandon-new-data', 'export-changes'] as const;

export const OBSERVATION_OFFSETS_MS = [300_000, 1_800_000, 21_600_000, 86_400_000] as const;

export const sourceWritePolicy = z.enum(SOURCE_WRITE_POLICIES);
export const cutoverStep = z.enum(CUTOVER_STEPS);
export const cutoverState = z.enum(CUTOVER_STATES);
export const postWriteChoice = z.enum(POST_WRITE_CHOICES);

export const cutoverSchema = z
	.object({
		siteId,
		policy: sourceWritePolicy,
		state: cutoverState,
		step: cutoverStep.nullable(),
		expectedWindowSeconds: z.int().nonnegative().nullable(),
		snapshotMarker: z.string().min(1).nullable(),
		deltaMarker: z.string().min(1).nullable(),
		destinationWrites: z.int().nonnegative(),
		choice: z
			.object({
				value: postWriteChoice,
				writesAtChoice: z.int().positive(),
				recordedAt: isoTimestamp
			})
			.nullable(),
		sourceDestroyed: z.literal(false),
		updatedAt: isoTimestamp
	})
	.refine((cutover) => cutover.choice === null || cutover.destinationWrites > 0, {
		message: 'a post-write choice needs at least one destination write',
		path: ['choice']
	});

export type Cutover = z.infer<typeof cutoverSchema>;

export type RollbackBoundary = 'dns-reversal' | 'post-write';

// before the first accepted write rollback is a dns reversal, after it the owner must choose
export function rollbackBoundary(destinationWrites: number): RollbackBoundary {
	return destinationWrites === 0 ? 'dns-reversal' : 'post-write';
}

export const schemas = { cutover: cutoverSchema };
