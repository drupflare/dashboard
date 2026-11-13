import { FILES_BODY_BYTES, mebibytes, SINGLE_RESTORE_BYTES } from '../../shared/restore-limits';

export type FindingStatus = 'automatic' | 'requires choice' | 'unsupported' | 'information';

export interface Finding {
	status: FindingStatus;
	title: string;
	detail: string;
}

// the fields of a host survey the dossier reads; the survey record satisfies it structurally
export interface SurveyInput {
	drupal: { version: string | null };
	database: { driver: string | null; bytes: number | null };
	files: { kb: number | null; count: number | null; private?: string | null };
	dbAlive: boolean | null;
	fileRows: number | null;
	modules: string[];
	nodes: number | null;
	redis?: { keys: number; cache: number; prefixes: { prefix: string; count: number }[] } | null;
	errors: { id: string; detail: string }[];
}

export interface Dossier {
	verdict: 'ready' | 'needs upgrade' | 'refused';
	importable: boolean;
	refusals: string[];
	estimate: { bytes: number | null; fileCount: number | null };
	findings: Finding[];
	// what the import reads from the server beyond the size: the database kind and the private folder
	database: 'mysql' | 'pgsql';
	privateFiles: string | null;
}

const majorOf = (version: string | null): number | null => {
	const match = version === null ? null : /^(\d+)\./.exec(version);
	return match?.[1] === undefined ? null : Number(match[1]);
};

export const DRUPAL_MAJOR = 11;
const MYSQL_DRIVERS = ['mysql', 'mariadb'];
const PGSQL_DRIVERS = ['pgsql', 'postgres'];

// the files travel in the restore body as hex, two characters a byte, plus a few statements a file
const FILE_ROW_BYTES = 1024;

// what the files add to a restore body, from the disk usage the survey read
export const filesRestoreBytes = (kb: number, count: number) =>
	kb * 1024 * 2 + count * FILE_ROW_BYTES;

// every import-blocking check that cannot be read is a refusal, never a pass; the ceiling is the
// most a new site accepts in one restore, which the database and the files share
export function dossierFor(survey: SurveyInput, ceilingBytes: number): Dossier {
	const findings: Finding[] = [];
	const refusals: string[] = [];
	let verdict: Dossier['verdict'] = 'ready';

	const major = majorOf(survey.drupal.version);
	if (major === null) {
		refusals.push('The Drupal version could not be read');
	} else if (major < DRUPAL_MAJOR) {
		verdict = 'needs upgrade';
		refusals.push(
			`Drupal ${survey.drupal.version} must be upgraded to Drupal 11 before import`
		);
		findings.push({
			status: 'unsupported',
			title: 'Needs Upgrade',
			detail: `Drupal ${survey.drupal.version} is older than Drupal 11`
		});
	} else if (major > DRUPAL_MAJOR) {
		refusals.push(`Drupal ${survey.drupal.version} is not supported for import yet`);
	} else {
		findings.push({
			status: 'automatic',
			title: 'Drupal Version',
			detail: `Drupal ${survey.drupal.version} imports as it is`
		});
	}

	const driver = survey.database.driver;
	let database: Dossier['database'] = 'mysql';
	if (driver === null) {
		refusals.push('The database type could not be read');
	} else if (MYSQL_DRIVERS.includes(driver)) {
		findings.push({
			status: 'automatic',
			title: 'Database',
			detail: 'MySQL or MariaDB converts to SQLite on the import path'
		});
	} else if (PGSQL_DRIVERS.includes(driver)) {
		database = 'pgsql';
		findings.push({
			status: 'automatic',
			title: 'Database',
			detail: 'PostgreSQL converts to SQLite on the import path'
		});
		findings.push({
			status: 'information',
			title: 'Not Carried From PostgreSQL',
			detail: 'Functions, foreign keys and check constraints in the database are left behind. The new site does not need the functions Drupal installs, and a sequence continues from the largest stored id. A trigger or a view stops the import, and the check cannot tell whether the database has one.'
		});
	} else {
		refusals.push(`A ${driver} database cannot be imported`);
		findings.push({
			status: 'unsupported',
			title: 'Database',
			detail: `The ${driver} database type has no import path`
		});
	}

	if (survey.dbAlive === null) {
		refusals.push('The database answer could not be checked');
	} else if (!survey.dbAlive) {
		refusals.push('The database did not answer a query');
	} else {
		findings.push({
			status: 'automatic',
			title: 'Database Answers',
			detail: 'The database responds'
		});
	}

	const { kb, count } = survey.files;
	if (kb === null || count === null) {
		refusals.push('The files directory could not be measured');
	} else if (survey.fileRows !== null && count === 0 && survey.fileRows > 0) {
		refusals.push('The database lists files that are not on disk');
		findings.push({
			status: 'unsupported',
			title: 'Missing Files',
			detail: `The database lists ${survey.fileRows} files and the disk holds none`
		});
	} else {
		findings.push({
			status: 'information',
			title: 'Uploaded Files',
			detail: `${count} files, ${kb} KB`
		});
	}
	const privateFiles = survey.files.private ? survey.files.private : null;
	if (privateFiles !== null) {
		findings.push({
			status: 'automatic',
			title: 'Private Files',
			detail: `The private files folder at ${privateFiles} is copied into the new site's private files. The check does not measure it, so the import stops before anything is made if it is too large to carry with the database and the public files.`
		});
	}

	findings.push({
		status: 'information',
		title: 'Connect as the Owner',
		detail: "Connect as the account that owns the site's files, not root, because Drush run as root creates root-owned files in that tree."
	});

	const redis = survey.redis;
	if (redis === undefined || redis === null) {
		findings.push({
			status: 'information',
			title: 'Redis',
			detail: 'No Redis answered, so its keys were not checked'
		});
	} else if (redis.prefixes.length > 0) {
		findings.push({
			status: 'requires choice',
			title: 'Redis Data',
			detail: `Redis holds ${redis.keys - redis.cache} keys outside the cache that a database dump does not carry`
		});
	} else {
		findings.push({ status: 'information', title: 'Redis', detail: 'Redis holds only cache' });
	}

	findings.push({
		status: 'information',
		title: 'Enabled Modules',
		detail: `${survey.modules.length} modules are enabled`
	});
	if (survey.nodes !== null) {
		findings.push({ status: 'information', title: 'Content', detail: `${survey.nodes} nodes` });
	}
	if (survey.errors.length > 0) {
		findings.push({
			status: 'information',
			title: 'Checks Not Finished',
			detail: `${survey.errors.length} checks on the host did not finish`
		});
	}

	const fileBytes = kb === null ? null : kb * 1024;
	const bytes =
		survey.database.bytes === null || fileBytes === null
			? null
			: survey.database.bytes + fileBytes;
	if (bytes === null) {
		refusals.push('The size of the site could not be estimated');
	} else if (survey.database.bytes !== null && survey.database.bytes > ceilingBytes) {
		const mib = mebibytes(ceilingBytes);
		refusals.push(
			ceilingBytes > SINGLE_RESTORE_BYTES
				? `The database is ${Math.ceil(survey.database.bytes / (1024 * 1024))} MiB, over the ${mib} MiB a new site accepts`
				: `The database is larger than the ${mib} MiB a new site accepts in one restore. Restoring a larger database in pieces is not switched on yet`
		);
	}
	// the files ride in the same restore as the database, and the engine turns them into statements
	// in memory, so they have a room of their own on top of the shared ceiling
	if (
		survey.database.bytes !== null &&
		survey.database.bytes <= ceilingBytes &&
		kb !== null &&
		count !== null &&
		count > 0
	) {
		const needed = filesRestoreBytes(kb, count);
		const shared = ceilingBytes - survey.database.bytes;
		const mib = mebibytes(ceilingBytes);
		const tooLarge =
			needed > shared
				? ceilingBytes > SINGLE_RESTORE_BYTES
					? `The database and the files together are larger than the ${mib} MiB a new site accepts`
					: `The database and the files together are larger than the ${mib} MiB a new site accepts in one restore. Restoring a larger import in pieces is not switched on yet`
				: needed > FILES_BODY_BYTES
					? `The files are larger than the ${mebibytes(FILES_BODY_BYTES)} MiB of files one import carries`
					: null;
		if (tooLarge !== null) {
			refusals.push(tooLarge);
			const found = findings.findIndex((finding) => finding.title === 'Uploaded Files');
			if (found >= 0) {
				findings[found] = {
					status: 'unsupported',
					title: 'Uploaded Files',
					detail: `${count} files, ${kb} KB, which with the database is more than one import takes`
				};
			}
		}
	}

	if (verdict === 'ready' && refusals.length > 0) verdict = 'refused';
	return {
		verdict,
		importable: verdict === 'ready',
		refusals,
		estimate: { bytes, fileCount: count },
		findings,
		database,
		privateFiles
	};
}
