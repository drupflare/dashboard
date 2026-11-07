import { describe, expect, it } from 'vitest';
import {
	handleStart,
	MAX_START_BYTES,
	secretUsable,
	signStart,
	START_HEADERS,
	START_REFUSALS,
	START_WINDOW_MS,
	verifyStart,
	WORKFLOW_NAMES,
	type StartRefusal,
	type WorkflowName,
	type WorkflowStarter
} from '../../../engine/src/start';

const SECRET = 's3cret-'.repeat(6);
const NOW = 1_790_000_000_000;
const ID = 'op_start_0000000001';
const BODY = JSON.stringify({ workflow: 'site-create', params: { operationId: 'op_x', n: 1 } });

function starters() {
	const created: Record<WorkflowName, Map<string, unknown>> = {
		'site-create': new Map(),
		'site-upgrade': new Map(),
		'site-delete': new Map(),
		'site-purge': new Map(),
		'backup-create': new Map(),
		'backup-restore': new Map()
	};
	const failWith: { error: Error | null } = { error: null };
	const workflows = Object.fromEntries(
		WORKFLOW_NAMES.map((name): [WorkflowName, WorkflowStarter] => [
			name,
			{
				async create(options) {
					const id = options?.id ?? '';
					if (failWith.error !== null) throw failWith.error;
					if (created[name].has(id)) throw new Error('instance.already_exists');
					created[name].set(id, options?.params);
					return {} as never;
				},
				async get(id) {
					if (!created[name].has(id)) throw new Error('instance.not_found');
					return {} as never;
				}
			}
		])
	) as Record<WorkflowName, WorkflowStarter>;
	return { created, workflows, failWith };
}

async function request(
	body: string,
	options: {
		secret?: string;
		now?: number;
		id?: string;
		method?: string;
		path?: string;
		headers?: Record<string, string | null>;
	} = {}
) {
	const signed = await signStart(body, {
		secret: options.secret ?? SECRET,
		now: options.now ?? NOW,
		id: options.id ?? ID
	});
	const headers = new Headers(signed);
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	const method = options.method ?? 'POST';
	return new Request(`https://engine.example${options.path ?? '/start'}`, {
		method,
		headers,
		body: method === 'GET' ? undefined : body
	});
}

const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

describe('verifyStart', () => {
	it('accepts a signed request and returns the workflow, the id and the params', async () => {
		const headers = (await request(BODY)).headers;
		expect(await verifyStart(headers, BODY, { secret: SECRET, now: NOW })).toEqual({
			ok: true,
			value: { workflow: 'site-create', id: ID, params: { operationId: 'op_x', n: 1 } }
		});
	});

	it('refuses a request without any one of the three headers', async () => {
		for (const name of Object.values(START_HEADERS)) {
			const headers = (await request(BODY, { headers: { [name]: null } })).headers;
			expect(await verifyStart(headers, BODY, { secret: SECRET, now: NOW })).toEqual({
				ok: false,
				code: 'unsigned'
			});
		}
	});

	it('refuses a wrong secret, an altered body, and a swapped time or id', async () => {
		const verdict = async (
			body: string,
			signedWith: Parameters<typeof request>[1],
			headers: Record<string, string | null> = {}
		) =>
			verifyStart((await request(body, { ...signedWith, headers })).headers, body, {
				secret: SECRET,
				now: NOW
			});
		expect(await verdict(BODY, { secret: 'another-secret-'.repeat(3) })).toMatchObject({
			code: 'bad_signature'
		});
		expect(
			await verifyStart((await request(BODY)).headers, BODY.replace('op_x', 'op_y'), {
				secret: SECRET,
				now: NOW
			})
		).toMatchObject({ code: 'bad_signature' });
		expect(
			await verdict(BODY, {}, { [START_HEADERS.timestamp]: String(NOW + 1) })
		).toMatchObject({
			code: 'bad_signature'
		});
		expect(
			await verdict(BODY, {}, { [START_HEADERS.id]: 'op_start_0000000002' })
		).toMatchObject({
			code: 'bad_signature'
		});
	});

	it('accepts a time inside the window and refuses one outside it, in both directions', async () => {
		const at = async (stamp: number) =>
			verifyStart((await request(BODY, { now: stamp })).headers, BODY, {
				secret: SECRET,
				now: NOW
			});
		expect((await at(NOW - START_WINDOW_MS)).ok).toBe(true);
		expect((await at(NOW + START_WINDOW_MS)).ok).toBe(true);
		expect(await at(NOW - START_WINDOW_MS - 1)).toEqual({ ok: false, code: 'stale' });
		expect(await at(NOW + START_WINDOW_MS + 1)).toEqual({ ok: false, code: 'stale' });
	});

	it('refuses a body that is signed but is not a start', async () => {
		const verdict = async (body: string, headers: Record<string, string | null> = {}) =>
			verifyStart((await request(body, { headers })).headers, body, {
				secret: SECRET,
				now: NOW
			});
		expect(await verdict('not json')).toEqual({ ok: false, code: 'malformed' });
		expect(await verdict('[]')).toEqual({ ok: false, code: 'malformed' });
		expect(await verdict(JSON.stringify({ workflow: 'site-create' }))).toEqual({
			ok: false,
			code: 'malformed'
		});
		expect(
			await verdict(JSON.stringify({ workflow: 'site-create', params: {}, extra: 1 }))
		).toEqual({ ok: false, code: 'malformed' });
		expect(await verdict(JSON.stringify({ workflow: 'site-explode', params: {} }))).toEqual({
			ok: false,
			code: 'unknown_workflow'
		});
		expect(await verdict(BODY, { [START_HEADERS.signature]: 'ZZ' })).toEqual({
			ok: false,
			code: 'malformed'
		});
		expect(await verdict(BODY, { [START_HEADERS.id]: 'short' })).toEqual({
			ok: false,
			code: 'malformed'
		});
		expect(await verdict(BODY, { [START_HEADERS.timestamp]: 'yesterday' })).toEqual({
			ok: false,
			code: 'malformed'
		});
	});

	it('does not sign with a secret that is unset or short', async () => {
		for (const secret of [undefined, '', 'short']) {
			await expect(
				signStart(BODY, { secret: secret as never, now: NOW, id: ID })
			).rejects.toThrow('32 characters');
		}
		expect([undefined, null, 7, '', 'a'.repeat(31)].some(secretUsable)).toBe(false);
		expect(secretUsable('a'.repeat(32))).toBe(true);
	});
});

describe('handleStart', () => {
	const handle = (req: Request, secret: string | null = SECRET, workflows = starters()) =>
		handleStart(req, { secret: secret as string, now: NOW, workflows: workflows.workflows });

	it('starts the workflow the body names, with its params, under the request id', async () => {
		for (const name of WORKFLOW_NAMES) {
			const world = starters();
			const body = JSON.stringify({ workflow: name, params: { operationId: `op_${name}` } });
			const response = await handle(await request(body), SECRET, world);
			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ ok: true, workflow: name, id: ID });
			for (const other of WORKFLOW_NAMES) {
				expect([...world.created[other]]).toEqual(
					other === name ? [[ID, { operationId: `op_${name}` }]] : []
				);
			}
		}
	});

	it('answers an unsigned request with 401 whatever the path or method', async () => {
		const world = starters();
		for (const [method, path] of [
			['POST', '/start'],
			['GET', '/'],
			['POST', '/other'],
			['DELETE', '/start']
		]) {
			const response = await handle(
				new Request(`https://engine.example${path}`, {
					method,
					body: method === 'POST' ? BODY : undefined
				}),
				SECRET,
				world
			);
			expect(response.status).toBe(401);
			expect(await codeOf(response)).toBe('unsigned');
		}
		expect(world.created['site-create'].size).toBe(0);
	});

	it('refuses a wrong signature and a stale time with 401 and starts nothing', async () => {
		const world = starters();
		const wrong = await handle(
			await request(BODY, { secret: 'another-secret-'.repeat(3) }),
			SECRET,
			world
		);
		expect([wrong.status, await codeOf(wrong)]).toEqual([401, 'bad_signature']);
		const stale = await handle(
			await request(BODY, { now: NOW - START_WINDOW_MS - 1 }),
			SECRET,
			world
		);
		expect([stale.status, await codeOf(stale)]).toEqual([401, 'stale']);
		expect(world.created['site-create'].size).toBe(0);
	});

	it('refuses a reused id with 409 and does not start a second run', async () => {
		const world = starters();
		const first = await handle(await request(BODY), SECRET, world);
		expect(first.status).toBe(202);
		const again = await handle(await request(BODY), SECRET, world);
		expect([again.status, await codeOf(again)]).toEqual([409, 'replayed']);
		const fresh = await handle(
			await request(BODY, { id: 'op_start_0000000002' }),
			SECRET,
			world
		);
		expect(fresh.status).toBe(202);
		expect(world.created['site-create'].size).toBe(2);
	});

	it('lets a failure that is not a reused id reach the platform as an error', async () => {
		const world = starters();
		world.failWith.error = new Error('workflow binding is down');
		await expect(handle(await request(BODY), SECRET, world)).rejects.toThrow('binding is down');
	});

	it('refuses a body over the cap, by its length header and by its bytes', async () => {
		const big = JSON.stringify({
			workflow: 'site-create',
			params: { pad: 'x'.repeat(MAX_START_BYTES) }
		});
		const response = await handle(await request(big));
		expect([response.status, await codeOf(response)]).toEqual([413, 'too_large']);
		const declared = await handle(
			await request(BODY, { headers: { 'content-length': String(MAX_START_BYTES + 1) } })
		);
		expect([declared.status, await codeOf(declared)]).toEqual([413, 'too_large']);
	});

	it('answers a signed request to another path with 404, another method with 405, no body with 400', async () => {
		const path = await handle(await request(BODY, { path: '/other' }));
		expect([path.status, await codeOf(path)]).toEqual([404, 'unknown_path']);
		const method = await handle(await request('', { method: 'GET' }));
		expect([method.status, await codeOf(method)]).toEqual([400, 'malformed']);
		const put = await handle(await request(BODY, { method: 'PUT' }));
		expect([put.status, await codeOf(put)]).toEqual([405, 'wrong_method']);
	});

	it('answers 500 when the secret is not usable, after it has refused the unsigned', async () => {
		for (const secret of [null, 'short']) {
			const signed = await handle(await request(BODY), secret);
			expect([signed.status, await codeOf(signed)]).toEqual([500, 'unconfigured']);
			const unsigned = await handle(
				new Request('https://engine.example/start', { method: 'POST', body: BODY }),
				secret
			);
			expect(unsigned.status).toBe(401);
		}
	});

	it('trips every refusal it can name', async () => {
		const seen = new Set<StartRefusal>();
		const world = starters();
		const note = async (response: Response) =>
			void seen.add((await codeOf(response)) as StartRefusal);
		await note(await handle(new Request('https://engine.example/start', { method: 'POST' })));
		await note(await handle(await request('{', { path: '/start' })));
		await note(await handle(await request(BODY, { now: 1 })));
		await note(await handle(await request(BODY, { secret: 'x'.repeat(40) })));
		await note(await handle(await request('x'.repeat(MAX_START_BYTES + 1))));
		await note(await handle(await request(BODY, { method: 'PUT' })));
		await note(await handle(await request(BODY, { path: '/nope' })));
		await note(await handle(await request(JSON.stringify({ workflow: 'nope', params: {} }))));
		await handle(await request(BODY), SECRET, world);
		await note(await handle(await request(BODY), SECRET, world));
		await note(await handle(await request(BODY), 'short'));
		expect([...seen].sort()).toEqual([...START_REFUSALS].sort());
	});
});
