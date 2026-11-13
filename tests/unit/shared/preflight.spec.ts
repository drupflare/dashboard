import { describe, expect, it } from 'vitest';
import {
	CMS_LABELS,
	CMS_NAMES,
	PREFLIGHT_FAILURES,
	PREFLIGHT_REFUSALS,
	SIGNAL_KINDS,
	SIGNAL_LABELS,
	VERDICTS,
	VERDICT_LABELS,
	normalizeAddress,
	preflightBodySchema,
	preflightResultSchema
} from '../../../src/shared/preflight';

describe('normalizeAddress', () => {
	it.each([
		['example.edu', 'https://example.edu'],
		['  www.example.edu/page ', 'https://www.example.edu/page'],
		['http://example.edu', 'http://example.edu'],
		['HTTPS://example.edu', 'HTTPS://example.edu'],
		['ftp://example.edu', 'ftp://example.edu'],
		['example.edu:8080', 'https://example.edu:8080']
	])('turns %s into %s', (input, output) => {
		expect(normalizeAddress(input)).toBe(output);
	});
});

describe('preflight copy', () => {
	it('writes every refusal and failure as one plain sentence', () => {
		for (const sentence of [
			...Object.values(PREFLIGHT_REFUSALS),
			...Object.values(PREFLIGHT_FAILURES)
		]) {
			expect(sentence).toMatch(/^[A-Z].*\.$/);
			expect(sentence).not.toMatch(/_|—/);
		}
	});

	it('labels every verdict, system and signal kind in Title Case', () => {
		for (const verdict of VERDICTS) expect(VERDICT_LABELS[verdict]).toMatch(/^[A-Z]/);
		for (const cms of CMS_NAMES) expect(CMS_LABELS[cms]).toMatch(/^[A-Z]/);
		for (const kind of SIGNAL_KINDS) expect(SIGNAL_LABELS[kind]).toMatch(/^[A-Z]/);
		expect(Object.values(VERDICT_LABELS).join(' ').toLowerCase()).not.toContain('compatible');
	});
});

describe('preflight schemas', () => {
	it('takes only a trimmed url', () => {
		expect(preflightBodySchema.parse({ url: ' example.edu ' })).toEqual({ url: 'example.edu' });
		expect(preflightBodySchema.safeParse({ url: 'x', other: 1 }).success).toBe(false);
		expect(preflightBodySchema.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false);
		expect(preflightBodySchema.safeParse({}).success).toBe(false);
	});

	it('round-trips a result', () => {
		const result = {
			url: 'https://example.edu/',
			reachable: true,
			cms: 'drupal',
			version: null,
			versionSource: null,
			hosting: null,
			signals: [{ kind: 'header', detail: 'x' }],
			verdict: 'cannot tell',
			notes: ['x']
		};
		expect(preflightResultSchema.parse(result)).toEqual(result);
		expect(preflightResultSchema.safeParse({ ...result, verdict: 'compatible' }).success).toBe(
			false
		);
	});
});
