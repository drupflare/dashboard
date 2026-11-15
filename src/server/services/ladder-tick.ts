import type { CollegeDBClient } from '@earth-app/collegedb';
import { REPAIR_HANDLES } from '../../../engine/src/repair/handles';
import type { LadderSwitches } from '../../../engine/src/repair/rows';
import { CATALOGUE } from '../../shared/health/catalogue';
import { factsOfFindings } from '../../shared/health/predicate';
import type { Rung } from '../../shared/health/vocab';
import { getLadderSwitches } from '../db/repos/ladder-switches';
import {
	listActiveSites,
	repairHistory,
	repairsSince,
	type ActiveSiteRef
} from '../db/repos/repairs';
import { siteInRollingRollout } from '../db/repos/rollouts';
import { getReadySite } from '../db/repos/sites';
import {
	DEFAULT_REPAIR_BUDGET,
	HOUR_MS,
	type RepairBudget,
	type RepairRecord as SpentRepair
} from '../domain/incidents';
import {
	decideRepair,
	type LadderFacts,
	type LadderOutcome,
	type PastAttempt
} from '../domain/ladder';
import { readHealthForLadder } from './site-health';
import { startSiteRepair } from './site-repair';
import type { SiteServices } from './sites';

export const TICK_MS = 900_000;

export interface SiteReading {
	history: LadderOutcome[];
	facts: Omit<LadderFacts, 'nowMs'>;
}

export interface LadderTickDeps {
	now(): number;
	sites(): Promise<ActiveSiteRef[]>;
	// null when the site gave no readable health answer
	reading(site: ActiveSiteRef): Promise<SiteReading | null>;
	switches(site: ActiveSiteRef): Promise<LadderSwitches>;
	past(site: ActiveSiteRef, repairId: string): Promise<PastAttempt[]>;
	recent(sinceMs: number): Promise<SpentRepair[]>;
	start(
		site: ActiveSiteRef,
		decision: { repairId: string; rung: Rung; key: string }
	): Promise<void>;
	hasHandler(repairId: string): boolean;
	budget: RepairBudget;
}

export interface TickSummary {
	checked: number;
	started: { siteId: string; repairId: string }[];
	held: { siteId: string; reason: string }[];
	unreadable: string[];
	failed: { siteId: string; message: string }[];
}

// one site that throws never stops the rest of the fleet
export async function tickLadder(deps: LadderTickDeps): Promise<TickSummary> {
	const summary: TickSummary = { checked: 0, started: [], held: [], unreadable: [], failed: [] };
	const nowMs = deps.now();
	const recent = [...(await deps.recent(nowMs - HOUR_MS))];
	for (const site of await deps.sites()) {
		summary.checked++;
		try {
			const switches = await deps.switches(site);
			// off everywhere is the default, so a site is not read and not listed for it
			if (switches.global !== true) continue;
			const reading = await deps.reading(site);
			if (reading === null) {
				summary.unreadable.push(site.id);
				continue;
			}
			const pasts = new Map<string, PastAttempt[]>();
			const repairId = reading.history.at(-1)?.code;
			if (repairId !== undefined && CATALOGUE.has(repairId)) {
				pasts.set(repairId, await deps.past(site, repairId));
			}
			const decision = decideRepair({
				history: reading.history,
				facts: { ...reading.facts, nowMs },
				switches,
				orgId: site.organizationId,
				hasHandler: deps.hasHandler,
				past: (id) => pasts.get(id) ?? [],
				recent,
				budget: deps.budget
			});
			if (!decision.start) {
				if (reading.history.length > 0) {
					summary.held.push({ siteId: site.id, reason: decision.reason });
				}
				continue;
			}
			await deps.start(site, {
				repairId: decision.repairId,
				rung: decision.rung,
				key: `ladder:${site.id}:${decision.repairId}:${Math.floor(nowMs / TICK_MS)}`
			});
			recent.push({ orgId: site.organizationId, atMs: nowMs });
			summary.started.push({ siteId: site.id, repairId: decision.repairId });
		} catch (error) {
			summary.failed.push({
				siteId: site.id,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return summary;
}

// the failing code is the one the worker is striking, or else the first finding the catalogue knows
export function historyOf(
	findings: readonly string[],
	repair: { code: string | null; strikes: number }
): LadderOutcome[] {
	const code =
		repair.code !== null && CATALOGUE.has(repair.code)
			? repair.code
			: findings.find((finding) => CATALOGUE.has(finding));
	if (code === undefined) return [];
	const strikes = repair.code === code ? Math.max(1, repair.strikes) : 1;
	return Array.from({ length: strikes }, () => ({ ok: false, code }));
}

export function productionLadderDeps(db: CollegeDBClient, services: SiteServices): LadderTickDeps {
	return {
		now: () => Date.now(),
		sites: () => listActiveSites(db),
		async reading(ref) {
			const site = await getReadySite(db, ref.organizationId, ref.id);
			if (site === null) return null;
			const health = await readHealthForLadder(site);
			if (health === null) return null;
			const { transactionDepth, shedding } = factsOfFindings(health.findings);
			const ringPromotion = await siteInRollingRollout(db, ref.id);
			return {
				history: historyOf(health.findings, health.repair),
				facts: {
					quarantinedAt: null,
					restorePoint: undefined,
					transactionDepth,
					gateHeld: false,
					shedding,
					// the workflow takes the lease itself and refuses when it cannot
					leaseHeld: true,
					ringPromotion
				}
			};
		},
		switches: (ref) => getLadderSwitches(db, ref.organizationId, ref.id),
		async past(ref, repairId) {
			const rows = await repairHistory(db, ref.organizationId, ref.id, repairId, 5);
			return rows.map((row) => ({ status: row.status, finishedAt: row.finishedAt }));
		},
		recent: (sinceMs) => repairsSince(db, sinceMs),
		async start(ref, decision) {
			await startSiteRepair(services, {
				orgId: ref.organizationId,
				siteId: ref.id,
				repairId: decision.repairId,
				trigger: 'auto',
				rung: decision.rung,
				undoOf: null,
				key: decision.key
			});
		},
		hasHandler: (repairId) => REPAIR_HANDLES[repairId]?.verified === true,
		budget: DEFAULT_REPAIR_BUDGET
	};
}
