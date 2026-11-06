import { describe, expect, it } from 'vitest';
import {
	CATALOGUE,
	CATALOGUE_AUTOMATION,
	CATALOGUE_CLASSES,
	CATALOGUE_ROWS,
	UncataloguedRepairError,
	assertCatalogued,
	type CatalogueRow
} from '../../../../src/shared/health/catalogue';

const row: CatalogueRow = {
	repairId: 'fixture.repair',
	source: 'fixture',
	severity: 'warn',
	handle: '/fixture',
	class: 'safe',
	automation: 'auto',
	preconditions: ['no open transaction'],
	attemptBound: 3,
	cooldownMs: 60_000,
	successPredicate: 'fixture.observe',
	undo: { none: 'the fixture changes nothing' },
	escalation: 'page a developer'
};

describe('repair catalogue', () => {
	it('registers every row once', () => {
		expect(CATALOGUE_ROWS.length).toBeGreaterThan(0);
		expect(CATALOGUE.size).toBe(CATALOGUE_ROWS.length);
	});

	it('uses the plan classes and automation levels', () => {
		expect([...CATALOGUE_CLASSES]).toEqual(['safe', 'rebuild', 'stateful']);
		expect([...CATALOGUE_AUTOMATION]).toEqual([
			'auto',
			'auto-with-guard',
			'approval',
			'manual'
		]);
	});

	it('throws UncataloguedRepairError for a repair with no row', () => {
		expect(() => assertCatalogued('fixture.repair')).toThrow(UncataloguedRepairError);
		expect(() => assertCatalogued('fixture.repair')).toThrow('fixture.repair');
	});

	it('returns the row when one is registered', () => {
		const registry = new Map([[row.repairId, row]]);
		expect(assertCatalogued('fixture.repair', registry)).toBe(row);
	});
});
