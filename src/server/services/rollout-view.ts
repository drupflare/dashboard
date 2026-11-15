import { RELEASE_KINDS } from '@contracts/releases';
import { z } from 'zod';
import type { ReleaseRecord } from '../db/repos/releases';
import type { RolloutRecord } from '../db/repos/rollouts';
import { RINGS } from '../domain/cohorts';
import { advisoryInterval } from './rollouts';

export const rolloutView = z.object({
	id: z.string(),
	releaseId: z.string(),
	status: z.enum(['rolling', 'complete', 'halted', 'reverted']),
	// the ring the rollout is in, null once it ended
	currentRing: z.enum(RINGS).nullable(),
	rings: z.array(
		z.object({
			ring: z.enum(RINGS),
			reached: z.boolean(),
			upgraded: z.number(),
			failed: z.number(),
			reverted: z.number(),
			stuck: z.number()
		})
	),
	reasons: z.array(z.string()),
	stopRequested: z.boolean(),
	firstRingAt: z.number().nullable(),
	lastRingAt: z.number().nullable(),
	// milliseconds from the advisory to the last ring reached; null while either is unknown
	advisoryIntervalMs: z.number().nullable(),
	createdAt: z.number()
});

export type RolloutView = z.infer<typeof rolloutView>;

export function viewOf(rollout: RolloutRecord, advisoryAt: number | null): RolloutView {
	const { state } = rollout;
	return {
		id: rollout.id,
		releaseId: rollout.releaseId,
		status: rollout.status,
		currentRing: state.status === 'rolling' ? (state.order[state.current] ?? null) : null,
		rings: state.order.map((ring) => {
			const progress = rollout.progress[ring];
			return {
				ring,
				reached: state.received.includes(ring) && progress !== undefined,
				upgraded: progress?.upgraded.length ?? 0,
				failed: progress?.failed.length ?? 0,
				reverted: progress?.reverted.length ?? 0,
				stuck: progress?.stuck.length ?? 0
			};
		}),
		reasons: state.reasons,
		stopRequested: rollout.stopRequested,
		firstRingAt: rollout.firstRingAt,
		lastRingAt: rollout.lastRingAt,
		advisoryIntervalMs: advisoryInterval(advisoryAt, rollout),
		createdAt: rollout.createdAt
	};
}

export const releaseView = z.object({
	id: z.string(),
	kind: z.enum(RELEASE_KINDS),
	version: z.string(),
	schemaVersion: z.number(),
	acceptsSchema: z.number(),
	publishedAt: z.number(),
	advisoryAt: z.number().nullable(),
	rollout: rolloutView.nullable()
});

export function releaseViewOf(release: ReleaseRecord, rollout: RolloutRecord | null) {
	return {
		id: release.id,
		kind: release.kind,
		version: release.version,
		schemaVersion: release.schemaVersion,
		acceptsSchema: release.acceptsSchema,
		publishedAt: release.publishedAt,
		advisoryAt: release.advisoryAt,
		rollout: rollout === null ? null : viewOf(rollout, release.advisoryAt)
	};
}
