import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createSession, revokeSessionByToken, type KvStore } from '../src/server/services/sessions';

const RUN = 'bun --tsconfig-override ./tsconfig.other.json scripts/mint-session.ts';

const USAGE = `usage: ${RUN} --email <address> --out <file> [--hours <n>] [--step-up]
  --apply --account <id> --database <id> --kv <namespace id>
       ${RUN} --revoke <token file> --apply --account <id> --kv <namespace id>

Writes a session for an existing user into the stage KV namespace and the token to --out (mode
0600); the token is never printed. --hours is at most 2 and sets the KV expiry. --step-up stamps the session with a
step-up at the moment it is made, which the step-up window then ages. The address is looked up in
the D1 database. It refuses the production database and every production KV namespace named in
deploy/dashboard.production.json. Without --apply it validates and prints the plan. --apply reads
CF_API_TOKEN from the environment. The cookie is __Host-drupflare_session.`;

const OPTIONS = {
	email: { type: 'string' },
	out: { type: 'string' },
	hours: { type: 'string' },
	'step-up': { type: 'boolean' },
	revoke: { type: 'string' },
	apply: { type: 'boolean' },
	account: { type: 'string' },
	database: { type: 'string' },
	kv: { type: 'string' },
	help: { type: 'boolean' }
} as const;

const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURS = 2;
const PRODUCTION_FILE = join(
	fileURLToPath(new URL('..', import.meta.url)),
	'deploy/dashboard.production.json'
);

export interface RunResult {
	code: number;
	out: string;
}

export function planHours(raw: string | undefined): number {
	const hours = raw === undefined ? 1 : Number(raw);
	if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
		throw new Error(`--hours must be more than 0 and at most ${MAX_HOURS}`);
	}
	return hours;
}

interface Production {
	database_id?: string;
	id?: string;
}

// the ids this tool will not write to, read from the production deploy file
export function productionIds(read: () => string = () => readFileSync(PRODUCTION_FILE, 'utf8')): {
	databases: string[];
	namespaces: string[];
} {
	const config = JSON.parse(read()) as {
		d1_databases?: Production[];
		kv_namespaces?: Production[];
	};
	return {
		databases: (config.d1_databases ?? []).flatMap((entry) => entry.database_id ?? []),
		namespaces: (config.kv_namespaces ?? []).flatMap((entry) => entry.id ?? [])
	};
}

export function refuseProduction(
	input: { database?: string; kv?: string },
	ids = productionIds()
): void {
	if (input.database !== undefined && ids.databases.includes(input.database)) {
		throw new Error(
			'--database is the production database; this tool signs people in and is for stage only'
		);
	}
	if (input.kv !== undefined && ids.namespaces.includes(input.kv)) {
		throw new Error(
			'--kv is a production namespace; this tool signs people in and is for stage only'
		);
	}
}

// the Cloudflare KV REST API behind the slice of a namespace the session service uses
export function restKv(
	account: string,
	namespace: string,
	token: string,
	fetchFn: typeof fetch
): KvStore {
	const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}`;
	const headers = { authorization: `Bearer ${token}` };
	const value = (key: string) => `${base}/values/${encodeURIComponent(key)}`;
	return {
		async get(key) {
			const response = await fetchFn(value(key), { headers });
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`KV answered ${response.status}`);
			return response.text();
		},
		async put(key, text, options) {
			const ttl = options?.expirationTtl;
			const response = await fetchFn(
				`${value(key)}${ttl === undefined ? '' : `?expiration_ttl=${ttl}`}`,
				{ method: 'PUT', headers, body: text }
			);
			if (!response.ok) throw new Error(`KV answered ${response.status}`);
		},
		async delete(key) {
			const response = await fetchFn(value(key), { method: 'DELETE', headers });
			if (!response.ok && response.status !== 404) {
				throw new Error(`KV answered ${response.status}`);
			}
		},
		async list({ prefix }) {
			const response = await fetchFn(`${base}/keys?prefix=${encodeURIComponent(prefix)}`, {
				headers
			});
			if (!response.ok) throw new Error(`KV answered ${response.status}`);
			const body = (await response.json()) as { result?: { name: string }[] };
			return { keys: body.result ?? [] };
		}
	};
}

export async function run(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
	fetchFn: typeof fetch = fetch,
	now: () => number = Date.now,
	files: {
		write: (path: string, data: string) => void;
		read: (path: string) => string;
	} = {
		write: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
		read: (path) => readFileSync(path, 'utf8')
	},
	production = productionIds()
): Promise<RunResult> {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) return { code: 0, out: USAGE };
		refuseProduction({ database: values.database, kv: values.kv }, production);

		const revoking = values.revoke !== undefined;
		if (!revoking && (!values.email || !values.out)) {
			throw new Error('--email and --out are required');
		}
		const hours = revoking ? 0 : planHours(values.hours);
		if (!values.apply) {
			return {
				code: 0,
				out: revoking
					? `revoke the session in ${values.revoke}\n(not applied)`
					: `session for ${values.email!.trim().toLowerCase()}\nexpires in ${hours} h\nstep-up ${values['step-up'] ? 'now' : 'none'}\n(not applied)`
			};
		}

		const token = env.CF_API_TOKEN;
		if (!token) throw new Error('--apply needs CF_API_TOKEN in the environment');
		if (!values.account || !values.kv || (!revoking && !values.database)) {
			throw new Error('--apply needs --account, --kv and, to sign in, --database');
		}
		const kv = restKv(values.account, values.kv, token, fetchFn);

		if (revoking) {
			const ended = await revokeSessionByToken(kv, files.read(values.revoke!).trim());
			if (!ended) throw new Error('no live session has that token');
			return { code: 0, out: 'session revoked' };
		}

		const response = await fetchFn(
			`https://api.cloudflare.com/client/v4/accounts/${values.account}/d1/database/${values.database}/query`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					sql: 'SELECT id FROM users WHERE email = ?',
					params: [values.email!.trim().toLowerCase()]
				})
			}
		);
		const body = (await response.json()) as {
			success?: boolean;
			result?: { results?: { id: string }[] }[];
		};
		if (!response.ok || body.success !== true)
			throw new Error(`D1 answered ${response.status}`);
		const user = body.result?.[0]?.results?.[0];
		if (!user) throw new Error('no user has that address; sign in once first');

		const at = now();
		// the records expire after --hours; a later touch by the app slides them, so revoke when done
		const ttl = Math.max(60, Math.round(hours * 3600));
		const short: KvStore = {
			...kv,
			put: (key, text) => kv.put(key, text, { expirationTtl: ttl })
		};
		const issued = await createSession(short, {
			userId: user.id,
			userAgent: 'mint-session',
			...(values['step-up'] ? { stepUpAt: at } : {})
		});
		files.write(values.out!, `${issued.token}\n`);
		return {
			code: 0,
			out: `session ${issued.session.id} for ${user.id}, step-up ${values['step-up'] ? 'set' : 'none'}, token written to ${values.out}. The records expire in ${hours} h unless the app touches them; revoke it when done.`
		};
	} catch (error) {
		return {
			code: 1,
			out: `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`
		};
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { code, out } = await run(process.argv.slice(2));
	(code === 0 ? console.log : console.error)(out);
	process.exit(code);
}
