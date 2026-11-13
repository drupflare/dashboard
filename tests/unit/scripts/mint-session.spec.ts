import { describe, expect, it } from 'vitest';
import {
	planHours,
	productionIds,
	refuseProduction,
	restKv,
	run
} from '../../../scripts/mint-session';
import { getSession, SESSION_COOKIE_NAME } from '../../../src/server/services/sessions';

const PRODUCTION = { databases: ['prod-db'], namespaces: ['prod-kv'] };

const args = [
	'--email',
	'Admin@Example.test',
	'--out',
	'/tmp/session',
	'--step-up',
	'--apply',
	'--account',
	'acct',
	'--database',
	'stage-db',
	'--kv',
	'stage-kv'
];

// a map-backed stand-in for the KV REST API and the D1 query route
function cloudflare(found: { user?: boolean } = {}) {
	const { user = true } = found;
	const store = new Map<string, { value: string; ttl: string | null }>();
	const calls: string[] = [];
	const fetchFn = (async (input: string, init: RequestInit = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? 'GET';
		calls.push(`${method} ${url.pathname}${url.search}`);
		if (url.pathname.includes('/d1/')) {
			const results = user ? [{ id: 'usr_1' }] : [];
			return new Response(JSON.stringify({ success: true, result: [{ results }] }));
		}
		const keyAt = url.pathname.indexOf('/values/');
		if (url.pathname.endsWith('/keys')) {
			const prefix = url.searchParams.get('prefix') ?? '';
			const result = [...store.keys()]
				.filter((k) => k.startsWith(prefix))
				.map((name) => ({ name }));
			return new Response(JSON.stringify({ result }));
		}
		const key = decodeURIComponent(url.pathname.slice(keyAt + '/values/'.length));
		if (method === 'PUT') {
			store.set(key, {
				value: String(init.body),
				ttl: url.searchParams.get('expiration_ttl')
			});
			return new Response('{}');
		}
		if (method === 'DELETE') {
			store.delete(key);
			return new Response('{}');
		}
		const hit = store.get(key);
		return hit ? new Response(hit.value) : new Response('', { status: 404 });
	}) as unknown as typeof fetch;
	return { store, calls, fetchFn };
}

const files = () => {
	const written: { path: string; data: string }[] = [];
	return {
		written,
		io: {
			write: (path: string, data: string) => void written.push({ path, data }),
			read: (path: string) => written.find((file) => file.path === path)?.data ?? ''
		}
	};
};

describe('planHours', () => {
	it('defaults to one and caps at two', () => {
		expect(planHours(undefined)).toBe(1);
		expect(planHours('2')).toBe(2);
		expect(() => planHours('3')).toThrow('at most 2');
		expect(() => planHours('0')).toThrow('--hours');
		expect(() => planHours('x')).toThrow('--hours');
	});
});

describe('refuseProduction', () => {
	it('names the production database and every production namespace', () => {
		expect(() => refuseProduction({ database: 'prod-db' }, PRODUCTION)).toThrow(
			'production database'
		);
		expect(() => refuseProduction({ kv: 'prod-kv' }, PRODUCTION)).toThrow(
			'production namespace'
		);
		expect(() =>
			refuseProduction({ database: 'stage-db', kv: 'stage-kv' }, PRODUCTION)
		).not.toThrow();
	});

	it('reads the ids from the production deploy file', () => {
		const ids = productionIds(() =>
			JSON.stringify({
				d1_databases: [{ binding: 'DB', database_id: 'd' }],
				kv_namespaces: [
					{ binding: 'KV', id: 'k1' },
					{ binding: 'CACHE', id: 'k2' }
				]
			})
		);
		expect(ids).toEqual({ databases: ['d'], namespaces: ['k1', 'k2'] });
		expect(productionIds().databases.length).toBeGreaterThan(0);
	});
});

describe('mint-session', () => {
	it('validates and touches nothing without --apply', async () => {
		const { calls, fetchFn } = cloudflare();
		const result = await run(
			['--email', 'a@example.test', '--out', '/tmp/s', '--step-up'],
			{},
			fetchFn,
			Date.now,
			files().io,
			PRODUCTION
		);
		expect(result.code).toBe(0);
		expect(result.out).toContain('not applied');
		expect(result.out).toContain('step-up now');
		expect(calls).toHaveLength(0);
	});

	it('refuses the production database or namespace even without --apply', async () => {
		for (const [flag, id, word] of [
			['--database', 'prod-db', 'production database'],
			['--kv', 'prod-kv', 'production namespace']
		] as const) {
			const { calls, fetchFn } = cloudflare();
			const result = await run(
				[...args, flag, id],
				{ CF_API_TOKEN: 't' },
				fetchFn,
				Date.now,
				files().io,
				PRODUCTION
			);
			expect(result.code).toBe(1);
			expect(result.out).toContain(word);
			expect(calls).toHaveLength(0);
		}
	});

	it('writes a live session with the step-up, a short expiry and a token file the printout never shows', async () => {
		const { store, fetchFn } = cloudflare();
		const { written, io } = files();
		const result = await run(args, { CF_API_TOKEN: 't' }, fetchFn, () => 1_000, io, PRODUCTION);
		expect(result.code).toBe(0);
		expect(written).toHaveLength(1);
		const token = written[0]!.data.trim();
		expect(written[0]!.path).toBe('/tmp/session');
		expect(result.out).not.toContain(token);
		expect(result.out).not.toContain('admin@example.test');
		expect([...store.values()].every((entry) => entry.ttl === '3600')).toBe(true);
		const kv = restKv('acct', 'stage-kv', 't', fetchFn);
		const session = await getSession(kv, token);
		expect(session?.userId).toBe('usr_1');
		expect(session?.stepUpAt).toBe(1_000);
		expect(SESSION_COOKIE_NAME).toBe('__Host-drupflare_session');
	});

	it('leaves the step-up off unless asked', async () => {
		const { fetchFn } = cloudflare();
		const { written, io } = files();
		const plain = args.filter((arg) => arg !== '--step-up');
		await run(plain, { CF_API_TOKEN: 't' }, fetchFn, () => 1_000, io, PRODUCTION);
		const session = await getSession(
			restKv('acct', 'stage-kv', 't', fetchFn),
			written[0]!.data.trim()
		);
		expect(session?.stepUpAt).toBeUndefined();
	});

	it('refuses an unknown address, a missing token and missing ids', async () => {
		const unknown = await run(
			args,
			{ CF_API_TOKEN: 't' },
			cloudflare({ user: false }).fetchFn,
			Date.now,
			files().io,
			PRODUCTION
		);
		expect(unknown.code).toBe(1);
		expect(unknown.out).toContain('no user has that address');
		const noToken = await run(args, {}, cloudflare().fetchFn, Date.now, files().io, PRODUCTION);
		expect(noToken.out).toContain('CF_API_TOKEN');
		const noIds = await run(
			['--email', 'a@example.test', '--out', '/tmp/s', '--apply'],
			{ CF_API_TOKEN: 't' },
			cloudflare().fetchFn,
			Date.now,
			files().io,
			PRODUCTION
		);
		expect(noIds.out).toContain('--apply needs');
	});

	it('revokes a session by its token file and deletes both KV keys', async () => {
		const { store, fetchFn } = cloudflare();
		const { io } = files();
		await run(args, { CF_API_TOKEN: 't' }, fetchFn, Date.now, io, PRODUCTION);
		expect(store.size).toBe(2);
		const revoke = [
			'--revoke',
			'/tmp/session',
			'--apply',
			'--account',
			'acct',
			'--kv',
			'stage-kv'
		];
		expect(
			(await run(revoke, { CF_API_TOKEN: 't' }, fetchFn, Date.now, io, PRODUCTION)).code
		).toBe(0);
		expect(store.size).toBe(0);
		const again = await run(revoke, { CF_API_TOKEN: 't' }, fetchFn, Date.now, io, PRODUCTION);
		expect(again.code).toBe(1);
		expect(again.out).toContain('no live session');
	});
});
