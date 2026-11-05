import { describe, expect, it } from 'vitest';
import {
	CATALOGUE,
	CATALOGUE_AUTOMATION,
	CATALOGUE_CLASSES,
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
	successPredicate: () => true,
	undo: null,
	escalation: 'page a developer'
};

describe('repair catalogue', () => {
	it('ships empty until the rows arrive', () => {
		expect(CATALOGUE.size).toBe(0);
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
