import { describe, expect, it } from 'vitest';
import { guardRollback } from '../../../src/server/domain/rollback-guard';

// the previous release accepts data up to schema 3; the new one leaves a site at schema 4
const previous = { schemaVersion: 3, acceptsSchema: 3 };

describe('guardRollback', () => {
	it('refuses a code-only rollback when the release moved the schema past what the old code accepts', () => {
		const verdict = guardRollback({ dataSchemaVersion: 4, target: previous });
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.reason).toContain('changed how this site stores its data');
		expect(verdict.offers).toEqual(['restore-data-with-code', 'fix-forward']);
	});

	it('allows the rollback when the data schema equals what the old code accepts', () => {
		expect(guardRollback({ dataSchemaVersion: 3, target: previous })).toEqual({
			allowed: true
		});
	});

	it('allows the rollback when the data schema is below what the old code accepts', () => {
		expect(guardRollback({ dataSchemaVersion: 0, target: previous })).toEqual({
			allowed: true
		});
	});

	it('fails closed with its own reason when the data schema is unknown', () => {
		const verdict = guardRollback({ dataSchemaVersion: null, target: previous });
		expect(verdict.allowed).toBe(false);
		if (verdict.allowed) return;
		expect(verdict.reason).toContain("can't tell which data version");
		expect(verdict.offers).toEqual(['restore-data-with-code', 'fix-forward']);
	});

	it('keeps internal names out of the owner-facing reasons', () => {
		for (const dataSchemaVersion of [null, 9]) {
			const verdict = guardRollback({ dataSchemaVersion, target: previous });
			if (verdict.allowed) throw new Error('expected a refusal');
			expect(verdict.reason).not.toMatch(/schema_?version|acceptsSchema|D1|Durable/i);
		}
	});
});
