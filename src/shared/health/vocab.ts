// worker/src/ops/health-tree.ts:14
export const HEALTH_LEVELS = ['ok', 'info', 'warn', 'error', 'critical'] as const;

// worker/src/ops/supervisor.ts:8-13
export const SEVERITY_LEVELS = ['info', 'warn', 'error', 'critical'] as const;

export type Severity = (typeof SEVERITY_LEVELS)[number];

// worker/src/ops/repair.ts:2-9
export const RUNGS = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;

export type Rung = (typeof RUNGS)[number];

// worker/src/ops/repair.ts QUARANTINE_STRIKES
export const QUARANTINE_STRIKES = 3;

// worker/src/ops/repair.ts ROLLBACK_DWELL_MS
export const ROLLBACK_DWELL_MS = 30 * 60_000;

// worker/docs/architecture/index.md states ten; shouldRollback in worker/src/ops/repair.ts does not count it
export const ROLLBACK_FAILURES = 10;

// drupflare/src/Health/CircuitBreaker.php default window
export const BREAKER_WINDOW_MS = 60_000;

export const CATALOGUE_CLASSES = ['safe', 'rebuild', 'stateful'] as const;

export type RepairClass = (typeof CATALOGUE_CLASSES)[number];

export const CATALOGUE_AUTOMATION = ['auto', 'auto-with-guard', 'approval', 'manual'] as const;

export type AutomationLevel = (typeof CATALOGUE_AUTOMATION)[number];

// worker/src/ops/reconcile.ts:58-64
export const STEP_VERDICT_STATES = ['satisfied', 'owed', 'deferred'] as const;

// worker/src/ops/reconcile.ts:728-736, the report adds applied and failed
export const RECONCILE_STATES = ['satisfied', 'applied', 'owed', 'deferred', 'failed'] as const;
