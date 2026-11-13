import { describe, expect, it } from 'vitest';
import { dossierFor, type SurveyInput } from '../../../../src/server/domain/dossier';

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

	it('accepts a database exactly at the restore ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{ ...healthy(), database: { driver: 'mysql', bytes: ceiling } },
			ceiling
		);

		expect(dossier.importable).toBe(true);
	});

	it('does not count the files against the restore ceiling', () => {
		const ceiling = 16 * 1024 * 1024;
		const dossier = dossierFor(
			{
				...healthy(),
				database: { driver: 'mysql', bytes: 1_000_000 },
				files: { kb: 5 * 1024 * 1024, count: 9000, private: null }
			},
			ceiling
		);

		expect(dossier.importable).toBe(true);
	});

	it('refuses uploaded files while a new site cannot take them', () => {
		const dossier = dossierFor(healthy(), CEILING, { filesLandable: false });

		expect(dossier.importable).toBe(false);
		expect(dossier.refusals).toContain('Uploaded files cannot be carried into a new site yet');
		expect(dossier.findings).toContainEqual(
			expect.objectContaining({ status: 'unsupported', title: 'Uploaded Files' })
		);
	});

	it('imports a site with no uploaded files whatever the files flag says', () => {
		const dossier = dossierFor(
			{ ...healthy(), files: { kb: 0, count: 0, private: null }, fileRows: 0 },
			CEILING,
			{ filesLandable: false }
		);

		expect(dossier.importable).toBe(true);
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
