import { describe, expect, it } from 'vitest';
import {
	attemptBlocker,
	decideRepair,
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

describe('attemptBlocker', () => {
	const row = { attemptBound: 3, cooldownMs: 60_000 };
	const NOW = 10_000_000;
	const ended = (status: string, ago: number) => ({ status, finishedAt: NOW - ago });

	it('allows a first attempt and one after the cool-down', () => {
		expect(attemptBlocker([], row, NOW)).toBeNull();
		expect(attemptBlocker([ended('succeeded', 60_000)], row, NOW)).toBeNull();
	});

	it('holds during the cool-down after a success or a failure', () => {
		expect(attemptBlocker([ended('succeeded', 1)], row, NOW)?.code).toBe('cooling_down');
		expect(attemptBlocker([ended('failed', 59_999)], row, NOW)?.code).toBe('cooling_down');
	});

	it('holds while an attempt is still running', () => {
		expect(attemptBlocker([{ status: 'running', finishedAt: null }], row, NOW)?.code).toBe(
			'running'
		);
	});

	it('stops at the bound of failures in a row and resets on a success', () => {
		const old = 10 * 60_000;
		const failed = [ended('failed', old), ended('failed', old + 1), ended('failed', old + 2)];
		expect(attemptBlocker(failed, row, NOW)?.code).toBe('attempts');
		expect(attemptBlocker(failed.slice(0, 2), row, NOW)).toBeNull();
		expect(
			attemptBlocker([failed[0]!, ended('succeeded', old + 1), ...failed], row, NOW)
		).toBeNull();
	});

	it('ignores a refused attempt', () => {
		const old = 10 * 60_000;
		expect(attemptBlocker([ended('refused', 1), ended('failed', old)], row, NOW)).toBeNull();
	});
});

describe('decideRepair', () => {
	const input = (over: Partial<Parameters<typeof decideRepair>[0]> = {}) => ({
		history: run(1),
		facts: base,
		switches: { global: true },
		orgId: 'org_a',
		hasHandler: () => true,
		past: () => [],
		recent: [],
		budget: { perOrgPerHour: 1, fleetPerHour: 5 },
		...over
	});

	it('starts the catalogue repair for the failing code', () => {
		expect(decideRepair(input())).toMatchObject({ start: true, repairId: 'render.empty' });
	});

	it.each([
		['the switch is off', { switches: { global: undefined } }, 'automatic repair is off'],
		['no code is failing', { history: [] }, 'no failures'],
		['the repair needs approval', { history: run(1, 'migrate.incomplete') }, 'needs a person'],
		['the repair has no handler', { hasHandler: () => false }, 'no automatic handler'],
		['the site is shedding', { facts: { ...base, shedding: true } }, 'not shedding load'],
		['the site is quarantined', { history: run(QUARANTINE_STRIKES) }, 'quarantined'],
		[
			'the budget is spent',
			{ recent: [{ orgId: 'org_a', atMs: base.nowMs - 1 }] },
			'organisation repair budget spent for the hour'
		]
	])('holds when %s', (_name, over, reason) => {
		const decision = decideRepair(input(over));
		expect(decision.start).toBe(false);
		expect(decision.reason).toContain(reason);
	});
});
