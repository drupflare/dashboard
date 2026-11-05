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

// worker/src/ops/reconcile.ts:58-64
export const STEP_VERDICT_STATES = ['satisfied', 'owed', 'deferred'] as const;

// worker/src/ops/reconcile.ts:728-736, the report adds applied and failed
export const RECONCILE_STATES = ['satisfied', 'applied', 'owed', 'deferred', 'failed'] as const;
