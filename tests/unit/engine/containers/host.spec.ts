import { describe, expect, it } from 'vitest';
import worker, { tokenMatches, type Env } from '../../../../scripts/spikes/containers/src/index';

const TOKEN = 'spike-token-value';

interface Forwarded {
	name: string;
	url: string;
	method: string | undefined;
	inputBytes: string | null;
	body: string;
}

function envWith(token: string | null = TOKEN) {
	const forwarded: Forwarded[] = [];
	const env: Env = {
		SPIKE_TOKEN: token ?? undefined,
		JOB_RUNNER: {
			getByName: (name) => ({
				fetch: async (url, init) => {
					forwarded.push({
						name,
						url,
						method: init?.method,
						inputBytes: new Headers(init?.headers).get('x-input-bytes'),
						body: init?.body ? await new Response(init.body as BodyInit).text() : ''
					});
					return new Response('{"from":"runner"}');
				}
			})
		}
	};
	return { env, forwarded };
}

const call = (
	env: Env,
	path: string,
	init: RequestInit & { token?: string | null } = {}
): Promise<Response> => {
	const { token = TOKEN, ...rest } = init;
	return worker.fetch(
		new Request(`https://spike.example${path}`, {
			method: 'POST',
			...rest,
			headers: {
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
				...rest.headers
			}
		}),
		env
	);
};

describe('tokenMatches', () => {
	it('accepts the exact token', async () => {
		expect(await tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
	});

	it.each([
		['a different token', 'Bearer other'],
		['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
		['the token with a suffix', `Bearer ${TOKEN}x`],
		['another scheme', `Basic ${TOKEN}`],
		['a bare token', TOKEN],
		['an empty header', ''],
		['no header', null]
	])('refuses %s', async (_name, header) => {
		expect(await tokenMatches(header, TOKEN)).toBe(false);
	});
});

describe('host worker', () => {
	it('refuses every request when no token is configured', async () => {
		const { env } = envWith(null);
		expect((await call(env, '/run?kind=echo-import')).status).toBe(500);
		expect((await call(envWith('').env, '/run?kind=echo-import')).status).toBe(500);
	});

	it('answers 401 without a valid bearer token and forwards nothing', async () => {
		const { env, forwarded } = envWith();
		const missing = await call(env, '/run?kind=echo-import', { token: null });
		expect(missing.status).toBe(401);
		expect(missing.headers.get('www-authenticate')).toBe('Bearer');
		expect((await call(env, '/run?kind=echo-import', { token: 'wrong' })).status).toBe(401);
		expect((await call(env, '/destroy', { token: 'wrong' })).status).toBe(401);
		expect(forwarded).toHaveLength(0);
	});

	it('checks the token before the method and the path', async () => {
		const { env } = envWith();
		expect((await call(env, '/nope', { token: null })).status).toBe(401);
		expect((await call(env, '/run', { method: 'GET', token: null })).status).toBe(401);
	});

	it('answers 405 for a wrong method and 404 for another path', async () => {
		const { env, forwarded } = envWith();
		expect((await call(env, '/run', { method: 'GET' })).status).toBe(405);
		expect((await call(env, '/other')).status).toBe(404);
		expect(forwarded).toHaveLength(0);
	});

	it('forwards a run with the kind, the key, the declared size and the body', async () => {
		const { env, forwarded } = envWith();
		const response = await call(env, '/run?kind=echo-import&key=spike/a/out', {
			body: 'hello',
			headers: { 'content-length': '5' }
		});
		expect(await response.text()).toBe('{"from":"runner"}');
		expect(forwarded).toEqual([
			{
				name: 'spike',
				url: 'http://runner/run?kind=echo-import&key=spike%2Fa%2Fout',
				method: 'POST',
				inputBytes: '5',
				body: 'hello'
			}
		]);
	});

	it('names a key when the caller gives none and picks the runner by name', async () => {
		const { env, forwarded } = envWith();
		await call(env, '/run?kind=composer-tree&name=one');
		await call(env, '/run?kind=composer-tree&name=one');
		expect(forwarded[0]!.name).toBe('one');
		const keys = forwarded.map((f) => new URL(f.url).searchParams.get('key'));
		expect(keys[0]).toMatch(/^spike\/composer-tree\/[0-9a-f-]{36}$/);
		expect(keys[0]).not.toBe(keys[1]);
		expect(forwarded[0]!.inputBytes).toBeNull();
	});

	it('passes a missing kind on for the runner to refuse', async () => {
		const { env, forwarded } = envWith();
		await call(env, '/run');
		expect(new URL(forwarded[0]!.url).searchParams.get('kind')).toBe('');
	});

	it('forwards a destroy to the named runner', async () => {
		const { env, forwarded } = envWith();
		const response = await call(env, '/destroy?name=two');
		expect(await response.text()).toBe('{"from":"runner"}');
		expect(forwarded).toMatchObject([
			{ name: 'two', url: 'http://runner/destroy', method: 'POST' }
		]);
	});
});
