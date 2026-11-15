import { describe, expect, it } from 'vitest';
import {
	INSTALL_STEPS,
	installRefusal,
	machineName,
	moduleCheckSchema,
	ModuleManifestInvalidError,
	parseModuleManifest,
	parseModuleManifestValue,
	searchModules,
	type ModuleRow
} from '../../../src/shared/modules';
import censusJson from '../../../src/shared/modules.json';

const row = (overrides: Partial<ModuleRow> = {}): ModuleRow => ({
	name: 'drupal/token',
	label: 'Token',
	kind: 'unknown',
	state: 'verified',
	shipping: false,
	needs: [],
	...overrides
});

const manifest = (...modules: ModuleRow[]) => ({ modules });

describe('module manifest schema', () => {
	it('accepts the census the sync script wrote', () => {
		const parsed = parseModuleManifestValue(censusJson);
		expect(parsed.modules.length).toBeGreaterThan(0);
	});

	it('refuses a blocked row without a reason', () => {
		expect(() => parseModuleManifestValue(manifest(row({ state: 'blocked' })))).toThrow(
			ModuleManifestInvalidError
		);
	});

	it('refuses a shipped module that is not verified', () => {
		expect(() =>
			parseModuleManifestValue(manifest(row({ shipping: true, state: 'untested' })))
		).toThrow(/a shipped module is verified/);
	});

	it('refuses a name listed twice', () => {
		expect(() => parseModuleManifestValue(manifest(row(), row()))).toThrow(
			/drupal\/token is listed twice/
		);
	});

	it('refuses a malformed machine name', () => {
		expect(() => parseModuleManifestValue(manifest(row({ name: 'Token' })))).toThrow(
			ModuleManifestInvalidError
		);
	});

	it('refuses an empty census rather than writing an empty list', () => {
		expect(() => parseModuleManifestValue({ modules: [] })).toThrow(ModuleManifestInvalidError);
	});

	it('refuses text that is not JSON', () => {
		expect(() => parseModuleManifest('{')).toThrow(/manifest is not JSON/);
	});
});

describe('searchModules', () => {
	const census = manifest(
		row({ name: 'drupal/token', label: 'Token' }),
		row({ name: 'drupal/paragraphs', label: 'Paragraphs', state: 'untested' }),
		row({ name: 'drupal/cas', label: 'CAS', state: 'blocked', reason: 'needs a park' }),
		row({ name: 'drupal/gin', label: 'Gin', kind: 'theme' })
	);

	it('returns every row without a query', () => {
		expect(searchModules(census)).toHaveLength(4);
	});

	it('matches the machine name or the label, ignoring case and spaces around the query', () => {
		expect(searchModules(census, { q: '  PARA ' }).map((r) => r.name)).toEqual([
			'drupal/paragraphs'
		]);
		expect(searchModules(census, { q: 'drupal/cas' }).map((r) => r.name)).toEqual([
			'drupal/cas'
		]);
	});

	it('filters by state and by kind', () => {
		expect(searchModules(census, { state: 'blocked' }).map((r) => r.name)).toEqual([
			'drupal/cas'
		]);
		expect(searchModules(census, { kind: 'theme' }).map((r) => r.name)).toEqual(['drupal/gin']);
	});

	it('returns nothing for a query that matches no row', () => {
		expect(searchModules(census, { q: 'nosuchmodule' })).toEqual([]);
	});
});

describe('installRefusal and machineName', () => {
	const row = (patch: Partial<ModuleRow> = {}) => ({
		state: 'verified' as const,
		shipping: false,
		...patch
	});

	it.each([
		['an unknown row', undefined, false, 'That module is not on the list.'],
		[
			'a pack module',
			row({ shipping: true }),
			true,
			'This module is already included with every site.'
		],
		[
			'a blocked row with its reason',
			row({ state: 'blocked', reason: 'needs a park' }),
			true,
			'needs a park'
		],
		[
			'a blocked row without one',
			row({ state: 'blocked' }),
			true,
			'This module cannot run here.'
		],
		[
			'an untested row without confirm',
			row({ state: 'untested' }),
			false,
			'This module has never been run on a site. Confirm that you want to install it anyway.'
		]
	])('refuses %s', (_label, candidate, confirm, text) => {
		expect(installRefusal(candidate, confirm)).toBe(text);
	});

	it('accepts a verified row, and an untested row once confirmed', () => {
		expect(installRefusal(row(), false)).toBeNull();
		expect(installRefusal(row({ state: 'untested' }), true)).toBeNull();
	});

	it('takes the project name from the composer name', () => {
		expect(machineName('drupal/token')).toBe('token');
		expect(machineName('token')).toBe('token');
	});
});

describe('install steps and check shape', () => {
	it('lists the three steps, all wired', () => {
		expect(INSTALL_STEPS.map((step) => step.title)).toEqual(['Check', 'Install', 'Enable']);
		expect(INSTALL_STEPS.every((step) => step.wired)).toBe(true);
	});

	it('accepts a verdict with conflicts and rejects an unknown conflict reason', () => {
		const good = {
			ok: false,
			conflicts: [
				{ requires: 'php', constraint: '^8.4', installed: '8.3', reason: 'version' }
			],
			message: 'Installing this module would conflict.'
		};
		expect(moduleCheckSchema.safeParse(good).success).toBe(true);
		expect(
			moduleCheckSchema.safeParse({
				...good,
				conflicts: [{ ...good.conflicts[0], reason: 'mystery' }]
			}).success
		).toBe(false);
	});
});
