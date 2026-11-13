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
}

const majorOf = (version: string | null): number | null => {
	const match = version === null ? null : /^(\d+)\./.exec(version);
	return match?.[1] === undefined ? null : Number(match[1]);
};

const DRUPAL_MAJOR = 11;
const DATABASES = ['mysql', 'mariadb'];

// every import-blocking check that cannot be read is a refusal, never a pass
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
	if (driver === null) {
		refusals.push('The database type could not be read');
	} else if (DATABASES.includes(driver)) {
		findings.push({
			status: 'automatic',
			title: 'Database',
			detail: 'MySQL or MariaDB converts to SQLite on the import path'
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
	if (survey.files.private) {
		findings.push({
			status: 'information',
			title: 'Private Files',
			detail: `Private files are carried with the site at ${survey.files.private}`
		});
	}

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
	} else if (bytes > ceilingBytes) {
		refusals.push('The site is larger than the import limit');
	}

	if (verdict === 'ready' && refusals.length > 0) verdict = 'refused';
	return {
		verdict,
		importable: verdict === 'ready',
		refusals,
		estimate: { bytes, fileCount: count },
		findings
	};
}
