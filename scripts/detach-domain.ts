import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ACCOUNT_ID } from './provision-secrets';

interface Domain {
	id: string;
	hostname: string;
	service: string;
}

const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/domains`;

type Fetch = typeof fetch;

// removes a Worker custom domain only when it points at the Worker the caller expects
export async function detach(
	hostname: string,
	expect: string,
	apply: boolean,
	token: string,
	call: Fetch = fetch
): Promise<string> {
	const headers = { authorization: `Bearer ${token}` };
	const listed = await call(`${base}?hostname=${encodeURIComponent(hostname)}`, { headers });
	const body = (await listed.json()) as { result?: Domain[] };
	const found = body.result?.find((domain) => domain.hostname === hostname);
	if (!found) return `${hostname} has no Worker custom domain; nothing to do`;
	if (found.service !== expect) {
		throw new Error(`${hostname} points at ${found.service}, not ${expect}; left alone`);
	}
	if (!apply) return `would detach ${hostname} from ${found.service} (add --apply)`;
	const removed = await call(`${base}/${found.id}`, { method: 'DELETE', headers });
	if (!removed.ok) throw new Error(`detach answered ${removed.status}`);
	return `detached ${hostname} from ${found.service}`;
}

function tokenFromDevVars(): string | undefined {
	const line = readFileSync('.dev.vars', 'utf8')
		.split('\n')
		.map((text) => text.match(/^\s*CF_API_TOKEN\s*=\s*(.*)\s*$/))
		.find((m) => m !== null);
	return line?.[1]?.replace(/^["']|["']$/g, '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	const [hostname, expect] = args.filter((arg) => !arg.startsWith('--'));
	const token =
		process.env.CF_API_TOKEN ?? (args.includes('--dev-vars') ? tokenFromDevVars() : undefined);
	if (!hostname || !expect || !token) {
		console.error(
			'usage: bun scripts/detach-domain.ts <hostname> <expected worker> [--dev-vars] [--apply]'
		);
		process.exit(2);
	}
	try {
		console.log(await detach(hostname, expect, args.includes('--apply'), token));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
