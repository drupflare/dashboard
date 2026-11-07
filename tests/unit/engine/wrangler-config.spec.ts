import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_VARS } from '../../../engine/src/config';

interface Config {
	name?: string;
	tsconfig?: string;
	d1_databases?: { binding: string }[];
	kv_namespaces?: { binding: string }[];
	r2_buckets?: { binding: string }[];
	dispatch_namespaces?: { binding: string; namespace: string }[];
	analytics_engine_datasets?: { binding: string }[];
	durable_objects?: {
		bindings: { name: string; class_name: string; script_name?: string }[];
	};
	workflows?: { name: string; binding: string; class_name: string }[];
	migrations?: { tag: string; new_sqlite_classes?: string[] }[];
	vars?: Record<string, string>;
	triggers?: { crons?: string[] };
	env?: Record<string, Config>;
}

const root = join(__dirname, '../../..');
const load = (unit: string): Config =>
	JSON.parse(readFileSync(join(root, unit, 'wrangler.jsonc'), 'utf8')) as Config;

function sourcesOf(unit: string): string {
	const walk = (dir: string): string[] =>
		readdirSync(dir).flatMap((entry) => {
			const path = join(dir, entry);
			return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
		});
	return walk(join(root, unit, 'src'))
		.map((path) => readFileSync(path, 'utf8'))
		.join('\n');
}

// every name the code takes from env
function readsOf(unit: string, extra: readonly string[] = []): string[] {
	const found = new Set<string>(extra);
	for (const match of sourcesOf(unit).matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
		found.add(match[1]!);
	}
	return [...found].sort();
}

// secrets cannot live in the file, and the numbers below have no default until someone reviews them
const ENGINE_SET_AT_DEPLOY = [
	'CF_ACCOUNT_ID',
	'CF_API_TOKEN',
	'CONTROL_SEED',
	'START_SECRET',
	'LEASE_TTL_MS',
	'ASSET_CHUNK_BYTES',
	'LIMIT_MODULE_BYTES',
	'LIMIT_ASSET_BYTES',
	'SITE_TIMEOUT_MS',
	'PENDING_SECRET_TTL_MS'
];
const DISPATCH_SET_AT_DEPLOY = [
	'SITE_AUTH_SEED',
	'LEASE_PUBLIC_KEY',
	'CONTROL_PUBLIC_KEY',
	'CONTROL_HOST',
	'SPIKE_MODE'
];
const STAGE_ONLY = new Set(['SPIKE_MODE']);

function boundIn(config: Config): Set<string> {
	const names = new Set<string>();
	for (const list of [
		config.d1_databases,
		config.kv_namespaces,
		config.r2_buckets,
		config.dispatch_namespaces,
		config.analytics_engine_datasets
	]) {
		for (const entry of list ?? []) names.add(entry.binding);
	}
	for (const entry of config.durable_objects?.bindings ?? []) names.add(entry.name);
	for (const entry of config.workflows ?? []) names.add(entry.binding);
	for (const name of Object.keys(config.vars ?? {})) names.add(name);
	return names;
}

function missingFrom(config: Config, reads: readonly string[], setAtDeploy: readonly string[]) {
	const bound = boundIn(config);
	return reads.filter((name) => !bound.has(name) && !setAtDeploy.includes(name));
}

const exportsOf = (unit: string): string[] =>
	[...sourcesOfFile(unit).matchAll(/export \{([^}]+)\}/g)].flatMap((match) =>
		match[1]!.split(',').map((name) => name.trim())
	);
const sourcesOfFile = (unit: string) => readFileSync(join(root, unit, 'src/index.ts'), 'utf8');

const environments = (unit: string): [string, Config][] => {
	const config = load(unit);
	return [
		['prod', config],
		['stage', config.env!.stage!]
	];
};

describe('missingFrom', () => {
	const config: Config = {
		d1_databases: [{ binding: 'DB' }],
		durable_objects: { bindings: [{ name: 'SITE_LEASE', class_name: 'SiteLease' }] },
		vars: { LIMIT_ASSETS: '1' }
	};

	it('names every binding the code reads and the config lacks', () => {
		const reads = ['DB', 'KV', 'SITE_LEASE', 'NAMES', 'LIMIT_ASSETS', 'START_SECRET'];
		expect(missingFrom(config, reads, ['START_SECRET'])).toEqual(['KV', 'NAMES']);
		expect(missingFrom({}, reads, [])).toEqual(reads);
		expect(missingFrom(config, ['DB'], [])).toEqual([]);
	});

	it('finds the names the real sources read', () => {
		expect(readsOf('engine', CONFIG_VARS)).toEqual(
			expect.arrayContaining([
				'DB',
				'HOSTS_KV',
				'BLOB',
				'SITE_LEASE',
				'SITE_AUTH',
				'NAMES',
				'SITE_CREATE',
				'SITE_DELETE',
				'SITE_PURGE',
				'START_SECRET',
				'SITE_TIMEOUT_MS',
				'DISPATCH_NAMESPACE',
				...CONFIG_VARS
			])
		);
		expect(readsOf('dispatch')).toEqual(
			expect.arrayContaining([
				'HOSTS_KV',
				'SITE_AUTH',
				'DISPATCH',
				'LEASE_PUBLIC_KEY',
				'SITE_AUTH_SEED',
				'CONTROL_PUBLIC_KEY'
			])
		);
	});
});

describe.each(environments('engine'))('the engine config, %s', (_env, config) => {
	it('has every binding the engine code reads, apart from secrets and unreviewed numbers', () => {
		expect(missingFrom(config, readsOf('engine', CONFIG_VARS), ENGINE_SET_AT_DEPLOY)).toEqual(
			[]
		);
	});

	it('exports every class it binds or runs', () => {
		const exported = exportsOf('engine');
		const classes = [
			...(config.durable_objects?.bindings ?? [])
				.filter((binding) => binding.script_name === undefined)
				.map((binding) => binding.class_name),
			...(config.workflows ?? []).map((workflow) => workflow.class_name)
		];
		expect(classes.length).toBeGreaterThan(0);
		for (const name of classes) expect(exported, name).toContain(name);
	});

	it('declares a migration for each Durable Object class it owns', () => {
		const owned = (config.durable_objects?.bindings ?? [])
			.filter((binding) => binding.script_name === undefined)
			.map((binding) => binding.class_name);
		const migrated = (config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
		expect(owned.sort()).toEqual(migrated.sort());
		const tags = (config.migrations ?? []).map((m) => m.tag);
		expect(new Set(tags).size).toBe(tags.length);
	});

	it('carries names and no ids', () => {
		const text = JSON.stringify(config);
		for (const key of ['"id"', '"database_id"', '"bucket_id"', '"preview_id"']) {
			expect(text).not.toContain(key);
		}
	});
});

describe.each(environments('dispatch'))('the dispatch config, %s', (_env, config) => {
	it('has every binding the dispatch code reads, apart from secrets', () => {
		expect(missingFrom(config, readsOf('dispatch'), DISPATCH_SET_AT_DEPLOY)).toEqual([]);
	});

	it('exports and migrates every class it binds', () => {
		const classes = (config.durable_objects?.bindings ?? []).map(
			(binding) => binding.class_name
		);
		const migrated = (config.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
		expect(classes.sort()).toEqual(migrated.sort());
		for (const name of classes) expect(exportsOf('dispatch'), name).toContain(name);
	});
});

describe('the engine and the dispatch unit agree', () => {
	const engine = environments('engine');
	const dispatch = environments('dispatch');

	it('binds each dispatch Durable Object by script name and class name the dispatch unit owns', () => {
		for (const [index, [env, config]] of engine.entries()) {
			const target = dispatch[index]![1];
			const remote = (config.durable_objects?.bindings ?? []).filter(
				(binding) => binding.script_name !== undefined
			);
			expect(remote.map((binding) => binding.name).sort(), env).toEqual([
				'NAMES',
				'SITE_AUTH'
			]);
			for (const binding of remote) {
				expect(binding.script_name, env).toBe(target.name ?? load('dispatch').name);
				const own = target.durable_objects?.bindings.find((b) => b.name === binding.name);
				expect(own?.class_name, `${env} ${binding.name}`).toBe(binding.class_name);
			}
		}
	});

	it('writes routes to the binding the dispatch unit reads and names one dispatch namespace', () => {
		for (const [index, [env, config]] of engine.entries()) {
			const target = dispatch[index]![1];
			expect(boundIn(config).has('HOSTS_KV'), env).toBe(true);
			expect(boundIn(target).has('HOSTS_KV'), env).toBe(true);
			expect(config.vars?.DISPATCH_NAMESPACE, env).toBe(
				target.dispatch_namespaces?.[0]?.namespace
			);
		}
	});

	it('schedules the recovery sweep in every environment, since triggers are not inherited', () => {
		for (const [, config] of environments('engine')) {
			expect(config.triggers?.crons).toEqual(['*/15 * * * *']);
		}
		expect(sourcesOfFile('engine')).toContain('scheduled');
	});

	it('bundles the engine with its own tsconfig, since shared code imports @contracts', () => {
		expect(load('engine').tsconfig).toBe('./tsconfig.json');
	});

	it('sets the stage switch in stage and nowhere else', () => {
		const [prod, stage] = environments('dispatch').map(([, config]) => config) as [
			Config,
			Config
		];
		expect(prod.vars?.SPIKE_MODE).toBeUndefined();
		expect(stage.vars?.SPIKE_MODE).toBe('1');
	});

	it('keeps stage and prod to the same bindings, with names that cannot collide', () => {
		for (const unit of ['engine', 'dispatch']) {
			const [prod, stage] = environments(unit).map(([, config]) => config) as [
				Config,
				Config
			];
			const stageBound = [...boundIn(stage)].filter((name) => !STAGE_ONLY.has(name));
			expect(stageBound.sort(), unit).toEqual([...boundIn(prod)].sort());
			expect(stage.migrations, unit).toEqual(prod.migrations);
			expect(stage.name, unit).not.toBe(prod.name);
		}
		const [prod, stage] = environments('engine').map(([, config]) => config) as [
			Config,
			Config
		];
		const names = [...(prod.workflows ?? []), ...(stage.workflows ?? [])].map((w) => w.name);
		expect(new Set(names).size).toBe(names.length);
	});
});
