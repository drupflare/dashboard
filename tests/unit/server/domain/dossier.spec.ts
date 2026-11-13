import { describe, expect, it } from 'vitest';
import {
	dossierFor,
	filesRestoreBytes,
	type SurveyInput
} from '../../../../src/server/domain/dossier';

const CEILING = 10 * 1024 * 1024 * 1024;

const healthy = (): SurveyInput => ({
	drupal: { version: '11.4.8' },
	database: { driver: 'mysql', bytes: 2_000_000 },
	files: { kb: 28, count: 3, private: null },
	dbAlive: true,
	fileRows: 3,
	modules: ['node', 'system'],
	nodes: 1,
	redis: null,
	errors: []
});

const statuses = (dossier: ReturnType<typeof dossierFor>) =>
	dossier.findings.map((finding) => finding.status);

describe('dossierFor', () => {
	it('is importable with a size estimate when every check reads', () => {
		const dossier = dossierFor(healthy(), CEILING);

		expect(dossier.verdict).toBe('ready');
		expect(dossier.importable).toBe(true);
		expect(dossier.refusals).toEqual([]);
		expect(dossier.estimate).toEqual({ bytes: 2_000_000 + 28 * 1024, fileCount: 3 });
	});

	it('reads Drupal 10 and older as Needs Upgrade with the import disabled', () => {
		for (const version of ['10.3.6', '9.5.11']) {
			const dossier = dossierFor({ ...healthy(), drupal: { version } }, CEILING);

			expect(dossier.verdict).toBe('needs upgrade');
			expect(dossier.importable).toBe(false);
			expect(dossier.findings).toContainEqual(
				expect.objectContaining({ status: 'unsupported', title: 'Needs Upgrade' })
			);
		}
	});

	it('refuses when the Drupal version cannot be read', () => {
		const dossier = dossierFor({ ...healthy(), drupal: { version: null } }, CEILING);

		expect(dossier.verdict).toBe('refused');
		expect(dossier.refusals).toContain('The Drupal version could not be read');
	});

	it('refuses a database type with no import path', () => {
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'pgsql', bytes: 1 } },
			CEILING
		);

		expect(dossier.importable).toBe(false);
		expect(dossier.refusals).toContain('A pgsql database cannot be imported');
		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'unsupported', title: 'Database' })
		);
	});

	it('refuses a PostgreSQL site for the driver only once its size is read', () => {
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'pgsql', bytes: 107_191_319 } },
			CEILING
		);

		expect(dossier.refusals).toEqual(['A pgsql database cannot be imported']);
		expect(dossier.estimate.bytes).toBe(107_191_319 + 28 * 1024);
	});

	it('still refuses a PostgreSQL site on size when the database is over the ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'pgsql', bytes: ceiling + 1 } },
			ceiling
		);

		expect(dossier.refusals).toEqual([
			'A pgsql database cannot be imported',
			'The database is larger than the 16 MiB a new site accepts in one restore. A paged restore is needed for a larger database and is not available yet'
		]);
	});

	it('refuses a database that did not answer, and one that was not checked', () => {
		expect(dossierFor({ ...healthy(), dbAlive: false }, CEILING).refusals).toContain(
			'The database did not answer a query'
		);
		expect(dossierFor({ ...healthy(), dbAlive: null }, CEILING).refusals).toContain(
			'The database answer could not be checked'
		);
	});

	it('refuses managed file rows that point at files missing from disk', () => {
		const dossier = dossierFor(
			{ ...healthy(), files: { kb: 0, count: 0 }, fileRows: 40 },
			CEILING
		);

		expect(dossier.importable).toBe(false);
		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'unsupported', title: 'Missing Files' })
		);
	});

	it('refuses an unmeasured files directory', () => {
		const dossier = dossierFor({ ...healthy(), files: { kb: null, count: null } }, CEILING);

		expect(dossier.refusals).toContain('The files directory could not be measured');
	});

	it('asks the owner to choose for Redis keys a dump does not carry', () => {
		const dossier = dossierFor(
			{
				...healthy(),
				redis: {
					keys: 12,
					cache: 4,
					prefixes: [{ prefix: 'unsubscribe_token', count: 8 }]
				}
			},
			CEILING
		);

		expect(dossier.importable).toBe(true);
		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'requires choice', title: 'Redis Data' })
		);
	});

	it('refuses a database above the restore ceiling and names the paged restore', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'mysql', bytes: ceiling + 1 } },
			ceiling
		);

		expect(dossier.importable).toBe(false);
		expect(dossier.refusals).toEqual([
			'The database is larger than the 16 MiB a new site accepts in one restore. A paged restore is needed for a larger database and is not available yet'
		]);
	});

	it('accepts a database exactly at the restore ceiling when there are no files', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{
				...healthy(),
				database: { driver: 'mysql', bytes: ceiling },
				files: { kb: 0, count: 0, private: null },
				fileRows: 0
			},
			ceiling
		);

		expect(dossier.importable).toBe(true);
	});

	it('refuses files that do not fit beside a database exactly at the ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'mysql', bytes: ceiling } },
			ceiling
		);

		expect(dossier.importable).toBe(false);
	});

	it('counts the files and the database together against the restore ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const survey = (kb: number, bytes: number) => ({
			...healthy(),
			database: { driver: 'mysql', bytes },
			files: { kb, count: 10, private: null }
		});
		const room = ceiling - 1_000_000;
		const fits = Math.floor((room - 10 * 1024) / 2048);
		expect(dossierFor(survey(fits, 1_000_000), ceiling).importable).toBe(true);
		const over = dossierFor(survey(fits + 1, 1_000_000), ceiling);
		expect(over.importable).toBe(false);
		expect(over.refusals).toEqual([
			'The database and the files together are larger than the 16 MiB a new site accepts in one restore. A paged restore is needed for a larger import and is not available yet'
		]);
		expect(over.findings).toContainEqual(
			expect.objectContaining({ status: 'unsupported', title: 'Uploaded Files' })
		);
	});

	it('prices the files as two characters a byte plus a row each', () => {
		expect(filesRestoreBytes(10, 3)).toBe(10 * 1024 * 2 + 3 * 1024);
	});

	it('names only the database when the database alone is over the ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{
				...healthy(),
				database: { driver: 'mysql', bytes: ceiling + 1 },
				files: { kb: 5 * 1024 * 1024, count: 9000, private: null }
			},
			ceiling
		);
		expect(dossier.refusals).toHaveLength(1);
		expect(dossier.refusals[0]).toContain('The database is larger than');
	});

	it('does not price files for a site with none', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{
				...healthy(),
				database: { driver: 'mysql', bytes: ceiling },
				files: { kb: 0, count: 0, private: null },
				fileRows: 0
			},
			ceiling
		);
		expect(dossier.importable).toBe(true);
	});

	it('refuses a site with a private files folder, since only the public files are carried', () => {
		const dossier = dossierFor(
			{ ...healthy(), files: { kb: 28, count: 3, private: '../private' } },
			CEILING
		);
		expect(dossier.importable).toBe(false);
		expect(dossier.refusals).toEqual([
			'The site keeps private files at ../private, and private files are not carried into a new site yet'
		]);
		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'unsupported', title: 'Private Files' })
		);
	});

	it('refuses when the database size is unknown', () => {
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'mysql', bytes: null } },
			CEILING
		);

		expect(dossier.estimate.bytes).toBeNull();
		expect(dossier.refusals).toContain('The size of the site could not be estimated');
	});

	it('notes a check that did not finish without passing the site', () => {
		const dossier = dossierFor(
			{ ...healthy(), errors: [{ id: 'nodes', detail: 'exit 1' }] },
			CEILING
		);

		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'information', title: 'Checks Not Finished' })
		);
		expect(dossier.importable).toBe(true);
	});

	it('uses only the four finding statuses', () => {
		for (const dossier of [
			dossierFor(healthy(), CEILING),
			dossierFor({ ...healthy(), drupal: { version: '10.0.0' } }, CEILING)
		]) {
			for (const status of statuses(dossier)) {
				expect(['automatic', 'requires choice', 'unsupported', 'information']).toContain(
					status
				);
			}
		}
	});
});
