import type { Finding, Provenance, Recipe } from './index';

type Row = Record<string, unknown>;

export interface InferenceResult {
	recipe: Recipe;
	findings: Finding[];
	deployable: boolean;
}

const REFUSED_KEYS = ['ai', 'containers', 'browser', 'hyperdrive', 'vectorize', 'tail_consumers'];

const HANDLED_KEYS = [
	'd1_databases',
	'kv_namespaces',
	'r2_buckets',
	'send_email',
	'durable_objects',
	'migrations',
	'triggers',
	'vars',
	'assets',
	'queues',
	'services',
	'routes',
	'route',
	'env'
];

const IGNORED_KEYS = [
	'$schema',
	'name',
	'main',
	'compatibility_date',
	'compatibility_flags',
	'observability',
	'limits',
	'placement',
	'account_id',
	'build',
	'rules',
	'no_bundle',
	'minify',
	'keep_names',
	'keep_vars',
	'find_additional_modules',
	'base_dir',
	'preserve_file_names',
	'upload_source_maps',
	'tsconfig',
	'dev',
	'workers_dev',
	'logpush',
	'usage_model'
];

function isRow(value: unknown): value is Row {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function text(row: Row, key: string): string | undefined {
	const value = row[key];
	return isString(value) ? value : undefined;
}

function at(key: string): Provenance {
	return { source: `wrangler.jsonc:${key}` };
}

export function inferRecipe(config: Row): InferenceResult {
	const findings: Finding[] = [];
	const resources: Recipe['resources'] = [];
	const durableObjects: Recipe['durableObjects'] = [];
	const durableMigrations: Recipe['durableMigrations'] = [];
	const crons: Recipe['crons'] = [];
	const variables: Recipe['variables'] = [];

	const refuse = (subject: string, reason: string, code = 'binding-unverified') => {
		findings.push({ severity: 'blocking', code, subject, reason, provenance: at(subject) });
	};

	const rows = (block: Row, key: string): Row[] => {
		const value = block[key];
		if (value === undefined) return [];
		if (Array.isArray(value) && value.every(isRow)) return value;
		refuse(key, `${key} must be a list of objects.`, 'config-invalid');
		return [];
	};

	const bindingKinds = [
		['d1_databases', 'd1'],
		['kv_namespaces', 'kv'],
		['r2_buckets', 'r2'],
		['send_email', 'send_email']
	] as const;
	for (const [key, kind] of bindingKinds) {
		for (const row of rows(config, key)) {
			const binding = text(row, key === 'send_email' ? 'name' : 'binding');
			if (!binding) {
				refuse(key, `${key} entry has no binding name.`, 'config-invalid');
				continue;
			}
			const migrations =
				kind === 'd1'
					? {
							...(text(row, 'migrations_dir')
								? { migrationsDir: text(row, 'migrations_dir') }
								: {}),
							...(text(row, 'migrations_table')
								? { migrationsTable: text(row, 'migrations_table') }
								: {})
						}
					: {};
			resources.push({ kind, binding, optional: false, ...migrations, provenance: at(key) });
		}
	}

	if (config.durable_objects !== undefined) {
		if (!isRow(config.durable_objects)) {
			refuse('durable_objects', 'durable_objects must be an object.', 'config-invalid');
		} else {
			for (const row of rows(config.durable_objects, 'bindings')) {
				const binding = text(row, 'name');
				const className = text(row, 'class_name');
				if (!binding || !className) {
					refuse(
						'durable_objects',
						'a Durable Object binding needs name and class_name.',
						'config-invalid'
					);
					continue;
				}
				durableObjects.push({ binding, className, provenance: at('durable_objects') });
			}
		}
	}

	for (const row of rows(config, 'migrations')) {
		const tag = text(row, 'tag');
		const extra = Object.keys(row).filter(
			(key) => key !== 'tag' && key !== 'new_sqlite_classes'
		);
		if (!tag) {
			refuse('migrations', 'a migration step needs a tag.', 'config-invalid');
		} else if (extra.length > 0) {
			refuse(
				'migrations',
				`a migration step with ${extra.join(', ')} is not verified on a dispatch namespace.`
			);
		} else {
			const classes = Array.isArray(row.new_sqlite_classes)
				? row.new_sqlite_classes.filter(isString)
				: [];
			durableMigrations.push({
				tag,
				newSqliteClasses: classes,
				provenance: at('migrations')
			});
		}
	}

	const triggers: Row = isRow(config.triggers) ? config.triggers : {};
	if (Array.isArray(triggers.crons)) {
		for (const schedule of triggers.crons.filter(isString)) {
			crons.push({ schedule, provenance: at('triggers.crons') });
		}
	}
	if (crons.length > 0) {
		findings.push({
			severity: 'warning',
			code: 'cron-unobserved',
			subject: 'triggers.crons',
			reason: 'Firing on a user Worker is unobserved here: this check cannot see whether a cron run happened.',
			provenance: at('triggers.crons')
		});
	}

	if (isRow(config.vars)) {
		for (const name of Object.keys(config.vars)) {
			variables.push({ name, optional: false, provenance: at(`vars.${name}`) });
		}
	}

	const assetsBlock: Row = isRow(config.assets) ? config.assets : {};
	const directory = text(assetsBlock, 'directory');
	const assets: Recipe['assets'] = directory
		? { directory, provenance: at('assets') }
		: {
				directory: null,
				provenance: { unverified: true, confirm: 'the config sets no assets directory' }
			};

	if (isRow(config.queues)) {
		const consumers = config.queues.consumers;
		if (Array.isArray(consumers) && consumers.length > 0) {
			refuse('queues', 'Queue consumers are not verified on a dispatch namespace.');
		}
		const producers = config.queues.producers;
		if (Array.isArray(producers) && producers.length > 0) {
			findings.push({
				severity: 'info',
				code: 'queue-producer-unchecked',
				subject: 'queues',
				reason: 'Queue producers are not checked against a dispatch namespace.',
				provenance: at('queues')
			});
		}
	} else if (config.queues !== undefined) {
		refuse('queues', 'queues must be an object.', 'config-invalid');
	}

	const services = config.services ?? [];
	if (!Array.isArray(services) || services.length > 0) {
		refuse(
			'services',
			'The namespace of a service binding target cannot be read from this config.',
			'service-target-unknown'
		);
	}

	for (const key of REFUSED_KEYS) {
		if (config[key] !== undefined)
			refuse(key, `${key} is not verified on a dispatch namespace.`);
	}

	for (const key of ['routes', 'route']) {
		if (config[key] !== undefined) {
			findings.push({
				severity: 'info',
				code: 'route-not-applied',
				subject: key,
				reason: 'Routes are not applied to a user Worker; the dispatch Worker serves the hostname.',
				provenance: at(key)
			});
		}
	}

	if (config.env !== undefined) {
		findings.push({
			severity: 'info',
			code: 'env-ignored',
			subject: 'env',
			reason: 'Environment overrides are ignored; only the top-level config is read.',
			provenance: at('env')
		});
	}

	for (const key of Object.keys(config)) {
		if (
			HANDLED_KEYS.includes(key) ||
			IGNORED_KEYS.includes(key) ||
			REFUSED_KEYS.includes(key)
		) {
			continue;
		}
		refuse(key, `${key} is not a binding kind verified on a dispatch namespace.`);
	}

	findings.push({
		severity: 'info',
		code: 'connect-unseen',
		subject: 'connect()',
		reason: 'connect() calls in the code cannot be seen from a config, so outbound TCP is not checked here.',
		provenance: { unverified: true, confirm: 'connect() use is visible only in the source' }
	});

	const flags = Array.isArray(config.compatibility_flags)
		? config.compatibility_flags.filter(isString)
		: [];

	const recipe: Recipe = {
		id: 'bring-your-own',
		name: 'Bring Your Own',
		category: 'workers',
		compatibility: {
			flags,
			provenance: Array.isArray(config.compatibility_flags)
				? at('compatibility_flags')
				: { unverified: true, confirm: 'the config sets no compatibility flags' }
		},
		resources,
		durableObjects,
		durableMigrations,
		crons,
		assets,
		refused: findings
			.filter((finding) => finding.severity === 'blocking')
			.map((finding) => ({
				kind: finding.subject,
				reason: finding.reason,
				provenance: finding.provenance
			})),
		secrets: [],
		variables,
		firstRun: null,
		probe: {
			method: 'GET',
			path: '/',
			provenance: {
				unverified: true,
				confirm: 'the config names no health path; the owner sets one'
			}
		},
		settings: [],
		release: {
			workerAsset: null,
			provenance: {
				unverified: true,
				confirm: 'a custom Worker has no release source in its config'
			}
		}
	};

	return {
		recipe,
		findings,
		deployable: !findings.some((finding) => finding.severity === 'blocking')
	};
}
