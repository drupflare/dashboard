import type { D1Database } from '@cloudflare/workers-types';
import { sha256Hex } from '@contracts/common';
import type { SiteConfig, SiteKind, SitePlane } from '@contracts/sites';
import type { RingObservation, RolloutState } from '../../../src/server/domain/rings';
import { recipeFor } from '../../../src/shared/recipes';
import type { Custody } from '../custody';
import { freezePlan, newOperation } from '../operations/state';
import type { OperationStore } from '../operations/store';
import type {
	BackupLedger,
	ObserveRing,
	RepairWorker,
	RingProgress,
	RolloutStore,
	Site,
	SiteMover,
	StoredRollout
} from '../ports';
import { planSiteRollback } from '../workflows/site-rollback';
import { planSiteUpgrade, type SiteUpgradeInput } from '../workflows/site-upgrade';

// #region the rollout row

interface RolloutRow {
	id: string;
	release_id: string;
	state: string;
	progress: string;
	previous: string;
	first_ring_at: number | null;
	last_ring_at: number | null;
	stop_requested: number;
}

export class D1RolloutStore implements RolloutStore {
	constructor(
		private readonly db: D1Database,
		private readonly now: () => number = Date.now
	) {}

	async load(id: string): Promise<StoredRollout | null> {
		const row = await this.db
			.prepare('SELECT * FROM release_rollouts WHERE id = ?')
			.bind(id)
			.first<RolloutRow>();
		if (row === null) return null;
		return {
			id: row.id,
			releaseId: row.release_id,
			state: JSON.parse(row.state) as RolloutState,
			progress: JSON.parse(row.progress) as Record<string, RingProgress>,
			previous: JSON.parse(row.previous) as Record<string, string | null>,
			firstRingAt: row.first_ring_at,
			lastRingAt: row.last_ring_at
		};
	}

	// the row is made by the start route; a save changes what the run knows and never the stop flag
	async save(rollout: StoredRollout): Promise<void> {
		await this.db
			.prepare(
				`UPDATE release_rollouts SET status = ?, state = ?, progress = ?, previous = ?,
				 first_ring_at = ?, last_ring_at = ?, updated_at = ? WHERE id = ?`
			)
			.bind(
				rollout.state.status,
				JSON.stringify(rollout.state),
				JSON.stringify(rollout.progress),
				JSON.stringify(rollout.previous),
				rollout.firstRingAt,
				rollout.lastRingAt,
				this.now(),
				rollout.id
			)
			.run();
	}

	async stopRequested(id: string): Promise<boolean> {
		const row = await this.db
			.prepare('SELECT stop_requested FROM release_rollouts WHERE id = ?')
			.bind(id)
			.first<{ stop_requested: number }>();
		if (row?.stop_requested === 1) return true;
		// the platform switch halts a running rollout at its next ring
		const flag = await this.db
			.prepare("SELECT value FROM platform_flags WHERE key = 'promotion.stopped'")
			.first<{ value: string }>();
		return flag?.value === 'true';
	}

	// a site is in a promotion from the moment its ring starts until the rollout ends
	async inRollingRollout(siteId: string): Promise<boolean> {
		const row = await this.db
			.prepare(
				`SELECT 1 AS hit FROM release_rollouts r, json_each(r.previous) p
				 WHERE r.status = 'rolling' AND p.key = ? LIMIT 1`
			)
			.bind(siteId)
			.first<{ hit: number }>();
		return row !== null;
	}
}

// #endregion

// #region starting a site's own update or rollback

interface SiteRow {
	id: string;
	organization_id: string;
	plane: SitePlane;
	kind: SiteKind;
	config: SiteConfig;
	account_id: string | null;
	primary_hostname: string | null;
	release_id: string | null;
}

interface Starter {
	create(options: { id: string; params: SiteUpgradeInput }): Promise<unknown>;
}

const opIdOf = async (key: string) => `op_${(await sha256Hex(key)).slice(0, 26)}`;

export function siteMoverOf(deps: {
	db: D1Database;
	store: OperationStore;
	upgrade: Starter;
	rollback: Starter;
	now: () => number;
}): SiteMover {
	async function row(siteId: string): Promise<SiteRow> {
		const found = await deps.db
			.prepare(
				`SELECT id, organization_id, plane, kind, config, account_id, primary_hostname, release_id
				 FROM sites WHERE id = ?`
			)
			.bind(siteId)
			.first<SiteRow>();
		if (found === null) throw new Error(`${siteId} has no site row`);
		return found;
	}

	async function start(
		kind: 'upgrade' | 'rollback',
		site: { id: string; plan: string },
		releaseId: string,
		key: string
	): Promise<string> {
		const found = await row(site.id);
		if (found.account_id === null || found.primary_hostname === null) {
			throw new Error(`${site.id} is not live`);
		}
		const recipe = recipeFor(found.kind);
		if (recipe === undefined) throw new Error(`there is no recipe for ${found.kind}`);
		const operationId = await opIdOf(key);
		const params: SiteUpgradeInput = {
			operationId,
			site: {
				id: found.id,
				orgId: found.organization_id,
				kind: found.kind,
				plane: found.plane,
				config: found.config,
				ring: 'R0',
				plan: site.plan,
				accountId: found.account_id
			},
			hostname: found.primary_hostname,
			releaseId,
			currentRelease: found.release_id,
			probe: {
				path: recipe.probe.path,
				expectStatus: 200,
				...(recipe.probe.auth === undefined ? {} : { auth: recipe.probe.auth })
			}
		};
		const plan = kind === 'upgrade' ? planSiteUpgrade(params) : planSiteRollback(params);
		const { operation, created } = await deps.store.begin({
			operation: newOperation({
				id: operationId,
				orgId: found.organization_id,
				idempotencyKey: key,
				frozen: await freezePlan(plan),
				now: deps.now()
			}),
			accountId: found.account_id,
			siteId: found.id
		});
		if (!created) return operation.id;
		const starter = kind === 'upgrade' ? deps.upgrade : deps.rollback;
		try {
			await starter.create({ id: operationId, params });
		} catch (error) {
			// an instance that already exists was started by an earlier try of this step
			if (!/already|exists/i.test(error instanceof Error ? error.message : '')) throw error;
		}
		return operationId;
	}

	return {
		async current(siteId) {
			return (await row(siteId)).release_id;
		},
		upgrade: (site, releaseId, key) => start('upgrade', site, releaseId, key),
		rollback: (site, releaseId, key) => start('rollback', site, releaseId, key),
		async status(operationId) {
			const operation = await deps.store.get(operationId);
			if (operation === null) return 'failed';
			if (operation.status === 'succeeded') return 'succeeded';
			return ['failed', 'rolled-back', 'cancelled'].includes(operation.status)
				? 'failed'
				: 'running';
		}
	};
}

// #endregion

// #region what the ring's sites report

// only the fields the sites already report are filled in. Request failure rate, resets, memory trend,
// cold boots and write failures have no source yet, so they stay missing and the judge halts
export function ringObserverOf(deps: {
	backups: Pick<BackupLedger, 'site'>;
	custody: Custody;
	repair: RepairWorker;
	site: Site;
}): ObserveRing {
	async function look(siteId: string) {
		const row = await deps.backups.site(siteId);
		if (row === null || row.primaryHostname === null) return null;
		const { ownerTokenId } = await deps.custody.sealed(siteId);
		if (ownerTokenId === null) return null;
		const hostname = row.primaryHostname;
		try {
			const reading = await deps.custody.withOwnerToken(siteId, ownerTokenId, (bearer) =>
				deps.repair.observe(hostname, { bearer })
			);
			return { hostname, findings: reading.findings.length };
		} catch {
			return null;
		}
	}

	return async (probe): Promise<RingObservation> => {
		const seen = await Promise.all(
			probe.siteIds.map(async (id) => [id, await look(id)] as const)
		);
		const answered = seen.flatMap(([, reading]) => (reading === null ? [] : [reading]));
		const synthetic = seen.filter(([id]) => probe.syntheticIds.includes(id));
		let syntheticHealthy: boolean | undefined;
		if (synthetic.length > 0) {
			const checks = await Promise.all(
				synthetic.map(async ([, reading]) =>
					reading === null
						? false
						: (await deps.site.probe(reading.hostname, '/', 200)).status === 200
				)
			);
			syntheticHealthy = checks.every(Boolean);
		}
		return {
			ring: probe.ring,
			metrics: {
				repairFindings: answered.reduce((sum, reading) => sum + reading.findings, 0)
			},
			...(syntheticHealthy === undefined ? {} : { syntheticHealthy }),
			observedSites: answered.length,
			expectedSites: probe.siteIds.length
		};
	};
}

// #endregion
