import { z } from 'zod';
import type { CapabilityId, ProbeKind } from '../../shared/cloudflare-probe';
import type { ProbeFetch } from './cloudflare-probe';

const API = 'https://api.cloudflare.com/client/v4';
const CALL_TIMEOUT_MS = 10_000;

export interface ConnectCall {
	token: string;
	accountId: string;
	kind: ProbeKind;
	fetch: ProbeFetch;
}

export class DownscopeError extends Error {
	readonly code = 'downscope_failed';

	constructor(message: string) {
		super(message);
		this.name = 'DownscopeError';
	}
}

async function call(input: ConnectCall, path: string, init: RequestInit = {}): Promise<Response> {
	return input.fetch(`${API}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${input.token}`,
			accept: 'application/json',
			...(init.body === undefined ? {} : { 'content-type': 'application/json' })
		},
		signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
	});
}

const subdomainBody = z.object({ result: z.object({ subdomain: z.string().nullish() }).nullish() });

// null: the account has no workers.dev subdomain; undefined: Cloudflare did not answer
export async function readWorkersSubdomain(
	input: Pick<ConnectCall, 'token' | 'accountId' | 'fetch'>
): Promise<string | null | undefined> {
	let response: Response;
	try {
		response = await call(
			{ ...input, kind: 'user' },
			`/accounts/${encodeURIComponent(input.accountId)}/workers/subdomain`
		);
	} catch {
		return undefined;
	}
	if (response.status === 404) return null;
	if (!response.ok) return undefined;
	try {
		const parsed = subdomainBody.safeParse(await response.json());
		if (!parsed.success) return undefined;
		return parsed.data.result?.subdomain || null;
	} catch {
		return undefined;
	}
}

// the permission groups a site needs, by the capability the probe proved. Names are Cloudflare's own
// and unverified against the live listing, so a group the account does not list stops the mint
const GROUP_NAMES: Partial<Record<CapabilityId, string[]>> = {
	scripts: ['Workers Scripts Write', 'Workers Scripts Edit'],
	'key-value': ['Workers KV Storage Write', 'Workers KV Storage Edit'],
	storage: ['Workers R2 Storage Write', 'Workers R2 Storage Edit'],
	databases: ['D1 Write', 'D1 Edit'],
	routes: ['Workers Routes Write', 'Workers Routes Edit']
};

const groupsBody = z.object({
	result: z.array(
		z.object({ id: z.string(), name: z.string(), scopes: z.array(z.string()).optional() })
	)
});
const madeBody = z.object({
	result: z.object({ id: z.string().min(1), value: z.string().min(1) })
});

const tokensPath = (input: ConnectCall) =>
	input.kind === 'account'
		? `/accounts/${encodeURIComponent(input.accountId)}/tokens`
		: '/user/tokens';

export interface MintedToken {
	id: string;
	value: string;
}

// makes a token with only the permissions the granted capabilities need, and never token management
export async function mintNarrowToken(
	input: ConnectCall,
	granted: readonly CapabilityId[],
	name: string
): Promise<MintedToken> {
	let groups: z.infer<typeof groupsBody>['result'];
	try {
		const listed = await call(input, `${tokensPath(input)}/permission_groups`);
		if (!listed.ok)
			throw new DownscopeError('Cloudflare would not list its permission groups.');
		groups = groupsBody.parse(await listed.json()).result;
	} catch (error) {
		if (error instanceof DownscopeError) throw error;
		throw new DownscopeError('Cloudflare did not answer the permission group request.');
	}
	const account: { id: string }[] = [];
	const zone: { id: string }[] = [];
	for (const id of granted) {
		const names = GROUP_NAMES[id];
		if (names === undefined) continue;
		const group = names
			.map((wanted) => groups.find((candidate) => candidate.name === wanted))
			.find((found) => found !== undefined);
		if (group === undefined) {
			throw new DownscopeError(`Cloudflare does not list a permission group for ${id}.`);
		}
		const zoneScoped = (group.scopes ?? []).some((scope) => scope.endsWith('.zone'));
		(zoneScoped ? zone : account).push({ id: group.id });
	}
	const accountKey = `com.cloudflare.api.account.${input.accountId}`;
	const policies = [
		...(account.length === 0
			? []
			: [{ effect: 'allow', resources: { [accountKey]: '*' }, permission_groups: account }]),
		...(zone.length === 0
			? []
			: [
					{
						effect: 'allow',
						resources: { [accountKey]: { 'com.cloudflare.api.account.zone.*': '*' } },
						permission_groups: zone
					}
				])
	];
	try {
		const made = await call(input, tokensPath(input), {
			method: 'POST',
			body: JSON.stringify({ name, policies })
		});
		if (!made.ok) throw new DownscopeError('Cloudflare would not make the narrower token.');
		return madeBody.parse(await made.json()).result;
	} catch (error) {
		if (error instanceof DownscopeError) throw error;
		throw new DownscopeError('Cloudflare did not return the narrower token.');
	}
}

// the narrower token has no token-management permission, so Cloudflare may refuse this
export async function deleteToken(input: ConnectCall, tokenId: string): Promise<boolean> {
	try {
		const response = await call(input, `${tokensPath(input)}/${encodeURIComponent(tokenId)}`, {
			method: 'DELETE'
		});
		return response.ok || response.status === 404;
	} catch {
		return false;
	}
}
