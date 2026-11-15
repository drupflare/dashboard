import { z } from 'zod';
import type {
	CapabilityId,
	ProbeAccount,
	ProbeCapability,
	ProbeKind,
	ProbeReport,
	ProbeStatus
} from '../../shared/cloudflare-probe';
import { ApiError } from '../../shared/errors';

export type ProbeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeInput {
	token: string;
	accountId?: string;
	fetch: ProbeFetch;
}

const API = 'https://api.cloudflare.com/client/v4';
const CALL_TIMEOUT_MS = 10_000;
const CALL_BUDGET = 12;
const RETRY_HINT = 'Cloudflare did not answer this check. Try again in a few minutes.';

// the user verify endpoint is documented; the account verify endpoint is not, so an account token is found by its prefix or by a refused user verify
const verifyBody = z.object({
	result: z.object({
		id: z.string().optional(),
		status: z.string(),
		expires_on: z.string().nullish()
	})
});
const accountsBody = z.object({
	result: z.array(z.object({ id: z.string().min(1), name: z.string() }))
});

const VERIFY_STATUS: Record<string, ProbeStatus> = {
	active: 'active',
	expired: 'expired',
	disabled: 'disabled'
};

type Outcome =
	| { state: 'ok'; body: unknown }
	| { state: 'forbidden' }
	| { state: 'not-enabled' }
	| { state: 'refused' }
	| { state: 'retry' };

interface Check {
	id: CapabilityId;
	label: string;
	permission: string;
	path: string;
}

// returns a response body, or says why it did not; the token is only ever sent as the bearer header
async function request(
	input: ProbeInput,
	budget: { left: number },
	path: string
): Promise<Outcome> {
	if (budget.left <= 0) return { state: 'retry' };
	budget.left -= 1;
	let response: Response;
	try {
		response = await input.fetch(`${API}${path}`, {
			method: 'GET',
			headers: { authorization: `Bearer ${input.token}`, accept: 'application/json' },
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
		});
	} catch {
		return { state: 'retry' };
	}
	if (response.status === 403 || response.status === 400) {
		if (await isNotEnabled(response)) return { state: 'not-enabled' };
	}
	if (response.status === 403) return { state: 'forbidden' };
	if (response.status === 401) return { state: 'refused' };
	if (!response.ok) return { state: 'retry' };
	try {
		const body: unknown = await response.json();
		if (isFailure(body)) return { state: 'retry' };
		return { state: 'ok', body };
	} catch {
		return { state: 'retry' };
	}
}

// R2 answers 10042 on an account that has not turned it on, which needs a payment card
const R2_NOT_ENABLED_CODE = 10042;

async function isNotEnabled(response: Response): Promise<boolean> {
	try {
		const body = (await response.clone().json()) as { errors?: { code?: unknown }[] };
		return (body.errors ?? []).some((error) => error.code === R2_NOT_ENABLED_CODE);
	} catch {
		return false;
	}
}

function isFailure(body: unknown): boolean {
	return (
		typeof body === 'object' &&
		body !== null &&
		(body as { success?: unknown }).success === false
	);
}

function checks(kind: ProbeKind, accountId: string): Check[] {
	const base = `/accounts/${encodeURIComponent(accountId)}`;
	return [
		{
			id: 'scripts',
			label: 'Site scripts',
			permission: 'Workers Scripts Edit',
			path: `${base}/workers/scripts`
		},
		{
			id: 'key-value',
			label: 'Key-value storage',
			permission: 'Workers KV Storage Edit',
			path: `${base}/storage/kv/namespaces`
		},
		{
			id: 'storage',
			label: 'Object storage',
			permission: 'Workers R2 Storage Edit',
			path: `${base}/r2/buckets`
		},
		{ id: 'databases', label: 'Databases', permission: 'D1:Edit', path: `${base}/d1/database` },
		{
			id: 'routes',
			label: 'Domains and routes',
			permission: 'Workers Routes Write',
			path: `${base}/workers/domains`
		},
		kind === 'user'
			? {
					id: 'token-management',
					label: 'Token management',
					permission: 'API Tokens Write',
					path: '/user/tokens/permission_groups'
				}
			: {
					id: 'token-management',
					label: 'Token management',
					permission: 'Account API Tokens Write',
					path: `${base}/tokens/permission_groups`
				}
	];
}

async function checkCapability(
	input: ProbeInput,
	budget: { left: number },
	check: Check
): Promise<ProbeCapability> {
	const outcome = await request(input, budget, check.path);
	// only a 403 means the permission is missing; a 401 or a failure is not a verdict
	const state = {
		ok: 'granted',
		forbidden: 'missing',
		'not-enabled': 'not-enabled',
		refused: 'unknown',
		retry: 'unknown'
	}[outcome.state] as ProbeCapability['state'];
	return {
		id: check.id,
		label: check.label,
		state,
		permission: check.permission,
		retryHint: state === 'unknown' ? RETRY_HINT : null
	};
}

function report(partial: Partial<ProbeReport> & { status: ProbeStatus }): ProbeReport {
	return {
		kind: null,
		tokenId: null,
		expiresOn: null,
		accounts: [],
		account: null,
		capabilities: [],
		canDownscope: false,
		...partial
	};
}

export async function probeCloudflareToken(input: ProbeInput): Promise<ProbeReport> {
	const budget = { left: CALL_BUDGET };
	let kind: ProbeKind = input.token.startsWith('cfat_') ? 'account' : 'user';
	let tokenId: string | null = null;
	let expiresOn: string | null = null;

	if (kind === 'user') {
		const verify = await request(input, budget, '/user/tokens/verify');
		if (verify.state === 'retry') return report({ status: 'unknown', kind });
		if (verify.state === 'ok') {
			const parsed = verifyBody.safeParse(verify.body);
			if (!parsed.success) return report({ status: 'unknown', kind });
			const { result } = parsed.data;
			const status = VERIFY_STATUS[result.status] ?? 'invalid';
			tokenId = result.id ?? null;
			expiresOn = result.expires_on ?? null;
			if (status !== 'active') return report({ status, kind, tokenId, expiresOn });
		} else {
			kind = 'account';
		}
	}

	const listed = await request(input, budget, '/accounts');
	if (listed.state === 'retry') return report({ status: 'unknown', kind, tokenId, expiresOn });
	if (listed.state !== 'ok') return report({ status: 'invalid', kind, tokenId, expiresOn });
	const parsed = accountsBody.safeParse(listed.body);
	if (!parsed.success) return report({ status: 'unknown', kind, tokenId, expiresOn });

	const accounts: ProbeAccount[] = parsed.data.result.map(({ id, name }) => ({ id, name }));
	let account: ProbeAccount | null = accounts[0] ?? null;
	if (input.accountId !== undefined) {
		account = accounts.find((candidate) => candidate.id === input.accountId) ?? null;
		if (account === null) {
			throw new ApiError('unprocessable', 'That account is not visible to this token.');
		}
	}
	const base = { status: 'active' as const, kind, tokenId, expiresOn, accounts, account };
	if (account === null) return report(base);

	const capabilities = await Promise.all(
		checks(kind, account.id).map((check) => checkCapability(input, budget, check))
	);
	const canDownscope = capabilities.some(
		(capability) => capability.id === 'token-management' && capability.state === 'granted'
	);
	return report({ ...base, capabilities, canDownscope });
}
