import {
	BREAKER_WINDOW_MS,
	QUARANTINE_STRIKES,
	type AutomationLevel,
	type RepairClass,
	type Severity
} from './vocab';

export { CATALOGUE_AUTOMATION, CATALOGUE_CLASSES } from './vocab';

export const PRECONDITION = {
	notShedding: 'not shedding load',
	leaseHeld: 'site lease held',
	noTransaction: 'no open transaction',
	noRingPromotion: 'no ring promotion in progress'
} as const;

// the preconditions the ladder can evaluate; rows that run unattended may use only these
export const KNOWN_PRECONDITIONS: readonly string[] = Object.values(PRECONDITION);

export type CatalogueUndo = { handle: string } | { none: string };

export type CatalogueRow = {
	repairId: string;
	source: string;
	severity: Severity;
	handle: string;
	class: RepairClass;
	automation: AutomationLevel;
	preconditions: string[];
	attemptBound: number;
	cooldownMs: number;
	// names a re-observation that shows the failure cleared
	successPredicate: string;
	undo: CatalogueUndo;
	escalation: string;
	// the failure code is not in the worker source
	unverified?: true;
};

const CACHE_REFILLS: CatalogueUndo = {
	none: 'stored pages refill on the next request; no state is discarded'
};

const RECYCLE_UNDO: CatalogueUndo = {
	none: 'the interpreter restarts; no site state is discarded'
};

const RECONCILE_UNDO: CatalogueUndo = {
	none: 'reconcile reapplies the shipping pack; reverting means shipping an older pack'
};

const NO_REPAIR: CatalogueUndo = { none: 'no repair runs, so there is nothing to undo' };

const HOST = 'worker host tripwire';
const PHP = 'php tripwire';
const CONTROL = 'control plane';

// attempts and cool-downs are the worker's strike count and breaker window; no row sets its own value yet
function row(r: Omit<CatalogueRow, 'attemptBound' | 'cooldownMs'>): CatalogueRow {
	return { attemptBound: QUARANTINE_STRIKES, cooldownMs: BREAKER_WINDOW_MS, ...r };
}

const { notShedding, leaseHeld, noTransaction, noRingPromotion } = PRECONDITION;
const REBUILD_PRE = [notShedding, leaseHeld, noTransaction];

const ROWS: CatalogueRow[] = [
	row({
		repairId: 'render.empty',
		source: HOST,
		severity: 'critical',
		handle: '/invalidate',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'render.nonempty',
		undo: CACHE_REFILLS,
		escalation: 'owner reads /health and the ledger entry; a repeat quarantines the site'
	}),
	row({
		repairId: 'render.size_anomaly',
		source: HOST,
		severity: 'error',
		handle: '/invalidate',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'render.size_in_band',
		undo: CACHE_REFILLS,
		escalation: 'owner checks the page for account content; a repeat quarantines the site'
	}),
	row({
		repairId: 'bridge.asyncify_called',
		source: HOST,
		severity: 'warn',
		handle: 'interpreter-recycle',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'bridge.asyncify_clear',
		undo: RECYCLE_UNDO,
		escalation: 'three same-code strikes quarantine the site'
	}),
	row({
		repairId: 'bridge.mask_leaked',
		source: HOST,
		severity: 'error',
		handle: 'interpreter-recycle',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'bridge.mask_clear',
		undo: RECYCLE_UNDO,
		escalation: 'three same-code strikes quarantine the site'
	}),
	row({
		repairId: 'db.semaphore_dirty',
		source: HOST,
		severity: 'warn',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'db.semaphore_clear',
		undo: NO_REPAIR,
		escalation: 'owner reads /health; no repair route is catalogued for the semaphore rows'
	}),
	row({
		repairId: 'migrate.incomplete',
		source: HOST,
		severity: 'critical',
		handle: '/migrate',
		class: 'stateful',
		automation: 'approval',
		preconditions: [leaseHeld],
		successPredicate: 'migrate.complete',
		undo: { none: 'no reverse step is catalogued for first-run migration' },
		escalation: 'owner approves the resume and reads the step that stalled'
	}),
	row({
		repairId: 'updb.halted',
		source: HOST,
		severity: 'error',
		handle: '/updb?action=rollback',
		class: 'stateful',
		automation: 'manual',
		preconditions: [leaseHeld],
		successPredicate: 'updb.run_not_halted',
		undo: { none: 'rollback is the restore; a second rollback has nothing to undo' },
		escalation: 'operator reads the halted run; abandon takes a written reason'
	}),
	row({
		repairId: 'pack.generation_mismatch',
		source: HOST,
		severity: 'critical',
		handle: 'reconcile',
		class: 'safe',
		automation: 'auto',
		preconditions: [leaseHeld, noRingPromotion, noTransaction],
		successPredicate: 'pack.generation_matches',
		undo: RECONCILE_UNDO,
		escalation: 'a step that fails three times stays visible and is not retried'
	}),
	row({
		repairId: 'memory.highwater_rising',
		source: HOST,
		severity: 'warn',
		handle: 'interpreter-recycle',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'memory.highwater_flat',
		undo: RECYCLE_UNDO,
		escalation: 'the recycle waits for a quiet moment; a recycle costs a full boot'
	}),
	row({
		repairId: 'memory.trend_rising',
		source: HOST,
		severity: 'warn',
		handle: 'interpreter-recycle',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'memory.trend_flat',
		undo: RECYCLE_UNDO,
		escalation: 'the recycle waits for a quiet moment; a recycle costs a full boot'
	}),
	row({
		repairId: 'health.ledger_oversized',
		source: HOST,
		severity: 'warn',
		handle: 'ledger-gc',
		class: 'safe',
		automation: 'auto',
		preconditions: [noTransaction],
		successPredicate: 'ledger.within_cap',
		undo: { none: 'pruned rows are the oldest findings; nothing serves from them' },
		escalation: 'owner reads /health; the ledger keeps the newest rows'
	}),
	row({
		repairId: 'budget.image_transforms',
		source: HOST,
		severity: 'warn',
		handle: 'degrade-band',
		class: 'stateful',
		automation: 'auto',
		preconditions: [],
		successPredicate: 'budget.image_transforms_under_cap',
		undo: { none: 'the band is recomputed from the meter and clears when the meter does' },
		escalation: 'owner reviews the plan limit against the month to date'
	}),
	row({
		repairId: 'budget.rows_written',
		source: HOST,
		severity: 'warn',
		handle: 'degrade-band',
		class: 'stateful',
		automation: 'auto',
		preconditions: [],
		successPredicate: 'budget.rows_written_under_warn',
		undo: { none: 'the band is recomputed from the meter and clears when the meter does' },
		escalation: 'an error at or past the daily limit; owner reviews the plan limit'
	}),
	row({
		repairId: 'budget.do_requests',
		source: HOST,
		severity: 'warn',
		handle: 'degrade-band',
		class: 'stateful',
		automation: 'auto',
		preconditions: [],
		successPredicate: 'budget.do_requests_under_warn',
		undo: { none: 'the band is recomputed from the meter and clears when the meter does' },
		escalation: 'an error at or past the daily limit; owner reviews the plan limit'
	}),
	row({
		repairId: 'budget.rows_written_trend',
		source: HOST,
		severity: 'warn',
		handle: 'plan-change',
		class: 'stateful',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'budget.rows_written_trend_flat',
		undo: { none: 'a plan change is an owner act; the owner reverses it' },
		escalation: 'owner changes the plan before the projection crosses the limit'
	}),
	row({
		repairId: 'budget.do_requests_trend',
		source: HOST,
		severity: 'warn',
		handle: 'plan-change',
		class: 'stateful',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'budget.do_requests_trend_flat',
		undo: { none: 'a plan change is an owner act; the owner reverses it' },
		escalation: 'owner changes the plan before the projection crosses the limit'
	}),
	row({
		repairId: 'cache.anonymous_purity',
		source: PHP,
		severity: 'critical',
		handle: '/invalidate',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'cache.purity_clean',
		undo: CACHE_REFILLS,
		escalation: 'owner checks the anonymous cache for account pages; a repeat quarantines'
	}),
	row({
		repairId: 'cache.header_missing',
		source: PHP,
		severity: 'warn',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'cache.header_present',
		undo: NO_REPAIR,
		escalation: 'owner adds the cache header in the site code'
	}),
	row({
		repairId: 'db.txn_leaked',
		source: PHP,
		severity: 'error',
		handle: 'abandon-transaction',
		class: 'stateful',
		automation: 'approval',
		preconditions: [leaseHeld],
		successPredicate: 'db.txn_closed',
		undo: { none: 'the abandoned transaction is not replayed; its buffered writes are lost' },
		escalation: 'owner approves; abandon discards uncommitted writes'
	}),
	row({
		repairId: 'account.not_restored',
		source: PHP,
		severity: 'critical',
		handle: 'site.restore',
		class: 'stateful',
		automation: 'approval',
		preconditions: [leaseHeld],
		successPredicate: 'account.restored',
		undo: {
			none: 'a restore replaces the account table; the export taken before it is the way back'
		},
		escalation: 'owner restores from the export and checks the admin login'
	}),
	row({
		repairId: 'sql.params_over_100',
		source: PHP,
		severity: 'error',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'sql.params_within_limit',
		undo: NO_REPAIR,
		escalation: 'developer splits the query below 100 placeholders'
	}),
	row({
		repairId: 'sql.like_over_50',
		source: PHP,
		severity: 'error',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'sql.like_within_limit',
		undo: NO_REPAIR,
		escalation: 'developer shortens the LIKE pattern below 50 bytes'
	}),
	row({
		repairId: 'config.drift',
		source: PHP,
		severity: 'error',
		handle: 'config.apply',
		class: 'stateful',
		automation: 'approval',
		preconditions: [leaseHeld],
		successPredicate: 'config.matches_manifest',
		undo: { none: 'the prior configuration is not catalogued' },
		escalation: 'owner approves the config apply and reads the drifted keys'
	}),
	row({
		repairId: 'reconcile',
		source: 'worker reconcile chain',
		severity: 'warn',
		handle: 'reconcile',
		class: 'safe',
		automation: 'auto',
		preconditions: [leaseHeld, noRingPromotion, noTransaction],
		successPredicate: 'reconcile.version_current',
		undo: RECONCILE_UNDO,
		escalation: 'a step that fails three times stays visible and is not retried'
	}),
	row({
		repairId: 'overhead.reconcile-after-release',
		source: CONTROL,
		severity: 'warn',
		handle: 'reconcile',
		class: 'safe',
		automation: 'auto',
		preconditions: [leaseHeld, noRingPromotion, noTransaction],
		successPredicate: 'reconcile.version_current',
		undo: RECONCILE_UNDO,
		escalation: 'a step that fails three times stays visible and is not retried',
		unverified: true
	}),
	row({
		repairId: 'overhead.updb-beat-snapshot',
		source: CONTROL,
		severity: 'warn',
		handle: '/updb',
		class: 'stateful',
		automation: 'approval',
		preconditions: ['snapshot taken first', leaseHeld],
		successPredicate: 'updb.beat_applied',
		undo: { handle: '/updb?action=rollback' },
		escalation: 'operator reviews the snapshot before each beat',
		unverified: true
	}),
	row({
		repairId: 'overhead.cache-invalidation-after-deploy',
		source: CONTROL,
		severity: 'warn',
		handle: '/invalidate',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'cache.stale_paths_cleared',
		undo: CACHE_REFILLS,
		escalation: 'owner invalidates by hand',
		unverified: true
	}),
	row({
		repairId: 'overhead.fill-rearm-after-gap',
		source: CONTROL,
		severity: 'info',
		handle: '/armfill',
		class: 'rebuild',
		automation: 'auto-with-guard',
		preconditions: REBUILD_PRE,
		successPredicate: 'fill.gap_closed',
		undo: { none: 'queued fills warm pages; no site state changes' },
		escalation: 'owner queues the fill by hand',
		unverified: true
	}),
	row({
		repairId: 'overhead.restore-drill',
		source: CONTROL,
		severity: 'info',
		handle: 'backup.verify',
		class: 'safe',
		automation: 'auto',
		preconditions: [leaseHeld],
		successPredicate: 'backup.verified',
		undo: { none: 'the drill restores into a scratch site; the live site is not touched' },
		escalation: 'owner reads the failed probe before the backup is used',
		unverified: true
	}),
	row({
		repairId: 'overhead.certificate-drift',
		source: CONTROL,
		severity: 'warn',
		handle: 'domain.attach',
		class: 'stateful',
		automation: 'approval',
		preconditions: [leaseHeld],
		successPredicate: 'domain.tls_and_routing_valid',
		undo: { none: 'the customer owns the DNS change; the platform has nothing to reverse' },
		escalation: 'customer updates DNS as the check names',
		unverified: true
	}),
	row({
		repairId: 'overhead.advisory-alert',
		source: CONTROL,
		severity: 'warn',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'advisories.reviewed',
		undo: { none: 'an alert changes no site state' },
		escalation: 'owner updates or removes the installed module',
		unverified: true
	}),
	row({
		repairId: 'overhead.stuck-operation',
		source: CONTROL,
		severity: 'error',
		handle: 'none',
		class: 'safe',
		automation: 'manual',
		preconditions: [],
		successPredicate: 'operation.progressing',
		undo: { none: 'nothing runs; the operation stays as it is' },
		escalation: 'operator resumes or abandons the operation',
		unverified: true
	}),
	row({
		repairId: 'overhead.token-expiry',
		source: CONTROL,
		severity: 'warn',
		handle: 'notification',
		class: 'safe',
		automation: 'auto',
		preconditions: [],
		successPredicate: 'credential.valid',
		undo: { none: 'a notice changes no site state' },
		escalation: 'owner renews the token before it expires',
		unverified: true
	}),
	row({
		repairId: 'overhead.idle-archive-notice',
		source: CONTROL,
		severity: 'info',
		handle: 'notification',
		class: 'safe',
		automation: 'auto',
		preconditions: [],
		successPredicate: 'archive.notice_delivered',
		undo: { none: 'a notice changes no site state' },
		escalation: 'owner restores the site before it is archived',
		unverified: true
	})
];

export const CATALOGUE_ROWS: readonly CatalogueRow[] = ROWS;

export const CATALOGUE: ReadonlyMap<string, CatalogueRow> = new Map(
	ROWS.map((r) => [r.repairId, r])
);

export class UncataloguedRepairError extends Error {
	constructor(repairId: string) {
		super(`repair ${repairId} has no catalogue row`);
	}
}

export function assertCatalogued(
	repairId: string,
	registry: ReadonlyMap<string, CatalogueRow> = CATALOGUE
): CatalogueRow {
	const row = registry.get(repairId);
	if (!row) throw new UncataloguedRepairError(repairId);
	return row;
}
