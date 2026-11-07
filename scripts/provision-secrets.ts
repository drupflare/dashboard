import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fromBase64Url, signingKeyFromSeed, toBase64Url } from '../contracts/src/common';

export const REPO = 'drupflare/dashboard';
export const ACCOUNT_ID = '2bba2ae752a5bb611580fdccbce6d200';

export const WORKERS = {
	production: {
		dispatch: 'drupflare-dispatch',
		engine: 'drupflare-engine',
		dashboard: 'drupflare-dashboard'
	}
} as const;

const OPTIONAL_FROM_DEV_VARS = [
	'NUXT_TURNSTILE_SECRET_KEY',
	'NUXT_GITHUB_CLIENT_SECRET',
	'NUXT_GITLAB_CLIENT_SECRET'
] as const;

export type Values = Record<string, string>;

const random = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

// the public keys are derived from the seeds, so a pair can never drift apart
export async function generateSecrets(): Promise<Values> {
	const site = random();
	const control = random();
	return {
		SITE_AUTH_SEED: site,
		LEASE_PUBLIC_KEY: (await signingKeyFromSeed(fromBase64Url(site))).publicKey,
		CONTROL_SEED: control,
		CONTROL_PUBLIC_KEY: (await signingKeyFromSeed(fromBase64Url(control))).publicKey,
		START_SECRET: random(),
		KEK_V1: random(),
		AUTH_CODE_SECRET: random()
	};
}

export type Action =
	| { kind: 'worker'; worker: string; name: string; value: string }
	| { kind: 'github'; environment: string; name: string; value: string };

// Worker secrets are set only for production, since the staging Workers already hold theirs
export function plan(environment: 'staging' | 'production', values: Values): Action[] {
	const github: Action[] = [
		{ kind: 'github', environment, name: 'CLOUDFLARE_API_TOKEN', value: values.CF_API_TOKEN! },
		{ kind: 'github', environment, name: 'CLOUDFLARE_ACCOUNT_ID', value: ACCOUNT_ID }
	];
	if (environment === 'staging') return github;
	const w = WORKERS.production;
	const on = (worker: string, names: string[]): Action[] =>
		names.map((name) => ({ kind: 'worker', worker, name, value: values[name]! }));
	return [
		...on(w.dispatch, ['SITE_AUTH_SEED', 'LEASE_PUBLIC_KEY', 'CONTROL_PUBLIC_KEY']),
		...on(w.engine, [
			'CONTROL_SEED',
			'START_SECRET',
			'KEK_V1',
			'CF_API_TOKEN',
			'CF_ACCOUNT_ID'
		]),
		...on(w.dashboard, [
			'START_SECRET',
			'KEK_V1',
			'AUTH_CODE_SECRET',
			...OPTIONAL_FROM_DEV_VARS.filter((name) => values[name] !== undefined)
		]),
		...github
	];
}

function devVars(path: string): Values {
	return Object.fromEntries(
		readFileSync(path, 'utf8')
			.split('\n')
			.map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map((m) => [m[1]!, m[2]!.replace(/^["']|["']$/g, '')])
	);
}

async function run(command: string[], stdin: string, env: Record<string, string>) {
	const [file, ...args] = command;
	const child = spawnSync(file!, args, {
		input: stdin,
		encoding: 'utf8',
		env: { ...process.env, ...env }
	});
	const code = child.status ?? 1;
	// a failing command can echo its input, so only the tail of its own output is shown, minus the value
	const tail = `${child.stdout}${child.stderr}`
		.split('\n')
		.filter((line) => line !== '' && !line.includes(stdin))
		.slice(-2)
		.join(' | ');
	return { code, tail };
}

// the Cloudflare API drops connections now and then, and a put is safe to repeat
export async function withRetry<T>(
	attempt: () => Promise<T>,
	done: (value: T) => boolean,
	tries: number,
	pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
	let last = await attempt();
	for (let n = 1; n < tries && !done(last); n++) {
		await pause(3000);
		last = await attempt();
	}
	return last;
}

async function apply(action: Action, token: string): Promise<boolean> {
	const cloudflare = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID };
	const result =
		action.kind === 'worker'
			? await withRetry(
					() =>
						run(
							[
								'bunx',
								'wrangler',
								'secret',
								'put',
								action.name,
								'--name',
								action.worker
							],
							action.value,
							{ ...cloudflare, WRANGLER_SEND_METRICS: 'false' }
						),
					(attempt) => attempt.code === 0,
					5
				)
			: await run(
					[
						'gh',
						'secret',
						'set',
						action.name,
						'--env',
						action.environment,
						'--repo',
						REPO
					],
					action.value,
					{}
				);
	const target = action.kind === 'worker' ? action.worker : `github ${action.environment}`;
	console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${target} ${action.name}`);
	if (result.code !== 0) console.error(`     ${result.tail}`);
	return result.code === 0;
}

const USAGE = `usage: bun scripts/provision-secrets.ts <staging|production> [--dev-vars] [--dry-run]

staging     sets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on the GitHub environment
production  generates the production keys, sets them on the production Workers, writes them to
            ~/drupflare-production-secrets.json (0600) and sets the GitHub environment secrets
--dev-vars  reads CF_API_TOKEN and the sign-in provider secrets from .dev.vars; without it
            CF_API_TOKEN must be in the environment
--dry-run   prints the names it would set and calls nothing
--resume    production only: sets every secret again from the escrow file, for a run that
            failed part way, so the keys keep the values already written

It never prints a value and never rotates: production refuses to run over an escrow file
without --resume.`;

async function main(argv: string[]): Promise<number> {
	const { values: flags, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			'dev-vars': { type: 'boolean' },
			'dry-run': { type: 'boolean' },
			resume: { type: 'boolean' }
		}
	});
	const environment = positionals[0];
	if (environment !== 'staging' && environment !== 'production') {
		console.error(USAGE);
		return 2;
	}
	const fromFile = flags['dev-vars'] ? devVars('.dev.vars') : {};
	const token = process.env.CF_API_TOKEN ?? fromFile.CF_API_TOKEN;
	if (!token && !flags['dry-run']) {
		console.error('CF_API_TOKEN is not set; use --dev-vars or export it\n\n' + USAGE);
		return 2;
	}
	const escrow = join(homedir(), 'drupflare-production-secrets.json');
	if (flags.resume && environment === 'production') {
		if (!existsSync(escrow)) {
			console.error(`${escrow} does not exist; nothing to resume`);
			return 1;
		}
		const saved = JSON.parse(readFileSync(escrow, 'utf8')) as Values;
		let failed = 0;
		for (const action of plan(environment, saved)) {
			if (flags['dry-run'])
				console.log(action.kind === 'worker' ? action.worker : 'github', action.name);
			else if (!(await apply(action, saved.CF_API_TOKEN!))) failed++;
		}
		return failed === 0 ? 0 : 1;
	}
	if (environment === 'production' && existsSync(escrow) && !flags['dry-run']) {
		console.error(`${escrow} exists; use --resume to set the same keys again`);
		return 1;
	}
	const generated = environment === 'production' ? await generateSecrets() : {};
	const optional = Object.fromEntries(
		OPTIONAL_FROM_DEV_VARS.flatMap((name) => (fromFile[name] ? [[name, fromFile[name]]] : []))
	);
	const all: Values = {
		...generated,
		...optional,
		CF_API_TOKEN: token ?? 'dry-run',
		CF_ACCOUNT_ID: ACCOUNT_ID
	};
	const actions = plan(environment, all);
	if (flags['dry-run']) {
		for (const a of actions) {
			console.log(`${a.kind === 'worker' ? a.worker : `github ${a.environment}`} ${a.name}`);
		}
		return 0;
	}
	if (environment === 'production') {
		writeFileSync(escrow, JSON.stringify(all, null, '\t'), { mode: 0o600 });
		console.log(`wrote ${escrow}; keep a copy somewhere that is not this machine`);
	}
	let failed = 0;
	for (const action of actions) if (!(await apply(action, token!))) failed++;
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(await main(process.argv.slice(2)));
}
