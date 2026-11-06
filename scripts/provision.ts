import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SITE_CONFIGS, type SiteConfig } from '../contracts/src/sites';
import { dryRun, planResources } from '../engine/src/provision-plan';

const USAGE = `usage: bun --tsconfig-override engine/tsconfig.json scripts/provision.ts
  --site <site id> --config <managed|canonical>
  --kv-limit <n> --rate-limit <n> --window-seconds <n>
  [--kv-in-use <n>] [--database]

Prints the per-site resources and what creating them costs. It never calls Cloudflare.
--apply is refused.`;

const OPTIONS = {
	site: { type: 'string' },
	config: { type: 'string' },
	'kv-limit': { type: 'string' },
	'rate-limit': { type: 'string' },
	'window-seconds': { type: 'string' },
	'kv-in-use': { type: 'string' },
	database: { type: 'boolean' },
	apply: { type: 'boolean' },
	help: { type: 'boolean' }
} as const;

export interface RunResult {
	code: number;
	out: string;
}

function count(name: string, value: string | undefined, required: boolean): number | null {
	if (value === undefined) {
		if (required) throw new Error(`--${name} is required`);
		return null;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive whole number`);
	}
	return parsed;
}

export function run(argv: string[]): RunResult {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) return { code: 0, out: USAGE };
		if (values.apply) {
			return {
				code: 2,
				out: '--apply is refused: this script only prints the plan and calls nothing.'
			};
		}
		if (!values.site) throw new Error('--site is required');
		const config = values.config as SiteConfig | undefined;
		if (!config || !SITE_CONFIGS.includes(config)) {
			throw new Error(`--config must be one of ${SITE_CONFIGS.join(', ')}`);
		}
		const limits = {
			kvNamespaces: count('kv-limit', values['kv-limit'], true)!,
			requestsPerWindow: count('rate-limit', values['rate-limit'], true)!,
			windowSeconds: count('window-seconds', values['window-seconds'], true)!
		};
		const usage = { kvNamespaces: count('kv-in-use', values['kv-in-use'], false) };
		const plan = planResources({ id: values.site }, config, { database: values.database });
		return { code: 0, out: dryRun(plan, limits, usage) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, out: `${message}\n\n${USAGE}` };
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { code, out } = run(process.argv.slice(2));
	(code === 0 ? console.log : console.error)(out);
	process.exit(code);
}
