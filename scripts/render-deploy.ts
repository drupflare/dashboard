import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UNITS = ['dashboard', 'engine', 'dispatch'] as const;
export const ENVIRONMENTS = ['staging', 'production', 'preview'] as const;
export type Unit = (typeof UNITS)[number];
export type Environment = (typeof ENVIRONMENTS)[number];

type Entry = { binding?: string; id?: string; database_id?: string };
export type Config = {
	d1_databases?: Entry[];
	kv_namespaces?: Entry[];
	env?: Record<string, Config>;
	[key: string]: unknown;
};

export function readConfig(path: string): Config {
	const text = readFileSync(path, 'utf8')
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n');
	return JSON.parse(text) as Config;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// objects merge key by key and arrays are replaced whole
export function merge(base: Config, overlay: Config): Config {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		const current = out[key];
		out[key] = isObject(current) && isObject(value) ? merge(current, value) : value;
	}
	return out as Config;
}

// the engine and dispatch configs name their staging block `stage`; a block replaces the top level
export function resolve(base: Config, unit: Unit, environment: Environment): Config {
	const { env, ...top } = base;
	if (unit === 'dashboard' || environment !== 'staging') return top;
	const stage = env?.stage;
	if (!stage) throw new Error(`${unit} has no stage block`);
	return { ...top, ...stage };
}

// an entry without an id would be created on the account at deploy time, once per Worker
export function missingIds(config: Config): string[] {
	const missing: string[] = [];
	for (const entry of config.d1_databases ?? []) {
		if (!entry.database_id) missing.push(`d1 ${entry.binding ?? '?'}`);
	}
	for (const entry of config.kv_namespaces ?? []) {
		if (!entry.id) missing.push(`kv ${entry.binding ?? '?'}`);
	}
	return missing;
}

export function render(
	unit: Unit,
	environment: Environment,
	read: (path: string) => Config = readConfig
): Config {
	if (environment === 'preview' && unit !== 'dashboard') {
		throw new Error(`${unit} has no preview; only the dashboard is previewed`);
	}
	const base = read(
		unit === 'dashboard' ? '.output/server/wrangler.json' : `${unit}/wrangler.jsonc`
	);
	const merged = merge(
		resolve(base, unit, environment),
		read(`deploy/${unit}.${environment}.json`)
	);
	const missing = missingIds(merged);
	if (missing.length > 0) {
		throw new Error(`deploy/${unit}.${environment}.json has no id for: ${missing.join(', ')}`);
	}
	return merged;
}

export function outputPath(unit: Unit): string {
	return unit === 'dashboard'
		? '.output/server/wrangler.deploy.json'
		: `${unit}/wrangler.deploy.json`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [unit, environment] = process.argv.slice(2);
	if (!UNITS.includes(unit as Unit) || !ENVIRONMENTS.includes(environment as Environment)) {
		console.error(
			`usage: bun scripts/render-deploy.ts <${UNITS.join('|')}> <${ENVIRONMENTS.join('|')}>`
		);
		process.exit(2);
	}
	try {
		const config = render(unit as Unit, environment as Environment);
		writeFileSync(outputPath(unit as Unit), `${JSON.stringify(config, null, '\t')}\n`);
		console.log(`wrote ${outputPath(unit as Unit)}`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
