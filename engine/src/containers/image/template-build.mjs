import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BUNDLE_MAGIC = 'DFTB1\n';
export const BUNDLE_VERSION = 1;
export const EXIT_BAD_SPEC = 64;
export const EXIT_STEP_FAILED = 65;

const SPEC_KEYS = [
	'id',
	'repo',
	'sha',
	'profile',
	'mode',
	'template',
	'package',
	'extra',
	'auditOff',
	'patchTolerant',
	'enablePatching'
];
const PACKAGE = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;
const WEB_DIRS = ['web', 'docroot', 'html'];
const ADVISORY_ID = /\bSA-[A-Z]+-\d{4}-\d+\b/i;

// the spec is built by the engine from its own entry table; it is still checked, because every
// field ends up in a command argument
export function parseSpec(text) {
	let spec;
	try {
		spec = JSON.parse(text);
	} catch {
		throw new Error('the template spec is not valid JSON');
	}
	if (!spec || typeof spec !== 'object' || Array.isArray(spec))
		throw new Error('the template spec must be an object');
	for (const key of Object.keys(spec)) {
		if (!SPEC_KEYS.includes(key))
			throw new Error(`the template spec has an unknown field ${key}`);
	}
	const fail = (field) => {
		throw new Error(`the template spec field ${field} is not valid`);
	};
	if (typeof spec.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(spec.id)) fail('id');
	if (
		typeof spec.repo !== 'string' ||
		!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(spec.repo)
	)
		fail('repo');
	if (typeof spec.sha !== 'string' || !/^[0-9a-f]{40}$/.test(spec.sha)) fail('sha');
	if (typeof spec.profile !== 'string' || !/^[a-z][a-z0-9_]*$/.test(spec.profile))
		fail('profile');
	if (spec.mode !== 'template' && spec.mode !== 'profile') fail('mode');
	if (
		typeof spec.template !== 'string' ||
		!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*(:[A-Za-z0-9.^~*-]+)?$/.test(spec.template)
	)
		fail('template');
	if (typeof spec.package !== 'string' || !PACKAGE.test(spec.package)) fail('package');
	const extra = spec.extra ?? [];
	if (
		!Array.isArray(extra) ||
		!extra.every((name) => typeof name === 'string' && PACKAGE.test(name))
	)
		fail('extra');
	for (const flag of ['auditOff', 'patchTolerant', 'enablePatching']) {
		if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') fail(flag);
	}
	return {
		id: spec.id,
		repo: spec.repo,
		sha: spec.sha,
		profile: spec.profile,
		mode: spec.mode,
		template: spec.template,
		package: spec.package,
		extra,
		auditOff: spec.auditOff === true,
		patchTolerant: spec.patchTolerant === true,
		enablePatching: spec.enablePatching === true
	};
}

// the advisory ids composer audit names for the locked tree; null when the answer cannot be read
export function advisoriesOf(text) {
	const lines = text.split('\n');
	const first = lines.findIndex((line) => line.startsWith('{'));
	const last = lines.findLastIndex((line) => line.trimEnd().endsWith('}'));
	if (first < 0 || last < first) return null;
	let report;
	try {
		report = JSON.parse(lines.slice(first, last + 1).join('\n'));
	} catch {
		return null;
	}
	const seen = new Map();
	const grouped = report?.advisories;
	const groups = Array.isArray(grouped) ? [] : Object.entries(grouped ?? {});
	for (const [name, list] of groups) {
		for (const advisory of Array.isArray(list) ? list : []) {
			const named = [advisory?.title, advisory?.link, advisory?.advisoryId]
				.map((value) =>
					typeof value === 'string' ? ADVISORY_ID.exec(value)?.[0] : undefined
				)
				.find(Boolean);
			const id = (named ?? advisory?.advisoryId ?? '').toUpperCase();
			if (id !== '' && !seen.has(`${name}:${id}`))
				seen.set(`${name}:${id}`, { id, package: name });
		}
	}
	return [...seen.values()];
}

// composer names the package it patches on one line and the patch that failed on a later one
export function patchFailuresOf(lines) {
	const failed = [];
	let current = '';
	for (const line of lines) {
		const applying = /Applying patches for (\S+)/.exec(line);
		if (applying) current = applying[1];
		if (!/Cannot apply patch/i.test(line)) continue;
		const url = /https?:\/\/[^\s)]+/.exec(line)?.[0];
		failed.push({ package: current, patch: url ?? line.trim().slice(0, 300) });
	}
	return failed;
}

export function countRows(sql) {
	let rows = 0;
	for (const line of sql.split('\n')) if (line.startsWith('INSERT INTO ')) rows++;
	return rows;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// manifest first, so a reader can take the manifest and the one section it needs and skip the rest
export function encodeBundle(manifest, sections) {
	const head = {
		...manifest,
		sections: sections.map((section) => ({
			name: section.name,
			bytes: section.bytes.length,
			sha256: sha256(section.bytes)
		}))
	};
	const json = Buffer.from(JSON.stringify(head));
	const prefix = Buffer.alloc(BUNDLE_MAGIC.length + 4);
	prefix.write(BUNDLE_MAGIC, 0, 'latin1');
	prefix.writeUInt32BE(json.length, BUNDLE_MAGIC.length);
	return Buffer.concat([prefix, json, ...sections.map((section) => Buffer.from(section.bytes))]);
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// every command is a fixed file and a fixed argument list; nothing from the spec reaches a shell
export function resolveSteps(spec, paths) {
	const { clone, site } = paths;
	const flags = ['--no-interaction', '--no-progress'];
	const composer = (args, cwd) => ({ file: 'composer', args, cwd });
	const steps = [
		{ file: 'git', args: ['init', '-q', clone], cwd: paths.dir },
		{
			file: 'git',
			args: ['-C', clone, 'fetch', '-q', '--depth', '1', spec.repo, spec.sha],
			cwd: paths.dir
		},
		{ file: 'git', args: ['-C', clone, 'checkout', '-q', 'FETCH_HEAD'], cwd: paths.dir }
	];
	steps.push(
		composer(
			['create-project', spec.template, site, '--stability', 'dev', '--no-install', ...flags],
			paths.dir
		)
	);
	if (spec.mode === 'template') {
		steps.push(
			composer(
				[
					'config',
					'repositories.profile',
					JSON.stringify({ type: 'path', url: clone, options: { symlink: false } })
				],
				site
			)
		);
	} else {
		steps.push(
			composer(['config', 'minimum-stability', 'dev'], site),
			composer(['config', 'prefer-stable', 'true'], site),
			composer(
				['config', 'repositories.assets', 'composer', 'https://asset-packagist.org'],
				site
			)
		);
	}
	steps.push(composer(['config', '--no-plugins', 'allow-plugins', 'true'], site));
	if (spec.auditOff) steps.push(composer(['config', 'audit.block-insecure', 'false'], site));
	if (spec.mode === 'profile' && spec.enablePatching)
		steps.push(composer(['config', 'extra.enable-patching', 'true', '--json'], site));
	if (spec.patchTolerant)
		steps.push(
			composer(['config', 'extra.composer-exit-on-patch-failure', 'false', '--json'], site)
		);
	return steps;
}

export async function useProfileRepositories(clone, site) {
	const root = JSON.parse(await readFile(join(site, 'composer.json'), 'utf8'));
	const own = JSON.parse(await readFile(join(clone, 'composer.json'), 'utf8'));
	const others = (list) => (Array.isArray(list) ? list : Object.values(list ?? {}));
	root.repositories = [
		{ type: 'path', url: clone, options: { symlink: false } },
		...others(own.repositories).filter((entry) => entry?.type !== 'path'),
		...others(root.repositories)
	];
	await writeFile(join(site, 'composer.json'), JSON.stringify(root, null, 4));
}

// runs the whole build; `run` is the runner's command executor and `env` builds a child environment
export async function templateBuild({ dir, input, output, log, signal }, { run, env }) {
	const started = Date.now();
	let spec;
	try {
		spec = parseSpec(await readFile(input, 'utf8'));
	} catch (error) {
		log(error.message);
		return EXIT_BAD_SPEC;
	}
	const childEnv = {
		...env(dir),
		GIT_TERMINAL_PROMPT: '0',
		COMPOSER_PROCESS_TIMEOUT: '2000'
	};
	const clone = join(dir, 'clone');
	const site = join(dir, 'site');
	await mkdir(join(dir, 'home', 'composer'), { recursive: true });
	const collected = [];
	const keep = (line) => {
		collected.push(line);
		log(line);
	};
	const exec = (file, args, cwd, sink = log) =>
		run(file, args, { cwd, env: childEnv, log: sink, signal });
	const stepped = async (step) => {
		log(`> ${step.file} ${step.args.slice(0, 3).join(' ')}`);
		return exec(step.file, step.args, step.cwd ?? site);
	};

	const paths = { dir, clone, site };
	const steps = resolveSteps(spec, paths);
	await mkdir(clone, { recursive: true });
	for (const step of steps) {
		const result = await stepped(step);
		if (result !== 0) return result;
		// the profile mode edits the root composer.json once create-project has written it
		if (step.args[0] === 'create-project' && spec.mode === 'profile')
			await useProfileRepositories(clone, site);
	}
	const require = ['require', `${spec.package}:@dev`, ...spec.extra, '-W', '--no-install'];
	log('> composer require');
	let result = await exec('composer', [...require, '--no-interaction', '--no-progress'], site);
	if (result !== 0) return result;
	if (!(await exists(join(site, 'composer.lock')))) {
		log('composer wrote no lock file');
		return EXIT_STEP_FAILED;
	}
	log('> composer install');
	result = await exec('composer', ['install', '--no-interaction', '--no-progress'], site, keep);
	if (result !== 0) return result;

	let webdir = '';
	for (const candidate of WEB_DIRS) {
		if (await exists(join(site, candidate))) {
			webdir = candidate;
			break;
		}
	}
	if (webdir === '') {
		log('the site has no web directory');
		return EXIT_STEP_FAILED;
	}
	const web = join(site, webdir);
	const files = join(web, 'sites', 'default', 'files');
	await mkdir(files, { recursive: true });
	const password = createHash('sha256')
		.update(`${spec.id}${Date.now()}${Math.random()}`)
		.digest('hex');
	log('> drush site:install');
	result = await exec(
		join(site, 'vendor', 'bin', 'drush'),
		[
			'site:install',
			spec.profile,
			'--db-url=sqlite://sites/default/files/.ht.sqlite',
			'--account-name=admin',
			`--account-pass=${password}`,
			`--site-name=${spec.id}`,
			'-y'
		],
		web
	);
	if (result !== 0) return result;
	result = await exec(join(site, 'vendor', 'bin', 'drush'), ['cache:rebuild'], web);
	if (result !== 0) return result;

	const found = (await readdir(web, { recursive: true })).find(
		(name) => name.endsWith('.ht.sqlite') && !name.startsWith('core')
	);
	if (found === undefined) {
		log('the site install wrote no database');
		return EXIT_STEP_FAILED;
	}
	const database = join(web, found);
	const dumped = join(dir, 'database.sql');
	log('> sqlite3 dump');
	result = await exec('sqlite3', [database, `.output ${dumped}`, '.dump'], dir);
	if (result !== 0) return result;
	const filesTar = join(dir, 'files.tar');
	result = await exec(
		'tar',
		['-cf', filesTar, '-C', files, '--exclude=.ht.sqlite*', '--exclude=./php', '.'],
		dir
	);
	if (result !== 0) return result;

	const audit = [];
	await exec(
		'composer',
		['audit', '--locked', '--format=json', '--no-interaction'],
		site,
		(line) => audit.push(line)
	);
	const version = [];
	await exec('php', ['-r', 'echo PHP_VERSION;'], dir, (line) => version.push(line));

	const sql = await readFile(dumped);
	const rows = countRows(sql.toString('utf8'));
	if (rows === 0) {
		log('the database dump holds no rows');
		return EXIT_STEP_FAILED;
	}
	const lock = await readFile(join(site, 'composer.lock'));
	const sections = [
		{ name: 'database.sql', bytes: sql },
		{ name: 'composer.lock', bytes: lock },
		{ name: 'composer.json', bytes: await readFile(join(site, 'composer.json')) },
		{ name: 'files.tar', bytes: await readFile(filesTar) }
	];
	const manifest = {
		version: BUNDLE_VERSION,
		entryId: spec.id,
		commit: spec.sha,
		phpVersion: version.join('').trim(),
		buildSeconds: Math.round((Date.now() - started) / 100) / 10,
		rows,
		advisories: advisoriesOf(audit.join('\n')),
		patchesFailed: patchFailuresOf(collected),
		packages: JSON.parse(lock.toString('utf8')).packages?.length ?? 0
	};
	await writeFile(output, encodeBundle(manifest, sections));
	log(`bundle written, ${manifest.rows} rows`);
	return 0;
}
