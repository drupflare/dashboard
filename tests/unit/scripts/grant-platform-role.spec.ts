import { describe, expect, it } from 'vitest';
import { planGrant, run } from '../../../scripts/grant-platform-role';

const apply = [
	'--email',
	'Me@Example.test',
	'--role',
	'admin',
	'--apply',
	'--account',
	'a',
	'--database',
	'd'
];

function answer(changes: number, ok = true) {
	const calls: { url: string; body: unknown }[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify({ success: ok, result: [{ meta: { changes } }] }), {
			status: ok ? 200 : 500
		});
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

describe('planGrant', () => {
	it('lower-cases the address and maps none to a null role', () => {
		expect(planGrant(' Me@Example.test ', 'admin', 5).params).toEqual([
			'admin',
			5,
			'me@example.test'
		]);
		expect(planGrant('me@example.test', 'none', 5).params[0]).toBeNull();
	});

	it('refuses an unknown role and a bad address', () => {
		expect(() => planGrant('me@example.test', 'owner', 1)).toThrow('--role must be one of');
		expect(() => planGrant('not-an-address', 'admin', 1)).toThrow('--email is not an address');
	});
});

describe('grant-platform-role', () => {
	it('prints the statement and writes nothing without --apply', async () => {
		const { calls, fetchFn } = answer(1);
		const result = await run(['--email', 'me@example.test', '--role', 'admin'], {}, fetchFn);
		expect(result.code).toBe(0);
		expect(result.out).toContain('UPDATE users SET platform_role');
		expect(result.out).toContain('not applied');
		expect(calls).toHaveLength(0);
	});

	it('writes through D1 with the token and reports the row it changed', async () => {
		const { calls, fetchFn } = answer(1);
		const result = await run(apply, { CF_API_TOKEN: 't' }, fetchFn, () => 7);
		expect(result).toEqual({ code: 0, out: 'role set to admin for me@example.test' });
		expect(calls[0]?.url).toContain('/accounts/a/d1/database/d/query');
		expect(calls[0]?.body).toEqual({
			sql: 'UPDATE users SET platform_role = ?, updated_at = ? WHERE email = ?',
			params: ['admin', 7, 'me@example.test']
		});
	});

	it('fails when no user has the address, so a typo is not a silent success', async () => {
		const result = await run(apply, { CF_API_TOKEN: 't' }, answer(0).fetchFn);
		expect(result.code).toBe(1);
		expect(result.out).toContain('sign in once first');
	});

	it('fails without a token, without ids, or when D1 refuses', async () => {
		expect((await run(apply, {}, answer(1).fetchFn)).out).toContain('CF_API_TOKEN');
		const noIds = await run(['--email', 'a@b.co', '--role', 'admin', '--apply'], {
			CF_API_TOKEN: 't'
		});
		expect(noIds.out).toContain('--account and --database');
		expect((await run(apply, { CF_API_TOKEN: 't' }, answer(1, false).fetchFn)).code).toBe(1);
	});
});
