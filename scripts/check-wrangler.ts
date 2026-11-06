import { readFileSync } from 'node:fs';

type Wrangler = Record<string, unknown>;

const BINDING_KEYS = [
	'kv_namespaces',
	'd1_databases',
	'r2_buckets',
	'durable_objects',
	'queues',
	'services'
];

function read(path: string): Wrangler {
	const text = readFileSync(path, 'utf8')
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n');
	return JSON.parse(text) as Wrangler;
}

function names(config: Wrangler): string[] {
	const out: string[] = [];
	for (const key of BINDING_KEYS) {
		const value = config[key];
		const list = Array.isArray(value)
			? value
			: ((value as { bindings?: unknown[] } | undefined)?.bindings ?? []);
		for (const item of list as { binding?: string; name?: string }[]) {
			const name = item.binding ?? item.name;
			if (name) out.push(name);
		}
	}
	return out;
}

function crons(config: Wrangler): string[] {
	return ((config.triggers as { crons?: string[] } | undefined)?.crons ?? []).slice();
}

const sourceConfig = read('wrangler.jsonc');
const builtConfig = read('.output/server/wrangler.json');
const source = names(sourceConfig);
const built = names(builtConfig);

const missing = source.filter((name) => !built.includes(name));
const missingCrons = crons(sourceConfig).filter((cron) => !crons(builtConfig).includes(cron));
if (missing.length > 0 || missingCrons.length > 0) {
	if (missing.length > 0) {
		console.error(
			`bindings in wrangler.jsonc missing from the build output: ${missing.join(', ')}`
		);
	}
	if (missingCrons.length > 0) {
		console.error(
			`crons in wrangler.jsonc missing from the build output: ${missingCrons.join(', ')}`
		);
	}
	process.exit(1);
}

console.log(
	`ok: ${source.length} bindings and ${crons(sourceConfig).length} crons in wrangler.jsonc all present in the build output`
);
