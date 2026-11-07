import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { keyUsable } from '../src/server/domain/scopes';
import { generateApiKey } from '../src/server/services/api-keys';
import { isAction, type Action } from '../src/shared/permissions';

const RUN = 'bun --tsconfig-override ./tsconfig.other.json scripts/mint-api-key.ts';

const USAGE = `usage: ${RUN} --email <address> --scopes <a,b,...> --out <file>
  [--hours <n>] [--name <label>] --apply --account <id> --database <id>
       ${RUN} --revoke <dfk_lookup> --apply --account <id> --database <id>

Writes an API key for an existing user into the user's personal organisation. The token goes to
--out (mode 0600) and is never printed. Scopes must be actions a key may hold. Without --apply it
validates and prints the plan. --apply reads CF_API_TOKEN from the environment. This bypasses the
audit chain, so use it to bootstrap and then issue keys from the dashboard.`;

const OPTIONS = {
	email: { type: 'string' },
	scopes: { type: 'string' },
	out: { type: 'string' },
	hours: { type: 'string' },
	name: { type: 'string' },
	revoke: { type: 'string' },
	apply: { type: 'boolean' },
	account: { type: 'string' },
	database: { type: 'string' },
	help: { type: 'boolean' }
} as const;

const HOUR_MS = 60 * 60 * 1000;

export interface RunResult {
	code: number;
	out: string;
}

export function planScopes(raw: string): Action[] {
	const scopes = raw
		.split(',')
		.map((scope) => scope.trim())
		.filter(Boolean);
	if (scopes.length === 0) throw new Error('--scopes is empty');
	for (const scope of scopes) {
		if (!isAction(scope)) throw new Error(`unknown scope ${scope}`);
		if (!keyUsable(scope)) throw new Error(`${scope} cannot be held by a key`);
	}
	return [...new Set(scopes)] as Action[];
}

export function planHours(raw: string | undefined): number {
	const hours = raw === undefined ? 2 : Number(raw);
	if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
		throw new Error('--hours must be more than 0 and at most 24');
	}
	return hours;
}

interface D1Answer {
	success?: boolean;
	result?: { results?: Record<string, unknown>[]; meta?: { changes?: number } }[];
}

export async function run(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
	fetchFn: typeof fetch = fetch,
	now: () => number = Date.now,
	write: (path: string, data: string) => void = (path, data) =>
		writeFileSync(path, data, { mode: 0o600 })
): Promise<RunResult> {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) return { code: 0, out: USAGE };

		const revoking = values.revoke !== undefined;
		if (!revoking && (!values.email || !values.scopes || !values.out)) {
			throw new Error('--email, --scopes and --out are required');
		}
		const scopes = revoking ? [] : planScopes(values.scopes!);
		const hours = revoking ? 0 : planHours(values.hours);
		if (!values.apply) {
			return {
				code: 0,
				out: revoking
					? `revoke ${values.revoke}\n(not applied)`
					: `scopes ${scopes.join(', ')}\nexpires in ${hours} h\n(not applied)`
			};
		}

		const token = env.CF_API_TOKEN;
		if (!token) throw new Error('--apply needs CF_API_TOKEN in the environment');
		if (!values.account || !values.database) {
			throw new Error('--apply needs --account and --database');
		}
		const url = `https://api.cloudflare.com/client/v4/accounts/${values.account}/d1/database/${values.database}/query`;
		const query = async (sql: string, params: unknown[]) => {
			const response = await fetchFn(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ sql, params })
			});
			const body = (await response.json()) as D1Answer;
			if (!response.ok || body.success !== true)
				throw new Error(`D1 answered ${response.status}`);
			return body.result?.[0];
		};

		if (revoking) {
			const lookup = values.revoke!.replace(/^dfk_/, '');
			const done = await query(
				`UPDATE api_keys SET revoked_at = ? WHERE id =
				 (SELECT key_id FROM api_key_lookup WHERE lookup_id = ?)`,
				[now(), lookup]
			);
			if ((done?.meta?.changes ?? 0) !== 1) throw new Error('no key has that lookup id');
			return { code: 0, out: `revoked dfk_${lookup}` };
		}

		const address = values.email!.trim().toLowerCase();
		const user = (await query('SELECT id FROM users WHERE email = ?', [address]))
			?.results?.[0] as { id: string } | undefined;
		if (!user) throw new Error('no user has that address; sign in once first');
		const org = (
			await query(
				'SELECT id FROM organizations WHERE created_by = ? AND personal = 1 LIMIT 1',
				[user.id]
			)
		)?.results?.[0] as { id: string } | undefined;
		if (!org) throw new Error('that user has no personal organisation');

		const at = now();
		const generated = await generateApiKey({ scopes, expiry: '30d', now: at });
		const expiresAt = at + hours * HOUR_MS;
		const keyId = crypto.randomUUID();
		await query(
			`INSERT INTO api_keys (id, organization_id, name, key_hash, scopes, created_by,
			 expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			[
				keyId,
				org.id,
				values.name ?? 'operator',
				generated.data.keyHash,
				JSON.stringify(scopes),
				user.id,
				expiresAt,
				at
			]
		);
		await query(
			'INSERT INTO api_key_lookup (lookup_id, organization_id, key_id) VALUES (?, ?, ?)',
			[generated.data.lookupId, org.id, keyId]
		);
		write(values.out!, `${generated.token}\n`);
		return {
			code: 0,
			out: `key ${generated.data.displayPrefix} for ${address} in ${org.id}, expires ${new Date(expiresAt).toISOString()}, token written to ${values.out}`
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
