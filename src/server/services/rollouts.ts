import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { z } from 'zod';
import {
	planReleaseRing,
	type ReleaseRingInput,
	type RingSite
} from '../../../engine/src/workflows/release-ring';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import { getRelease } from '../db/repos/releases';
import {
	createRollout,
	findRollingRollout,
	getRollout,
	requestStop,
	type RolloutRecord
} from '../db/repos/rollouts';
import { assignCohorts, RINGS, type CohortSite, type Ring } from '../domain/cohorts';
import { startRollout } from '../domain/rings';
import { startRecorded, type SiteServices } from './sites';

export const startRolloutBody = z.strictObject({
	// sites an admin marks by role; a site in none of these takes its ring from the usual rules
	designations: z
		.strictObject({
			synthetic: z.array(z.string()).max(200).default([]),
			own: z.array(z.string()).max(200).default([]),
			canary: z.array(z.string()).max(200).default([])
		})
		.default({ synthetic: [], own: [], canary: [] }),
	// an admin may place a site in any ring
	overrides: z
		.array(z.strictObject({ siteId: z.string(), ring: z.enum(RINGS) }))
		.max(500)
		.default([])
});

export type StartRolloutBody = z.infer<typeof startRolloutBody>;

interface SiteRow {
	id: string;
	organization_id: string;
	kind: string;
	release_id: string | null;
}

// metadata only: the rows say which sites are live and what they run
async function liveSites(services: SiteServices): Promise<SiteRow[]> {
	const shards = await (
		await services.getDb()
	).allAllShards<SiteRow>(
		`SELECT id, organization_id, kind, release_id FROM sites
		 WHERE state = 'active' AND plane = 'managed' AND account_id IS NOT NULL
		 AND primary_hostname IS NOT NULL ORDER BY id`,
		[]
	);
	return shards.flatMap((shard) => (shard.success ? shard.results : []));
}

// the sites a rollout moves, by ring. Traffic and criticality are not recorded anywhere yet, so a
// site with no designation is treated as a standard content site and lands in R4
export function ringsFor(
	sites: { id: string; orgId: string }[],
	body: StartRolloutBody
): { ring: Ring; sites: { id: string; orgId: string; synthetic: boolean }[] }[] {
	const marked = body.designations;
	const override = new Map(body.overrides.map((entry) => [entry.siteId, entry.ring]));
	const cohortSites: CohortSite[] = sites.map((site) => ({
		id: site.id,
		traffic: 0,
		workload: 'content',
		criticality: 'standard',
		synthetic: marked.synthetic.includes(site.id),
		own: marked.own.includes(site.id),
		canary: marked.canary.includes(site.id),
		...(override.has(site.id)
			? { override: { ring: override.get(site.id) as Ring, byPlatformAdmin: true } }
			: {})
	}));
	const cohorts = assignCohorts(cohortSites);
	const orgOf = new Map(sites.map((site) => [site.id, site.orgId]));
	return RINGS.filter((ring) => cohorts[ring].length > 0).map((ring) => ({
		ring,
		sites: cohorts[ring].map((site) => ({
			id: site.id,
			orgId: orgOf.get(site.id) as string,
			synthetic: site.synthetic === true
		}))
	}));
}

export async function startReleaseRollout(
	services: SiteServices,
	input: { releaseId: string; body: StartRolloutBody; idempotencyKey: string }
): Promise<RolloutRecord> {
	const db = await services.getDb();
	const release = await getRelease(db, input.releaseId);
	if (release === null) throw new ApiError('not_found', 'That release is not registered');
	const rolling = await findRollingRollout(db);
	if (rolling !== null) {
		throw new ApiError(
			'conflict',
			'Another rollout is still running. Stop it or wait for it to end.',
			{
				reason: 'rollout_running',
				rolloutId: rolling.id
			}
		);
	}
	const candidates = (await liveSites(services))
		.filter((site) => site.release_id !== release.id)
		.map((site) => ({ id: site.id, orgId: site.organization_id }));
	if (candidates.length === 0) {
		throw new ApiError('conflict', 'Every live site already runs that release', {
			reason: 'nothing_to_roll_out'
		});
	}
	const rings = ringsFor(candidates, input.body);
	const plans = new Map<string, string>();
	for (const orgId of new Set(candidates.map((site) => site.orgId))) {
		plans.set(orgId, (await services.planOf(orgId)).planId);
	}
	const ringSites = rings.map((entry) => ({
		ring: entry.ring,
		sites: entry.sites.map((site): RingSite => ({
			id: site.id,
			plan: plans.get(site.orgId) as string,
			...(site.synthetic ? { synthetic: true } : {})
		}))
	}));

	// the record sits under the organisation that owns the first site of the first ring
	const orgId = rings[0]!.sites[0]!.orgId;
	const operationId = newId('op');
	const params: ReleaseRingInput = {
		operationId,
		orgId,
		rolloutId: operationId,
		releaseId: release.id,
		rings: ringSites
	};
	const plan = planReleaseRing(params);
	const now = nowUtc().toMillis();
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: orgId,
		accountId: null,
		siteId: null,
		type: 'fleet.upgrade',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'pending',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		inputs: params,
		now
	});
	if (!created) {
		const existing = await getRollout(db, operation.operation.targetIds[0] ?? '');
		if (existing !== null) return existing;
		throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
			reason: 'idempotency_key_reused'
		});
	}
	await createRollout(db, {
		id: operationId,
		releaseId: release.id,
		operationId,
		state: startRollout(
			assignCohorts(
				ringSites.flatMap((entry) =>
					entry.sites.map((site) => ({
						id: site.id,
						traffic: 0,
						workload: 'content' as const,
						criticality: 'standard' as const,
						override: { ring: entry.ring, byPlatformAdmin: true }
					}))
				)
			),
			release.id
		),
		now
	});
	await startRecorded(
		services,
		db,
		orgId,
		operation,
		{
			workflow: 'release-ring',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The rollout could not be started'
	);
	const stored = await getRollout(db, operationId);
	if (stored === null) throw new Error('the rollout row is missing after its start');
	return stored;
}

export async function stopReleaseRollout(
	services: SiteServices,
	rolloutId: string
): Promise<RolloutRecord> {
	const db = await services.getDb();
	const rollout = await getRollout(db, rolloutId);
	if (rollout === null) throw new ApiError('not_found', 'Not found');
	if (rollout.status !== 'rolling') {
		throw new ApiError('conflict', 'That rollout has already ended', {
			reason: 'rollout_ended'
		});
	}
	await requestStop(db, rolloutId, nowUtc().toMillis());
	return (await getRollout(db, rolloutId)) as RolloutRecord;
}

// the time from the advisory to the last ring reached, once both are known
export function advisoryInterval(
	advisoryAt: number | null,
	rollout: Pick<RolloutRecord, 'lastRingAt' | 'status'> | null
): number | null {
	if (advisoryAt === null || rollout === null || rollout.lastRingAt === null) return null;
	return Math.max(0, rollout.lastRingAt - advisoryAt);
}
