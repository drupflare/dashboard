import { describe, expect, it } from 'vitest';
import { planHours, planScopes, run } from '../../../scripts/mint-api-key';
import { parseApiKey, verifyApiKey } from '../../../src/server/services/api-keys';

const args = [
	'--email',
	'Me@Example.test',
	'--scopes',
	'site.create,site.read',
	'--out',
	'/tmp/key',
	'--apply',
	'--account',
	'a',
	'--database',
	'd'
];

function d1(found: { user?: boolean; org?: boolean; changes?: number } = {}) {
	const { user = true, org = true, changes = 1 } = found;
	const calls: { sql: string; params: unknown[] }[] = [];
	const fetchFn = (async (_url: string, init: RequestInit) => {
		const call = JSON.parse(String(init.body)) as { sql: string; params: unknown[] };
		calls.push(call);
		let results: unknown[] = [];
		if (call.sql.includes('FROM users')) results = user ? [{ id: 'usr_1' }] : [];
		if (call.sql.includes('FROM organizations')) results = org ? [{ id: 'org_1' }] : [];
		return new Response(
			JSON.stringify({ success: true, result: [{ results, meta: { changes } }] })
		);
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

describe('planScopes', () => {
	it('dedupes and trims', () => {
		expect(planScopes(' site.read, site.read ,site.create')).toEqual([
			'site.read',
			'site.create'
		]);
	});

	it('refuses unknown, session-only and empty scopes', () => {
		expect(() => planScopes('site.nope')).toThrow('unknown scope');
		expect(() => planScopes('key.create')).toThrow('cannot be held by a key');
		expect(() => planScopes('site.owner-token.reveal')).toThrow('cannot be held by a key');
		expect(() => planScopes(' , ')).toThrow('--scopes is empty');
	});
});

describe('planHours', () => {
	it('defaults to two and caps at a day', () => {
		expect(planHours(undefined)).toBe(2);
		expect(() => planHours('0')).toThrow('--hours');
		expect(() => planHours('25')).toThrow('--hours');
		expect(() => planHours('x')).toThrow('--hours');
	});
});

describe('mint-api-key', () => {
	it('validates and writes nothing without --apply', async () => {
		const { calls, fetchFn } = d1();
		const result = await run(
			['--email', 'me@example.test', '--scopes', 'site.read', '--out', '/tmp/key'],
			{},
			fetchFn
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain('not applied');
		expect(calls).toHaveLength(0);
	});

	it('stores the hash and the lookup row, writes the token to the file and never prints it', async () => {
		const { calls, fetchFn } = d1();
		const written: { path: string; data: string }[] = [];
		const result = await run(
			args,
			{ CF_API_TOKEN: 't' },
			fetchFn,
			() => 1_000,
			(path, data) => written.push({ path, data })
		);
		expect(result.code).toBe(0);
		const token = written[0]!.data.trim();
		expect(written[0]!.path).toBe('/tmp/key');
		expect(result.out).not.toContain(token);
		expect(result.out).toContain(parseApiKey(token)!.displayPrefix);

		const insert = calls.find((call) => call.sql.startsWith('INSERT INTO api_keys'))!;
		const [id, orgId, , keyHash, scopes, createdBy, expiresAt] = insert.params as [
			string,
			string,
			string,
			string,
			string,
			string,
			number
		];
		expect(orgId).toBe('org_1');
		expect(createdBy).toBe('usr_1');
		expect(JSON.parse(scopes)).toEqual(['site.create', 'site.read']);
		expect(expiresAt).toBe(1_000 + 2 * 60 * 60 * 1000);
		expect(await verifyApiKey(token, { keyHash, expiresAt }, 2_000)).toEqual({ ok: true });

		const lookup = calls.find((call) => call.sql.startsWith('INSERT INTO api_key_lookup'))!;
		expect(lookup.params).toEqual([parseApiKey(token)!.lookupId, 'org_1', id]);
		expect(calls.indexOf(insert)).toBeLessThan(calls.indexOf(lookup));
	});

	it('refuses an unknown user and a user with no personal organisation', async () => {
		const noUser = await run(args, { CF_API_TOKEN: 't' }, d1({ user: false }).fetchFn);
		expect(noUser.code).toBe(1);
		expect(noUser.out).toContain('sign in once first');
		const noOrg = await run(args, { CF_API_TOKEN: 't' }, d1({ org: false }).fetchFn);
		expect(noOrg.out).toContain('no personal organisation');
	});

	it('needs the token and the database ids to apply', async () => {
		expect((await run(args, {}, d1().fetchFn)).out).toContain('CF_API_TOKEN');
		const noDb = args.filter((arg) => arg !== '--account' && arg !== 'a');
		expect((await run(noDb, { CF_API_TOKEN: 't' }, d1().fetchFn)).out).toContain('--account');
	});

	it('revokes by lookup id and reports a miss', async () => {
		const hit = d1();
		const ok = await run(
			['--revoke', 'dfk_abc123', '--apply', '--account', 'a', '--database', 'd'],
			{ CF_API_TOKEN: 't' },
			hit.fetchFn,
			() => 9
		);
		expect(ok).toEqual({ code: 0, out: 'revoked dfk_abc123' });
		expect(hit.calls[0]!.params).toEqual([9, 'abc123']);
		const miss = await run(
			['--revoke', 'dfk_abc123', '--apply', '--account', 'a', '--database', 'd'],
			{ CF_API_TOKEN: 't' },
			d1({ changes: 0 }).fetchFn
		);
		expect(miss.code).toBe(1);
	});
});
