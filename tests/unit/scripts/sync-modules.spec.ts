import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manifestOf, syncModules, type WorkerCensus } from '../../../scripts/sync-modules';
import { ModuleManifestInvalidError } from '../../../src/shared/modules';

const census = (overrides: Partial<WorkerCensus> = {}): WorkerCensus => ({
	rows: [
		{ name: 'drupal/token', label: 'Token', state: 'verified', evidence: 'enabled' },
		{ name: 'drupal/paragraphs', label: 'Paragraphs', state: 'untested', evidence: '' },
		{ name: 'drupal/cas', label: 'CAS', state: 'blocked', evidence: 'needs a park' }
	],
	shipping: ['drupal/token'],
	needs: { 'drupal/cas': ['blocking-outbound'] },
	...overrides
});

let dir: string;
let target: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'sync-modules-'));
	target = join(dir, 'modules.json');
	await writeFile(target, 'previous\n');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('manifestOf', () => {
	it('carries shipping, reasons for blocked rows only, and needs tokens', () => {
		const { modules } = manifestOf(census());
		expect(modules).toEqual([
			{
				name: 'drupal/token',
				label: 'Token',
				kind: 'unknown',
				state: 'verified',
				shipping: true,
				needs: []
			},
			{
				name: 'drupal/paragraphs',
				label: 'Paragraphs',
				kind: 'unknown',
				state: 'untested',
				shipping: false,
				needs: []
			},
			{
				name: 'drupal/cas',
				label: 'CAS',
				kind: 'unknown',
				state: 'blocked',
				shipping: false,
				reason: 'needs a park',
				needs: ['blocking-outbound']
			}
		]);
	});

	it('refuses a census whose blocked row has no reason and leaves nothing to write', () => {
		const bad = census({
			rows: [{ name: 'drupal/cas', label: 'CAS', state: 'blocked', evidence: '' }]
		});
		expect(() => manifestOf(bad)).toThrow(ModuleManifestInvalidError);
	});
});

describe('syncModules', () => {
	it('writes the validated manifest as tab-indented JSON', async () => {
		const manifest = await syncModules(dir, target, async () => census());
		expect(manifest.modules).toHaveLength(3);
		const written = await readFile(target, 'utf8');
		expect(written.startsWith('{\n\t"modules"')).toBe(true);
		expect(JSON.parse(written)).toEqual(manifest);
	});

	it('leaves the target untouched when the census is refused', async () => {
		const refused = syncModules(dir, target, async () =>
			census({ rows: [{ name: 'Bad', label: 'Bad', state: 'verified', evidence: '' }] })
		);
		await expect(refused).rejects.toThrow(ModuleManifestInvalidError);
		expect(await readFile(target, 'utf8')).toBe('previous\n');
	});
});
