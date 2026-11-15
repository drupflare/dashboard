import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isAutomatic, REPAIR_HANDLES } from '../../../../engine/src/repair/handles';
import {
	CATALOGUE,
	CATALOGUE_ROWS,
	type CatalogueRow
} from '../../../../src/shared/health/catalogue';
import {
	evaluatePredicate,
	PREDICATES,
	UnknownPredicateError,
	type Observation
} from '../../../../src/shared/health/predicate';
import { BREAKER_WINDOW_MS } from '../../../../src/shared/health/vocab';
import { inputOf, parsed, repairWorld, runRepair } from '../../engine/repair-fakes';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// the three ways code names a repair id as a handle: a call that checks the catalogue, a lookup in
// the handler table and a catalogue read
const USES = [
	/(?:assertCatalogued|repairHandle)\(\s*['"]([^'"]+)['"]/g,
	/REPAIR_HANDLES\[\s*['"]([^'"]+)['"]\s*\]/g,
	/CATALOGUE\.get\(\s*['"]([^'"]+)['"]\s*\)/g
];

function repairIdsUsed(sources: Readonly<Record<string, string>>) {
	const found: { id: string; path: string }[] = [];
	for (const [path, text] of Object.entries(sources)) {
		for (const pattern of USES) {
			for (const match of text.matchAll(pattern)) found.push({ id: match[1]!, path });
		}
	}
	return found;
}

function withoutRow(
	sources: Readonly<Record<string, string>>,
	registry: ReadonlyMap<string, CatalogueRow> = CATALOGUE
) {
	return repairIdsUsed(sources).filter(({ id }) => !registry.has(id));
}

function sourcesUnder(...dirs: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const dir of dirs) {
		for (const entry of readdirSync(`${ROOT}${dir}`, { recursive: true, encoding: 'utf8' })) {
			if (!/\.(ts|vue)$/.test(entry) || entry.includes('vendor/')) continue;
			out[`${dir}/${entry}`] = readFileSync(`${ROOT}${dir}/${entry}`, 'utf8');
		}
	}
	return out;
}

describe('repair ids named in code', () => {
	it('all have a catalogue row', () => {
		const used = repairIdsUsed(sourcesUnder('src', 'engine/src'));
		expect(used.length).toBeGreaterThan(0);
		expect(withoutRow(sourcesUnder('src', 'engine/src'))).toEqual([]);
	});

	it('reports an id with no row', () => {
		const fake = {
			'engine/src/fake.ts': `
				assertCatalogued('no.such.row');
				const a = REPAIR_HANDLES["also.missing"];
				const b = CATALOGUE.get('render.empty');
				repairHandle('third.missing');
			`
		};
		expect(withoutRow(fake).map((hit) => hit.id)).toEqual([
			'no.such.row',
			'third.missing',
			'also.missing'
		]);
		expect(repairIdsUsed(fake).map((hit) => hit.id)).toContain('render.empty');
	});
});

describe('the catalogue and its handlers', () => {
	it.each(CATALOGUE_ROWS.map((row) => [row.repairId, row] as const))(
		'gives %s a handler exactly when it runs without a person',
		(id, row) => {
			expect(REPAIR_HANDLES[id] !== undefined).toBe(isAutomatic(row));
		}
	);

	it('has an evaluator for every success predicate and none that no row names', () => {
		const named = new Set(CATALOGUE_ROWS.map((row) => row.successPredicate));
		for (const id of named) expect(PREDICATES[id], id).toBeTypeOf('function');
		expect(Object.keys(PREDICATES).sort()).toEqual([...named].sort());
	});

	it('reads every predicate true on a healthy site and false on a failing one', () => {
		const ids = Object.keys(PREDICATES);
		const healthy: Observation = {
			findings: [],
			owed: 0,
			facts: Object.fromEntries(ids.map((id) => [id, true]))
		};
		const failing: Observation = {
			findings: CATALOGUE_ROWS.map((row) => row.repairId),
			owed: 2,
			facts: {}
		};
		for (const id of ids) {
			expect(evaluatePredicate(id, healthy), id).toBe(true);
			expect(evaluatePredicate(id, failing), id).toBe(false);
		}
	});

	it('reads a reconcile predicate false when the report is missing', () => {
		const unknown: Observation = { findings: [], owed: null, facts: {} };
		expect(evaluatePredicate('reconcile.version_current', unknown)).toBe(false);
	});

	it('throws on a predicate id nobody evaluates', () => {
		expect(() =>
			evaluatePredicate('no.such.predicate', { findings: [], owed: 0, facts: {} })
		).toThrow(UnknownPredicateError);
	});
});

describe('the run path', () => {
	const verified = CATALOGUE_ROWS.filter(
		(row) => isAutomatic(row) && REPAIR_HANDLES[row.repairId]!.verified
	);

	it('evaluates the success predicate after every handler that runs', async () => {
		const predicate = await import('../../../../src/shared/health/predicate');
		const spy = vi.spyOn(predicate, 'evaluatePredicate');
		try {
			for (const row of verified) {
				const rw = await repairWorld();
				if (row.handle === 'reconcile') rw.site.state.owed = 2;
				if (row.handle === '/armfill') rw.site.state.queued = 1;
				spy.mockClear();
				await runRepair(rw, inputOf(rw, row.repairId));
				expect(spy, row.repairId).toHaveBeenCalledTimes(1);
				expect(spy.mock.calls[0]![0], row.repairId).toBe(row.successPredicate);
				expect(parsed(rw.records()[0]!.observation_after).predicate.id).toBe(
					row.successPredicate
				);
			}
		} finally {
			spy.mockRestore();
		}
	});

	it('runs no handler and evaluates nothing for a row the site has no route for', async () => {
		const predicate = await import('../../../../src/shared/health/predicate');
		const spy = vi.spyOn(predicate, 'evaluatePredicate');
		try {
			const rw = await repairWorld();
			const row: CatalogueRow = {
				...CATALOGUE.get('render.empty')!,
				repairId: 'test.unrouted'
			};
			const registries = {
				catalogue: new Map([...CATALOGUE, [row.repairId, row]]),
				handles: {
					...REPAIR_HANDLES,
					[row.repairId]: {
						verified: false,
						run: async () => ({ ok: false, detail: '' })
					}
				},
				undo: {}
			};
			await runRepair(rw, inputOf(rw, row.repairId), { registries });
			expect(rw.records()[0]!.status).toBe('refused');
			expect(rw.site.state.calls).toEqual([]);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it('fails a run whose success predicate nobody evaluates', async () => {
		const rw = await repairWorld();
		const row: CatalogueRow = {
			...CATALOGUE.get('render.empty')!,
			repairId: 'test.unevaluated',
			successPredicate: 'no.such.predicate'
		};
		const registries = {
			catalogue: new Map([...CATALOGUE, [row.repairId, row]]),
			handles: {
				...REPAIR_HANDLES,
				[row.repairId]: { verified: true, run: async () => ({ ok: true, detail: 'ran' }) }
			},
			undo: {}
		};
		rw.world.clock.advance(BREAKER_WINDOW_MS + 1);
		const { outcome } = await runRepair(rw, inputOf(rw, row.repairId), { registries });
		expect(outcome.status).toBe('failed');
		expect((outcome as { reason: string }).reason).toContain('no evaluator');
		expect(rw.records()[0]!.status).toBe('failed');
	});
});
