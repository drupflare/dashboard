import { describe, expect, it } from 'vitest';
import {
	maySafelyRepair,
	nextRung,
	type LadderFacts,
	type LadderOutcome
} from '../../../src/server/domain/ladder';
import {
	QUARANTINE_STRIKES,
	ROLLBACK_DWELL_MS,
	ROLLBACK_FAILURES
} from '../../../src/shared/health/vocab';

const good: LadderOutcome = { ok: true };
const bad = (code = 'render.empty'): LadderOutcome => ({ ok: false, code });
const run = (n: number, code = 'render.empty'): LadderOutcome[] =>
	Array.from({ length: n }, () => bad(code));

const base: LadderFacts = {
	nowMs: 10_000_000,
	quarantinedAt: null,
	restorePoint: undefined,
	transactionDepth: 0,
	gateHeld: false,
	shedding: false,
	leaseHeld: true,
	ringPromotion: false
};

// every history up to maxLen over a clean pass and two failure codes
function histories(maxLen: number): LadderOutcome[][] {
	const alphabet: LadderOutcome[] = [good, bad('a'), bad('b')];
	const out: LadderOutcome[][] = [[]];
	let frontier: LadderOutcome[][] = [[]];
	for (let len = 1; len <= maxLen; len++) {
		frontier = frontier.flatMap((h) => alphabet.map((o) => [...h, o]));
		out.push(...frontier);
	}
	return out;
}

// independent of nextRung: the same-code failures at the end of the history
function trailing(h: LadderOutcome[]): number {
	const last = h[h.length - 1];
	if (!last || last.ok) return 0;
	let n = 0;
	for (let i = h.length - 1; i >= 0; i--) {
		const o = h[i]!;
		if (o.ok || o.code !== last.code) break;
		n++;
	}
	return n;
}

describe('nextRung strikes', () => {
	it('quarantines at the third same-code strike', () => {
		const step = nextRung(run(QUARANTINE_STRIKES - 1), base);
		expect(step.rung).toBe('observe');
		expect(step.strikes).toBe(QUARANTINE_STRIKES - 1);

		const at = nextRung(run(QUARANTINE_STRIKES), base);
		expect(at.rung).toBe('quarantine');
		expect(at.quarantinedAt).toBe(base.nowMs);
	});

	it('never leaves a run of three or more same-code failures below quarantine', () => {
		for (const h of histories(5)) {
			if (trailing(h) < QUARANTINE_STRIKES) continue;
			const step = nextRung(h, base);
			expect(['quarantine', 'rollback']).toContain(step.rung);
		}
	});

	it('resets the count when the failure code changes', () => {
		const step = nextRung([...run(2, 'a'), bad('b')], base);
		expect(step.rung).toBe('observe');
		expect(step.strikes).toBe(1);
	});

	it('keeps quarantine after a clean pass', () => {
		const quarantined = { ...base, quarantinedAt: base.nowMs - 1 };
		const step = nextRung([...run(3), good], quarantined);
		expect(step.rung).toBe('quarantine');
		expect(step.strikes).toBe(0);
	});
});

describe('nextRung rollback', () => {
	const dwelled = {
		...base,
		quarantinedAt: base.nowMs - ROLLBACK_DWELL_MS,
		restorePoint: { id: 7, statements: 42 }
	};

	it('rolls back at ten failures with dwell and a restore point', () => {
		expect(nextRung(run(ROLLBACK_FAILURES - 1), dwelled).rung).toBe('quarantine');
		expect(nextRung(run(ROLLBACK_FAILURES), dwelled).rung).toBe('rollback');
	});

	it('waits for the full dwell', () => {
		const early = { ...dwelled, quarantinedAt: base.nowMs - ROLLBACK_DWELL_MS + 1 };
		expect(nextRung(run(ROLLBACK_FAILURES), early).rung).toBe('quarantine');
	});

	it('never rolls back without a restore point or with an empty one', () => {
		const none = { ...dwelled, restorePoint: undefined };
		const empty = { ...dwelled, restorePoint: { id: 7, statements: 0 } };
		expect(nextRung(run(ROLLBACK_FAILURES), none).rung).toBe('quarantine');
		expect(nextRung(run(ROLLBACK_FAILURES), empty).rung).toBe('quarantine');
	});

	it('rolls back only when every gate holds, across every short history', () => {
		const variants: LadderFacts[] = [
			dwelled,
			{ ...dwelled, restorePoint: undefined },
			{ ...dwelled, transactionDepth: 1 },
			{ ...dwelled, gateHeld: true },
			{ ...dwelled, quarantinedAt: null }
		];
		for (const h of histories(5)) {
			for (const facts of variants) {
				const step = nextRung(h, facts);
				if (step.rung !== 'rollback') continue;
				expect(trailing(h)).toBeGreaterThanOrEqual(ROLLBACK_FAILURES);
				expect(facts.quarantinedAt).not.toBeNull();
				expect(facts.restorePoint?.statements ?? 0).toBeGreaterThan(0);
				expect(maySafelyRepair(facts)).toBe(true);
			}
		}
	});
});

describe('maySafelyRepair', () => {
	it('fails closed on an unknown transaction depth', () => {
		expect(maySafelyRepair({ ...base, transactionDepth: undefined })).toBe(false);
	});

	it('refuses an open transaction or a held gate', () => {
		expect(maySafelyRepair({ ...base, transactionDepth: 1 })).toBe(false);
		expect(maySafelyRepair({ ...base, gateHeld: true })).toBe(false);
	});

	it('allows a repair with nothing open and the gate free', () => {
		expect(maySafelyRepair(base)).toBe(true);
	});
});

describe('nextRung preconditions', () => {
	it('blocks a repair inside an open transaction', () => {
		const step = nextRung(run(QUARANTINE_STRIKES), { ...base, transactionDepth: 1 });
		expect(step.mayRun).toBe(false);
	});

	it('blocks a rebuild repair while the site sheds load', () => {
		expect(nextRung(run(QUARANTINE_STRIKES), { ...base, shedding: true }).mayRun).toBe(false);
		expect(nextRung(run(QUARANTINE_STRIKES), base).mayRun).toBe(true);
	});

	it('never runs a manual repair', () => {
		expect(nextRung(run(QUARANTINE_STRIKES, 'updb.halted'), base).mayRun).toBe(false);
	});

	it('fails closed for a code with no catalogue row', () => {
		const step = nextRung(run(QUARANTINE_STRIKES, 'no.such.code'), base);
		expect(step.repair).toBeNull();
		expect(step.mayRun).toBe(false);
	});
});
