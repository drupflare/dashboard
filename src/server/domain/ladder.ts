import { CATALOGUE, PRECONDITION, type CatalogueRow } from '../../shared/health/catalogue';
import {
	QUARANTINE_STRIKES,
	ROLLBACK_DWELL_MS,
	ROLLBACK_FAILURES,
	type Rung
} from '../../shared/health/vocab';
import {
	admitRepair,
	autoRepairOn,
	type RepairBudget,
	type RepairRecord as SpentRepair
} from './incidents';

export type LadderOutcome = { ok: boolean; code?: string };

export type LadderFacts = {
	nowMs: number;
	// set when the site quarantines; stays set until an explicit release
	quarantinedAt: number | null;
	restorePoint: { id: number; statements: number } | undefined;
	// undefined means the lane cannot tell, which fails closed
	transactionDepth: number | undefined;
	gateHeld: boolean;
	shedding: boolean;
	leaseHeld: boolean;
	ringPromotion: boolean;
};

export type LadderStep = {
	rung: Rung;
	code: string | null;
	strikes: number;
	quarantinedAt: number | null;
	rollback: boolean;
	// the catalogue repair for the failing code, or null when there is none
	repair: string | null;
	// whether that repair's preconditions hold now; the caller decides whether to run it
	mayRun: boolean;
	reason: string;
};

const HOLDS: Record<string, (f: LadderFacts) => boolean> = {
	[PRECONDITION.notShedding]: (f) => !f.shedding,
	[PRECONDITION.leaseHeld]: (f) => f.leaseHeld,
	[PRECONDITION.noTransaction]: (f) => f.transactionDepth === 0,
	[PRECONDITION.noRingPromotion]: (f) => !f.ringPromotion
};

export function maySafelyRepair(
	facts: Pick<LadderFacts, 'transactionDepth' | 'gateHeld'>
): boolean {
	return facts.transactionDepth === 0 && !facts.gateHeld;
}

// a row's blocking precondition, or null when the repair may run; unknown preconditions fail closed
export function blocker(row: CatalogueRow, facts: LadderFacts): string | null {
	if (row.automation === 'manual') return 'manual repair';
	if (!maySafelyRepair(facts)) return 'open transaction or gate held';
	for (const pre of row.preconditions) {
		const holds = HOLDS[pre];
		if (!holds || !holds(facts)) return pre;
	}
	return null;
}

function rollbackBlocker(strikes: number, dwellMs: number, facts: LadderFacts): string | null {
	if (strikes < ROLLBACK_FAILURES) return `${strikes} of ${ROLLBACK_FAILURES} failures`;
	if (dwellMs < ROLLBACK_DWELL_MS) return 'dwell not reached';
	if (!facts.restorePoint) return 'no restore point';
	if (facts.restorePoint.statements <= 0) return 'restore point is empty';
	if (!maySafelyRepair(facts)) return 'open transaction or gate held';
	if (!facts.leaseHeld) return 'site lease not held';
	if (facts.ringPromotion) return 'ring promotion in progress';
	return null;
}

// the same-code run at the end of the history; a clean pass or another code ends it
function sameCodeRun(history: readonly LadderOutcome[]): { code: string | null; strikes: number } {
	const last = history[history.length - 1];
	if (!last || last.ok) return { code: null, strikes: 0 };
	const code = last.code ?? 'unknown';
	let strikes = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const o = history[i]!;
		if (o.ok || (o.code ?? 'unknown') !== code) break;
		strikes++;
	}
	return { code, strikes };
}

export function nextRung(history: readonly LadderOutcome[], facts: LadderFacts): LadderStep {
	const { code, strikes } = sameCodeRun(history);
	const quarantinedAt =
		facts.quarantinedAt ?? (strikes >= QUARANTINE_STRIKES ? facts.nowMs : null);
	const row = code === null ? undefined : CATALOGUE.get(code);
	const repair = row?.repairId ?? null;
	const mayRun = row !== undefined && blocker(row, facts) === null;

	const base = { code, strikes, quarantinedAt, repair, mayRun };
	if (quarantinedAt === null) {
		return {
			...base,
			rung: 'observe',
			rollback: false,
			reason:
				strikes === 0
					? 'no failures'
					: `${strikes} of ${QUARANTINE_STRIKES} strikes on ${code}`
		};
	}

	const block = rollbackBlocker(strikes, facts.nowMs - quarantinedAt, facts);
	if (block === null) {
		return {
			...base,
			rung: 'rollback',
			rollback: true,
			reason: `quarantined for ${code}; replaying restore point ${facts.restorePoint!.id}`
		};
	}
	return {
		...base,
		rung: 'quarantine',
		rollback: false,
		reason: `quarantined for ${code}; rollback waits: ${block}`
	};
}

export type PastAttempt = { status: string; finishedAt: number | null };

export type AttemptBlock = { code: 'attempts' | 'cooling_down' | 'running'; reason: string };

// past is newest first. A refused attempt ran nothing, so it neither counts nor cools anything
export function attemptBlocker(
	past: readonly PastAttempt[],
	row: Pick<CatalogueRow, 'attemptBound' | 'cooldownMs'>,
	nowMs: number
): AttemptBlock | null {
	const ran = past.filter((a) => a.status !== 'refused');
	const last = ran[0];
	if (last?.status === 'running') {
		return { code: 'running', reason: 'a repair of this kind is already running' };
	}
	let failures = 0;
	for (const attempt of ran) {
		if (attempt.status !== 'failed') break;
		failures++;
	}
	if (failures >= row.attemptBound) {
		return { code: 'attempts', reason: `${failures} attempts failed in a row` };
	}
	if (last?.finishedAt != null && nowMs - last.finishedAt < row.cooldownMs) {
		return { code: 'cooling_down', reason: 'the last attempt finished moments ago' };
	}
	return null;
}

export type RepairDecision =
	| { start: true; repairId: string; rung: Rung; reason: string }
	| { start: false; reason: string };

// the unattended decision: a repair starts only when every gate says so, and the first closed gate
// is the reason. Rungs past observe (quarantine, rollback) are not catalogue repairs
export function decideRepair(input: {
	history: readonly LadderOutcome[];
	facts: LadderFacts;
	switches: { global: boolean | undefined; org?: boolean; site?: boolean };
	orgId: string;
	hasHandler: (repairId: string) => boolean;
	past: (repairId: string) => readonly PastAttempt[];
	recent: readonly SpentRepair[];
	budget: RepairBudget;
}): RepairDecision {
	if (!autoRepairOn(input.switches)) {
		return { start: false, reason: 'automatic repair is off' };
	}
	const step = nextRung(input.history, input.facts);
	if (step.repair === null) return { start: false, reason: step.reason };
	if (step.rung !== 'observe') return { start: false, reason: step.reason };
	const row = CATALOGUE.get(step.repair);
	if (!row || (row.automation !== 'auto' && row.automation !== 'auto-with-guard')) {
		return { start: false, reason: `${step.repair} needs a person` };
	}
	if (!input.hasHandler(row.repairId)) {
		return { start: false, reason: `${row.repairId} has no automatic handler` };
	}
	const block = blocker(row, input.facts);
	if (block !== null) return { start: false, reason: block };
	const attempts = attemptBlocker(input.past(row.repairId), row, input.facts.nowMs);
	if (attempts !== null) return { start: false, reason: attempts.reason };
	const admitted = admitRepair(
		input.recent,
		{ orgId: input.orgId, nowMs: input.facts.nowMs },
		input.budget
	);
	if (!admitted.admit) return { start: false, reason: admitted.reason };
	return { start: true, repairId: row.repairId, rung: step.rung, reason: step.reason };
}
