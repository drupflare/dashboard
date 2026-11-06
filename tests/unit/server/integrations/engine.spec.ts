import { describe, expect, it } from 'vitest';
import {
	START_REFUSALS,
	START_REFUSAL_STATUS,
	signStart,
	verifyStart
} from '../../../../contracts/src/engine-start';
import { handleStart, type WorkflowStarter } from '../../../../engine/src/start';
import {
	EngineStartError,
	engineConfigOf,
	engineStarter,
	type EngineBinding,
	type EngineStartErrorCode
} from '../../../../src/server/integrations/engine';
import { ApiError } from '../../../../src/shared/errors';

const SECRET = 's'.repeat(40);
const NOW = 1_790_000_000_000;
const request = {
	workflow: 'site-create' as const,
	id: 'op_abcdefgh12345678',
	params: { operationId: 'op_abcdefgh12345678' }
};

function answering(status: number, body: unknown): EngineBinding {
	return { fetch: async () => Response.json(body, { status }) };
}

const caught = (run: Promise<unknown>) =>
	run.then(
		() => null,
		(error: unknown) => error
	);

describe('engineStarter', () => {
	it('posts a start the engine verifies, with the operation id as the request id', async () => {
		const seen: { headers: Headers; body: string; url: string; method: string }[] = [];
		const binding: EngineBinding = {
			async fetch(input, init) {
				const call = new Request(input as string, init);
				seen.push({
					headers: call.headers,
					body: await call.clone().text(),
					url: call.url,
					method: call.method
				});
				return Response.json({ ok: true }, { status: 202 });
			}
		};
		await engineStarter({ binding, secret: SECRET, now: () => NOW })(request);
		const [call] = seen;
		expect(call).toMatchObject({ method: 'POST', url: 'https://engine/start' });
		const verdict = await verifyStart(call!.headers, call!.body, { secret: SECRET, now: NOW });
		expect(verdict).toEqual({
			ok: true,
			value: { workflow: 'site-create', id: request.id, params: request.params }
		});
		// the same bytes under another secret are refused
		const other = await verifyStart(call!.headers, call!.body, {
			secret: 'x'.repeat(40),
			now: NOW
		});
		expect(other).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('does not wait for the workflow: the engine answers 202 and the call returns', async () => {
		const done = engineStarter({
			binding: answering(202, { ok: true }),
			secret: SECRET,
			now: () => NOW
		});
		await expect(done(request)).resolves.toBeUndefined();
	});

	it('treats a replayed start as already started', async () => {
		const done = engineStarter({
			binding: answering(409, { ok: false, code: 'replayed' }),
			secret: SECRET,
			now: () => NOW
		});
		await expect(done(request)).resolves.toBeUndefined();
	});

	it('answers 501 not_built when the binding or the secret is unset', async () => {
		for (const config of [
			{ binding: undefined, secret: SECRET },
			{ binding: answering(202, {}), secret: undefined },
			{ binding: answering(202, {}), secret: 'short' }
		]) {
			const error = await caught(engineStarter({ ...config, now: () => NOW })(request));
			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ code: 'not_built', status: 501 });
		}
	});

	it.each(START_REFUSALS.filter((code) => code !== 'replayed'))(
		'maps the engine refusal %s to a typed error',
		async (code) => {
			const error = await caught(
				engineStarter({
					binding: answering(START_REFUSAL_STATUS[code], { ok: false, code }),
					secret: SECRET,
					now: () => NOW
				})(request)
			);
			expect(error).toBeInstanceOf(EngineStartError);
			expect((error as EngineStartError).code).toBe(code);
		}
	);

	it('maps an unreadable answer by status, and a network failure to unavailable', async () => {
		const codes: EngineStartErrorCode[] = [];
		for (const binding of [
			answering(503, { nope: true }),
			answering(400, { nope: true }),
			{
				fetch: async () => {
					throw new Error('connection refused');
				}
			}
		] satisfies EngineBinding[]) {
			const error = await caught(
				engineStarter({ binding, secret: SECRET, now: () => NOW })(request)
			);
			codes.push((error as EngineStartError).code);
		}
		expect(codes).toEqual(['unavailable', 'rejected', 'unavailable']);
	});

	it('refuses an id that is not a start id, and a body over the size limit, before it sends', async () => {
		let sent = 0;
		const binding: EngineBinding = {
			fetch: async () => {
				sent++;
				return Response.json({}, { status: 202 });
			}
		};
		const start = engineStarter({ binding, secret: SECRET, now: () => NOW });
		expect(await caught(start({ ...request, id: 'short' }))).toMatchObject({
			code: 'invalid_id'
		});
		expect(
			await caught(start({ ...request, params: { blob: 'x'.repeat(300_000) } }))
		).toMatchObject({ code: 'too_large' });
		expect(sent).toBe(0);
	});
});

describe('engineStarter against the engine handler', () => {
	function engineOver(
		workflows: Record<string, WorkflowStarter>,
		secret = SECRET
	): EngineBinding {
		return {
			fetch: (input, init) =>
				handleStart(new Request(input as string, init), {
					secret,
					now: NOW,
					workflows: workflows as never
				})
		};
	}

	const starter = (instances: Set<string>): WorkflowStarter =>
		({
			create: async ({ id }: { id: string }) => {
				if (instances.has(id)) throw new Error('already exists');
				instances.add(id);
			},
			get: async (id: string) => {
				if (!instances.has(id)) throw new Error('not found');
				return {};
			}
		}) as never;

	it('starts once and treats the second start of the same id as accepted', async () => {
		const instances = new Set<string>();
		const refusing = starter(new Set());
		const binding = engineOver({
			'site-create': starter(instances),
			'site-delete': refusing,
			'site-purge': refusing,
			'backup-create': refusing,
			'backup-restore': refusing
		});
		const start = engineStarter({ binding, secret: SECRET, now: () => NOW });
		await start(request);
		await start(request);
		expect([...instances]).toEqual([request.id]);
	});

	it('is refused by an engine that holds another secret', async () => {
		const binding = engineOver({}, 'z'.repeat(40));
		const error = await caught(
			engineStarter({ binding, secret: SECRET, now: () => NOW })(request)
		);
		expect(error).toMatchObject({ code: 'bad_signature' });
	});

	it('is refused when the signed time is outside the window', async () => {
		const binding = engineOver({});
		const error = await caught(
			engineStarter({ binding, secret: SECRET, now: () => NOW - 3_600_000 })(request)
		);
		expect(error).toMatchObject({ code: 'stale' });
	});
});

describe('engineConfigOf', () => {
	it('takes the binding when it can fetch and the secret when it is a non-empty string', () => {
		const binding = answering(202, {});
		expect(engineConfigOf({ ENGINE: binding, START_SECRET: SECRET })).toEqual({
			binding,
			secret: SECRET
		});
		expect(engineConfigOf({ ENGINE: {}, START_SECRET: '' })).toEqual({
			binding: undefined,
			secret: undefined
		});
		expect(engineConfigOf({})).toEqual({ binding: undefined, secret: undefined });
	});

	it('signs under the shared protocol', async () => {
		const headers = await signStart('{}', { secret: SECRET, now: NOW, id: request.id });
		expect(Object.keys(headers).sort()).toEqual([
			'x-drupflare-id',
			'x-drupflare-signature',
			'x-drupflare-timestamp'
		]);
	});
});
