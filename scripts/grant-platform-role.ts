import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PLATFORM_ROLES, isPlatformRole } from '../src/shared/permissions';

const USAGE = `usage: bun scripts/grant-platform-role.ts --email <address> --role <${PLATFORM_ROLES.join('|')}|none>
  [--apply --account <id> --database <id>]

Sets the platform role on an existing user. It prints the statement and writes nothing unless
--apply is given; --apply reads CF_API_TOKEN from the environment. The person has to have signed in
once, so the row exists. Access still has to pass for every admin request.`;

const OPTIONS = {
	email: { type: 'string' },
	role: { type: 'string' },
	apply: { type: 'boolean' },
	account: { type: 'string' },
	database: { type: 'string' },
	help: { type: 'boolean' }
} as const;

export interface RunResult {
	code: number;
	out: string;
}

export interface Plan {
	sql: string;
	params: [string | null, number, string];
}

export function planGrant(email: string, role: string, now: number): Plan {
	const address = email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('--email is not an address');
	if (role !== 'none' && !isPlatformRole(role)) {
		throw new Error(`--role must be one of ${PLATFORM_ROLES.join(', ')}, or none`);
	}
	return {
		sql: 'UPDATE users SET platform_role = ?, updated_at = ? WHERE email = ?',
		params: [role === 'none' ? null : role, now, address]
	};
}

export async function run(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
	fetchFn: typeof fetch = fetch,
	now: () => number = Date.now
): Promise<RunResult> {
	try {
		const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
		if (values.help) return { code: 0, out: USAGE };
		if (!values.email || !values.role) throw new Error('--email and --role are required');
		const plan = planGrant(values.email, values.role, now());
		if (!values.apply) {
			return { code: 0, out: `${plan.sql}\n${JSON.stringify(plan.params)}\n(not applied)` };
		}
		const token = env.CF_API_TOKEN;
		if (!token) throw new Error('--apply needs CF_API_TOKEN in the environment');
		if (!values.account || !values.database) {
			throw new Error('--apply needs --account and --database');
		}
		const response = await fetchFn(
			`https://api.cloudflare.com/client/v4/accounts/${values.account}/d1/database/${values.database}/query`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ sql: plan.sql, params: plan.params })
			}
		);
		const body = (await response.json()) as {
			success?: boolean;
			result?: { meta?: { changes?: number } }[];
		};
		if (!response.ok || body.success !== true)
			throw new Error(`D1 answered ${response.status}`);
		const changes = body.result?.[0]?.meta?.changes ?? 0;
		if (changes !== 1) {
			throw new Error(
				`no user has that address (${changes} rows changed); sign in once first`
			);
		}
		return { code: 0, out: `role set to ${values.role} for ${plan.params[2]}` };
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
