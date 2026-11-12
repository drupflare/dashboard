import { describe, expect, it } from 'vitest';
import {
	probeCloudflareToken,
	type ProbeFetch
} from '../../../../src/server/integrations/cloudflare-probe';
import { ApiError } from '../../../../src/shared/errors';

const ACCOUNT = 'a'.repeat(32);
const SECOND = 'b'.repeat(32);
const USER_TOKEN = 'user-token-value-0123456789';
const ACCOUNT_TOKEN = 'cfat_account-token-value-0123456789';
const API = '/client/v4';

type Handler = (path: string) => Response | 'throw';

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown) => json({ success: true, errors: [], messages: [], result });

function fake(handler: Handler) {
	const calls: { url: string; authorization: string | null; signal: unknown }[] = [];
	const fetch: ProbeFetch = async (input, init) => {
		calls.push({
			url: input,
			authorization: new Headers(init?.headers).get('authorization'),
			signal: init?.signal
		});
		const answer = handler(new URL(input).pathname);
		if (answer === 'throw') throw new TypeError('socket reset');
		return answer;
	};
	return { fetch, calls };
}

const granted = (accountId = ACCOUNT): Record<string, Response> => ({
	[`${API}/accounts/${accountId}/workers/scripts`]: ok([]),
	[`${API}/accounts/${accountId}/storage/kv/namespaces`]: ok([]),
	[`${API}/accounts/${accountId}/r2/buckets`]: ok([]),
	[`${API}/accounts/${accountId}/d1/database`]: ok([]),
	[`${API}/accounts/${accountId}/workers/domains`]: ok([]),
	[`${API}/user/tokens/permission_groups`]: ok([]),
	[`${API}/accounts/${accountId}/tokens/permission_groups`]: ok([])
});

// a fresh answer per call, so a body can be read once
function answers(map: () => Record<string, Response>): Handler {
	return (path) => {
		const table = map();
		const hit = table[path];
		return hit ?? json({ success: false, errors: [{ code: 7003 }] }, 404);
	};
}

const userVerify = {
	[`${API}/user/tokens/verify`]: () =>
		ok({ id: 'tok_1', status: 'active', expires_on: '2027-01-01T00:00:00Z' })
};

function table(overrides: Record<string, () => Response> = {}, base = granted()) {
	const merged = (): Record<string, Response> => ({
		...base,
		...mapOf(userVerify),
		...mapOf(overrides)
	});
	return answers(merged);
}

const mapOf = (source: Record<string, () => Response>): Record<string, Response> =>
	Object.fromEntries(Object.entries(source).map(([key, make]) => [key, make()]));

const accountsOk = { [`${API}/accounts`]: () => ok([{ id: ACCOUNT, name: 'Campus Site' }]) };

describe('probeCloudflareToken: token kind and status', () => {
	it('reports an active user token with every capability granted', async () => {
		const { fetch, calls } = fake(table(accountsOk));
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(report).toMatchObject({
			status: 'active',
			kind: 'user',
			tokenId: 'tok_1',
			expiresOn: '2027-01-01T00:00:00Z',
			account: { id: ACCOUNT, name: 'Campus Site' },
			canDownscope: true
		});
		expect(report.capabilities.map((row) => [row.id, row.state])).toEqual([
			['scripts', 'granted'],
			['key-value', 'granted'],
			['storage', 'granted'],
			['databases', 'granted'],
			['routes', 'granted'],
			['token-management', 'granted']
		]);
		expect(calls.length).toBe(8);
	});

	it('finds an account token by its prefix and skips the user verify call', async () => {
		const { fetch, calls } = fake(
			table(
				{
					[`${API}/accounts`]: () => ok([{ id: ACCOUNT, name: 'Campus Site' }])
				},
				granted()
			)
		);
		const report = await probeCloudflareToken({ token: ACCOUNT_TOKEN, fetch });
		expect(report.kind).toBe('account');
		expect(report.tokenId).toBeNull();
		expect(report.status).toBe('active');
		expect(calls.some((call) => call.url.endsWith('/user/tokens/verify'))).toBe(false);
		const tokens = report.capabilities.find((row) => row.id === 'token-management');
		expect(tokens).toMatchObject({ state: 'granted', permission: 'Account API Tokens Write' });
		expect(
			calls.some((call) => call.url.endsWith(`/accounts/${ACCOUNT}/tokens/permission_groups`))
		).toBe(true);
	});

	it('finds an account token when the user verify is refused', async () => {
		const { fetch } = fake((path) => {
			if (path === `${API}/user/tokens/verify`) return json({ success: false }, 401);
			return table(accountsOk)(path);
		});
		const report = await probeCloudflareToken({ token: 'legacy-token-no-prefix', fetch });
		expect(report).toMatchObject({ kind: 'account', status: 'active', tokenId: null });
	});

	it('reports an expired token and makes no further calls', async () => {
		const { fetch, calls } = fake((path) => {
			if (path === `${API}/user/tokens/verify`) return ok({ id: 'tok_2', status: 'expired' });
			return json({}, 500);
		});
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(report).toMatchObject({
			status: 'expired',
			kind: 'user',
			tokenId: 'tok_2',
			accounts: [],
			capabilities: []
		});
		expect(calls.length).toBe(1);
	});

	it('reports a disabled token', async () => {
		const { fetch } = fake((path) =>
			path === `${API}/user/tokens/verify`
				? ok({ id: 'tok_3', status: 'disabled' })
				: json({}, 500)
		);
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).status).toBe('disabled');
	});

	it('reports a status it does not know as invalid', async () => {
		const { fetch } = fake((path) =>
			path === `${API}/user/tokens/verify`
				? ok({ id: 'tok_4', status: 'pending' })
				: json({}, 500)
		);
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).status).toBe('invalid');
	});

	it('reports a token Cloudflare refuses on the account list as invalid', async () => {
		const { fetch } = fake(table({ [`${API}/accounts`]: () => json({ success: false }, 401) }));
		const report = await probeCloudflareToken({ token: ACCOUNT_TOKEN, fetch });
		expect(report).toMatchObject({ status: 'invalid', accounts: [], capabilities: [] });
	});

	it('reports unknown with no further calls when the verify request throws', async () => {
		const { fetch, calls } = fake(() => 'throw');
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(report.status).toBe('unknown');
		expect(calls.length).toBe(1);
	});

	it('reports unknown for a 429 on the verify request', async () => {
		const { fetch } = fake(() => json({ success: false }, 429));
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).status).toBe('unknown');
	});

	it('reports unknown when the verify body does not have the expected shape', async () => {
		const { fetch } = fake((path) =>
			path === `${API}/user/tokens/verify` ? ok({ nope: true }) : json({}, 500)
		);
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).status).toBe('unknown');
	});

	it('reports unknown when the account list fails with a server error', async () => {
		const { fetch } = fake(table({ [`${API}/accounts`]: () => json({ success: false }, 503) }));
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).status).toBe('unknown');
	});
});

describe('probeCloudflareToken: capabilities', () => {
	it('marks a capability missing on a 403 and names the permission to add', async () => {
		const { fetch } = fake(
			table({
				...accountsOk,
				[`${API}/accounts/${ACCOUNT}/r2/buckets`]: () => json({ success: false }, 403)
			})
		);
		const row = (await probeCloudflareToken({ token: USER_TOKEN, fetch })).capabilities.find(
			(item) => item.id === 'storage'
		);
		expect(row).toEqual({
			id: 'storage',
			label: 'Object storage',
			state: 'missing',
			permission: 'Workers R2 Storage Edit',
			retryHint: null
		});
	});

	it('marks a capability unknown on a 401, a 429, a 5xx, a failure body and a network throw', async () => {
		const cases: Record<string, () => Response | 'throw'> = {
			[`${API}/accounts/${ACCOUNT}/workers/scripts`]: () => json({ success: false }, 401),
			[`${API}/accounts/${ACCOUNT}/storage/kv/namespaces`]: () => json({}, 429),
			[`${API}/accounts/${ACCOUNT}/r2/buckets`]: () => json({}, 502),
			[`${API}/accounts/${ACCOUNT}/d1/database`]: () => json({ success: false, result: [] }),
			[`${API}/accounts/${ACCOUNT}/workers/domains`]: () => 'throw'
		};
		const { fetch } = fake((path) => {
			const answer = cases[path];
			if (answer) return answer();
			return table(accountsOk)(path);
		});
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		const states = Object.fromEntries(report.capabilities.map((row) => [row.id, row.state]));
		expect(states).toMatchObject({
			scripts: 'unknown',
			'key-value': 'unknown',
			storage: 'unknown',
			databases: 'unknown',
			routes: 'unknown',
			'token-management': 'granted'
		});
		const hinted = report.capabilities.find((row) => row.id === 'scripts');
		expect(hinted?.retryHint).toContain('Try again');
	});

	it('reports a missing token-management permission and does not allow downscoping', async () => {
		const { fetch } = fake(
			table({
				...accountsOk,
				[`${API}/user/tokens/permission_groups`]: () => json({ success: false }, 403)
			})
		);
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(report.canDownscope).toBe(false);
		expect(report.capabilities.find((row) => row.id === 'token-management')).toMatchObject({
			state: 'missing',
			permission: 'API Tokens Write'
		});
	});

	it('checks only the account the caller names when the token sees more than one', async () => {
		const { fetch, calls } = fake(
			table(
				{
					[`${API}/accounts`]: () =>
						ok([
							{ id: ACCOUNT, name: 'Campus Site' },
							{ id: SECOND, name: 'Second Site' }
						])
				},
				{ ...granted(ACCOUNT), ...granted(SECOND) }
			)
		);
		const report = await probeCloudflareToken({
			token: ACCOUNT_TOKEN,
			fetch,
			accountId: SECOND
		});
		expect(report.account).toEqual({ id: SECOND, name: 'Second Site' });
		expect(report.accounts).toHaveLength(2);
		expect(calls.some((call) => call.url.includes(`/accounts/${SECOND}/workers/scripts`))).toBe(
			true
		);
		expect(
			calls.some((call) => call.url.includes(`/accounts/${ACCOUNT}/workers/scripts`))
		).toBe(false);
	});

	it('uses the first account when the caller names none', async () => {
		const { fetch } = fake(
			table({
				[`${API}/accounts`]: () =>
					ok([
						{ id: ACCOUNT, name: 'Campus Site' },
						{ id: SECOND, name: 'Second Site' }
					])
			})
		);
		expect((await probeCloudflareToken({ token: USER_TOKEN, fetch })).account?.id).toBe(
			ACCOUNT
		);
	});

	it('refuses an account the token cannot see, without echoing the token', async () => {
		const { fetch } = fake(table(accountsOk));
		const failure = await probeCloudflareToken({
			token: USER_TOKEN,
			fetch,
			accountId: 'c'.repeat(32)
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).code).toBe('unprocessable');
		expect(String((failure as Error).message)).not.toContain(USER_TOKEN);
	});

	it('reports no capabilities when the token sees no accounts', async () => {
		const { fetch, calls } = fake(table({ [`${API}/accounts`]: () => ok([]) }));
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(report).toMatchObject({
			status: 'active',
			account: null,
			accounts: [],
			capabilities: []
		});
		expect(calls.length).toBe(2);
	});
});

describe('probeCloudflareToken: transport rules', () => {
	it('sends every call to the fixed host with the token only in the bearer header', async () => {
		const { fetch, calls } = fake(table(accountsOk));
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(calls.length).toBeLessThanOrEqual(12);
		for (const call of calls) {
			expect(call.url.startsWith('https://api.cloudflare.com/client/v4/')).toBe(true);
			expect(call.authorization).toBe(`Bearer ${USER_TOKEN}`);
			expect(call.signal).toBeDefined();
		}
		expect(JSON.stringify(report)).not.toContain(USER_TOKEN);
	});

	it('does not put the token in a thrown error when the fetch throws with it in the message', async () => {
		const leaky: ProbeFetch = async () => {
			throw new TypeError(`bad request for ${USER_TOKEN}`);
		};
		const report = await probeCloudflareToken({ token: USER_TOKEN, fetch: leaky });
		expect(report.status).toBe('unknown');
		expect(JSON.stringify(report)).not.toContain(USER_TOKEN);
	});

	it('makes at most 12 calls in a full run', async () => {
		const { fetch, calls } = fake(table(accountsOk));
		await probeCloudflareToken({ token: USER_TOKEN, fetch });
		expect(calls.length).toBeLessThanOrEqual(12);
	});
});
