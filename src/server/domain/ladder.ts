import { CATALOGUE, PRECONDITION, type CatalogueRow } from '../../shared/health/catalogue';
import {
	QUARANTINE_STRIKES,
	ROLLBACK_DWELL_MS,
	ROLLBACK_FAILURES,
	type Rung
} from '../../shared/health/vocab';

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
function blocker(row: CatalogueRow, facts: LadderFacts): string | null {
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
