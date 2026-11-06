import { CATALOGUE } from '../../shared/health/catalogue';
import { HEALTH_LEVELS, type Rung, type Severity } from '../../shared/health/vocab';

export type HealthLevel = (typeof HEALTH_LEVELS)[number];

export type HealthSource = 'reconcile' | 'supervisor' | 'repair';

export type HistoryEvent = { state: string; atMs: number };

export type HealthNode = {
	id: string;
	source: HealthSource;
	level: HealthLevel;
	state: string;
	title: string;
	detail: string;
	handle: string | null;
	history: HistoryEvent[];
	children: HealthNode[];
};

export type HealthTree = { level: HealthLevel; nodes: HealthNode[] };

export type FindingInput = { code: string; severity: Severity; scope: string; context: string };

export type ReconcileStepInput = { id: string; state: string; describe: string; detail: string };

export type HealthTreeInput = {
	findings?: readonly FindingInput[];
	reconcile?: { version: number; packVersion: number; steps: readonly ReconcileStepInput[] };
	repair?: { rung: Rung; code: string | null; strikes: number };
	history?: Readonly<Record<string, readonly HistoryEvent[]>>;
};

export function worse(a: HealthLevel, b: HealthLevel): HealthLevel {
	return HEALTH_LEVELS.indexOf(a) >= HEALTH_LEVELS.indexOf(b) ? a : b;
}

const RECONCILE_LEVEL: Record<string, HealthLevel> = {
	satisfied: 'ok',
	applied: 'ok',
	deferred: 'info',
	owed: 'warn',
	failed: 'error'
};

function handleOf(key: string): string | null {
	return CATALOGUE.get(key)?.handle ?? null;
}

function historyOf(history: HealthTreeInput['history'], id: string): HistoryEvent[] {
	return [...(history?.[id] ?? [])];
}

function fold(children: HealthNode[]): HealthLevel {
	return children.reduce<HealthLevel>((l, c) => worse(l, c.level), 'ok');
}

function reconcileChain(
	r: NonNullable<HealthTreeInput['reconcile']>,
	history: HealthTreeInput['history']
): HealthNode {
	const children = r.steps.map((step): HealthNode => ({
		id: `reconcile.${step.id}`,
		source: 'reconcile',
		level: RECONCILE_LEVEL[step.state] ?? 'warn',
		state: step.state,
		title: step.describe,
		detail: step.detail,
		handle: handleOf('reconcile'),
		history: historyOf(history, `reconcile.${step.id}`),
		children: []
	}));
	return {
		id: 'reconcile',
		source: 'reconcile',
		level: fold(children),
		state: r.version < r.packVersion ? 'behind' : 'current',
		title: 'Reconciliation with the shipping pack',
		detail: `version ${r.version} of ${r.packVersion}`,
		handle: null,
		history: historyOf(history, 'reconcile'),
		children
	};
}

function supervisorChain(
	findings: readonly FindingInput[],
	history: HealthTreeInput['history']
): HealthNode {
	const children = findings.map((f): HealthNode => ({
		id: `supervisor.${f.code}`,
		source: 'supervisor',
		level: f.severity,
		state: f.severity,
		title: f.scope === '' ? f.code : `${f.code} on ${f.scope}`,
		detail: f.context,
		handle: handleOf(f.code),
		history: historyOf(history, `supervisor.${f.code}`),
		children: []
	}));
	return {
		id: 'supervisor',
		source: 'supervisor',
		level: fold(children),
		state: children.length === 0 ? 'clear' : 'findings',
		title: 'Host tripwires from the last supervised alarm',
		detail: children.length === 0 ? '' : `${children.length} finding(s)`,
		handle: null,
		history: historyOf(history, 'supervisor'),
		children
	};
}

function repairLadder(
	r: NonNullable<HealthTreeInput['repair']>,
	history: HealthTreeInput['history']
): HealthNode {
	const quarantined = r.rung === 'quarantine' || r.rung === 'rollback';
	return {
		id: 'repair',
		source: 'repair',
		level: quarantined ? 'critical' : r.strikes > 0 ? 'warn' : 'ok',
		state: r.rung,
		title: 'Repair ladder',
		detail: r.code === null ? '' : `${r.strikes} strike(s) on ${r.code}`,
		handle: null,
		history: historyOf(history, 'repair'),
		children: []
	};
}

export function buildHealthTree(input: HealthTreeInput): HealthTree {
	const nodes: HealthNode[] = [];
	if (input.reconcile) nodes.push(reconcileChain(input.reconcile, input.history));
	nodes.push(supervisorChain(input.findings ?? [], input.history));
	if (input.repair) nodes.push(repairLadder(input.repair, input.history));
	return { level: fold(nodes), nodes };
}

// records a state only when it differs from the last one, so a steady site adds nothing
export function appendHistory(
	history: Readonly<Record<string, readonly HistoryEvent[]>>,
	id: string,
	state: string,
	atMs: number
): Record<string, readonly HistoryEvent[]> {
	const prior = history[id] ?? [];
	if (prior[prior.length - 1]?.state === state) return { ...history };
	return { ...history, [id]: [...prior, { state, atMs }] };
}
