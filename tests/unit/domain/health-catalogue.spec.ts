import { describe, expect, it } from 'vitest';
import { buildHealthTree } from '../../../src/server/domain/health-tree';
import { nextRung } from '../../../src/server/domain/ladder';
import {
	CATALOGUE,
	CATALOGUE_ROWS,
	KNOWN_PRECONDITIONS
} from '../../../src/shared/health/catalogue';
import { QUARANTINE_STRIKES } from '../../../src/shared/health/vocab';

// read from worker/src/ops/supervisor.ts (HOST_TRIPWIRES and budgetPressure, budgetTrendProjected)
// and drupflare/src/Health/Tripwire/*.php (code())
const TRIPWIRE_CODES = [
	'render.empty',
	'render.size_anomaly',
	'bridge.asyncify_called',
	'bridge.mask_leaked',
	'db.semaphore_dirty',
	'migrate.incomplete',
	'updb.halted',
	'pack.generation_mismatch',
	'memory.highwater_rising',
	'memory.trend_rising',
	'health.ledger_oversized',
	'budget.image_transforms',
	'budget.rows_written',
	'budget.do_requests',
	'budget.rows_written_trend',
	'budget.do_requests_trend',
	'cache.anonymous_purity',
	'cache.header_missing',
	'db.txn_leaked',
	'account.not_restored',
	'sql.params_over_100',
	'sql.like_over_50',
	'config.drift'
];

describe('every repair has a catalogue row', () => {
	it('covers each tripwire code the ladder and the health tree can act on', () => {
		for (const code of TRIPWIRE_CODES) {
			expect(CATALOGUE.has(code), code).toBe(true);
			const step = nextRung(
				Array.from({ length: QUARANTINE_STRIKES }, () => ({ ok: false, code })),
				{
					nowMs: 0,
					quarantinedAt: null,
					restorePoint: undefined,
					transactionDepth: 0,
					gateHeld: false,
					shedding: false,
					leaseHeld: true,
					ringPromotion: false
				}
			);
			expect(step.repair, code).toBe(code);
			const tree = buildHealthTree({
				findings: [{ code, severity: 'warn', scope: '', context: '' }]
			});
			expect(tree.nodes[0]?.children[0]?.handle, code).not.toBeNull();
		}
	});

	it('gives the reconcile chain a row for its steps', () => {
		expect(CATALOGUE.get('reconcile')?.handle).toBe('reconcile');
	});

	it('keeps every row keyed by its own repair id, with no duplicates', () => {
		for (const [key, row] of CATALOGUE) expect(row.repairId).toBe(key);
		expect(CATALOGUE.size).toBe(CATALOGUE_ROWS.length);
	});
});

describe('every row is complete', () => {
	it('has a success predicate that names a re-observation', () => {
		for (const row of CATALOGUE.values()) {
			expect(row.successPredicate, row.repairId).toMatch(/^[a-z][a-z0-9_.-]*$/);
		}
	});

	it('has an undo handle or an explicit none with a reason', () => {
		for (const row of CATALOGUE.values()) {
			const undo = row.undo;
			if ('handle' in undo) expect(undo.handle, row.repairId).not.toBe('');
			else expect(undo.none.trim(), row.repairId).not.toBe('');
		}
	});

	it('has a positive attempt bound and a non-negative cool-down', () => {
		for (const row of CATALOGUE.values()) {
			expect(row.attemptBound, row.repairId).toBeGreaterThanOrEqual(1);
			expect(row.cooldownMs, row.repairId).toBeGreaterThanOrEqual(0);
		}
	});

	it('guards every rebuild row against load shedding', () => {
		for (const row of CATALOGUE.values()) {
			if (row.class !== 'rebuild') continue;
			expect(row.preconditions, row.repairId).toContain('not shedding load');
		}
	});

	it('uses only known preconditions in rows that run unattended', () => {
		for (const row of CATALOGUE.values()) {
			if (row.automation !== 'auto' && row.automation !== 'auto-with-guard') continue;
			for (const pre of row.preconditions) {
				expect(KNOWN_PRECONDITIONS, `${row.repairId}: ${pre}`).toContain(pre);
			}
		}
	});
});
