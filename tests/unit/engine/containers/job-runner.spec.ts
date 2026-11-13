import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	JobRunner,
	NotReady,
	runJob,
	waitReady,
	type JobContainer,
	type RunDeps
} from '../../../../engine/src/containers/job-runner';
import {
	EXIT_HEADER,
	JOB_MESSAGES,
	JOBS,
	LOG_TAIL_BYTES,
	READY_ATTEMPTS,
	READY_DELAY_MS,
	startOptions,
	type JobKind,
	type JobRequest,
	type RunRecord,
	type StartOptions
} from '../../../../engine/src/containers/jobs';

vi.mock('cloudflare:workers', () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown
		) {}
	}
}));

const IMAGE = 'image-ref';
const NOW = 1_790_000_000_000;

interface Posted {
	url: string;
	bytes: Uint8Array;
}

type Answer = (posted: Posted, container: FakeContainer) => Promise<Response> | Response;

class FakeContainer implements JobContainer {
	running = false;
	images = { runner: IMAGE };
	started: StartOptions[] = [];
	destroyReasons: unknown[] = [];
	timeouts: number[] = [];
	healthChecks = 0;
	posted: Posted[] = [];
	startThrows: Error | null = null;
	destroyThrows = false;
	healthyAfter = 1;
	answer: Answer = () => reply(0, 'out');
	private settle: { resolve(): void; reject(reason: unknown): void } | null = null;

	start(options: StartOptions): void {
		if (this.startThrows) throw this.startThrows;
		this.started.push(options);
		this.running = true;
	}

	monitor(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.settle = { resolve, reject };
		});
	}

	crash(reason: unknown): void {
		this.running = false;
		this.settle?.reject(reason);
	}

	async destroy(reason?: unknown): Promise<void> {
		this.destroyReasons.push(reason);
		if (this.destroyThrows) throw new Error('destroy failed');
		this.running = false;
		if (reason === undefined) this.settle?.resolve();
		else this.settle?.reject(reason);
	}

	async setInactivityTimeout(ms: number): Promise<void> {
		this.timeouts.push(ms);
	}

	getTcpPort() {
		return {
			fetch: async (url: string, init?: RequestInit): Promise<Response> => {
				if (url.endsWith('/health')) {
					this.healthChecks++;
					if (this.healthChecks < this.healthyAfter) throw new Error('refused');
					return new Response('ok');
				}
				const bytes = new Uint8Array(
					await new Response(init?.body as BodyInit).arrayBuffer()
				);
				const posted = { url, bytes };
				this.posted.push(posted);
				return this.answer(posted, this);
			}
		};
	}
}

function reply(exit: number | string, body = '', status = 200): Response {
	return new Response(body, {
		status,
		headers: { [EXIT_HEADER]: String(exit), 'content-length': String(new Blob([body]).size) }
	});
}

class Blobs {
	objects = new Map<string, string>();
	failWith: Error | null = null;
	async put(key: string, value: ReadableStream<Uint8Array> | string) {
		if (this.failWith) throw this.failWith;
		this.objects.set(key, typeof value === 'string' ? value : await new Response(value).text());
	}
}

function harness(overrides: Partial<RunDeps> = {}) {
	const container = new FakeContainer();
	const blobs = new Blobs();
	let clock = NOW;
	const sleeps: number[] = [];
	const alarms: number[] = [];
	let disarmed = 0;
	let why: 'timeout' | 'destroyed' | null = null;
	const deps: RunDeps = {
		container,
		image: IMAGE,
		blob: blobs,
		now: () => (clock += 10),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		arm: async (ms) => {
			alarms.push(ms);
		},
		disarm: async () => {
			disarmed++;
		},
		interrupted: () => why,
		...overrides
	};
	return {
		container,
		blobs,
		deps,
		sleeps,
		alarms,
		disarmed: () => disarmed,
		interrupt: (value: 'timeout' | 'destroyed') => {
			why = value;
		}
	};
}

const input = (text: string) => new Blob([text]).stream();

function job(kind: JobKind = 'echo-import', inputBytes = 5): JobRequest {
	return { kind, key: `runs/${kind}/result`, inputBytes };
}

describe('waitReady', () => {
	it('returns on the attempt that answers and sleeps only between attempts', async () => {
		const { container, sleeps } = harness();
		container.healthyAfter = 4;
		await waitReady(
			container,
			async (ms) => void sleeps.push(ms),
			() => false
		);
		expect(container.healthChecks).toBe(4);
		expect(sleeps).toEqual([READY_DELAY_MS, READY_DELAY_MS, READY_DELAY_MS]);
	});

	it('answers on the first attempt without sleeping', async () => {
		const { container, sleeps } = harness();
		await waitReady(
			container,
			async (ms) => void sleeps.push(ms),
			() => false
		);
		expect(container.healthChecks).toBe(1);
		expect(sleeps).toEqual([]);
	});

	it('fails after the attempt limit and keeps the last error', async () => {
		const { container } = harness();
		container.healthyAfter = Number.POSITIVE_INFINITY;
		const error = await waitReady(
			container,
			async () => {},
			() => false
		).catch((e) => e);
		expect(error).toBeInstanceOf(NotReady);
		expect(container.healthChecks).toBe(READY_ATTEMPTS);
		expect((error as NotReady).cause).toBeInstanceOf(Error);
	});

	it('treats a non-ok health answer as not ready', async () => {
		const { container } = harness();
		const port = container.getTcpPort();
		container.getTcpPort = () => ({
			fetch: async (url: string) => (port.fetch(url), new Response('no', { status: 503 }))
		});
		const error = await waitReady(
			container,
			async () => {},
			() => false
		).catch((e) => e);
		expect((error as NotReady).cause).toBe('health check returned 503');
	});

	it('stops at once when the container has exited', async () => {
		const { container } = harness();
		container.healthyAfter = Number.POSITIVE_INFINITY;
		const error = await waitReady(
			container,
			async () => {},
			() => true
		).catch((e) => e);
		expect(error).toBeInstanceOf(NotReady);
		expect(container.healthChecks).toBe(0);
	});
});

describe('runJob', () => {
	let h: ReturnType<typeof harness>;
	let logged: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		h = harness();
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('runs a job, stores the artifact under the given key and returns the measured record', async () => {
		h.container.answer = () => reply(0, 'sha256-of-input');
		const record = await runJob(h.deps, job(), input('hello'));

		expect(h.blobs.objects.get('runs/echo-import/result')).toBe('sha256-of-input');
		expect(h.container.started).toEqual([startOptions('echo-import', IMAGE)]);
		expect(h.container.timeouts).toHaveLength(1);
		expect(h.alarms).toEqual([JOBS['echo-import'].wallMs]);
		expect(new TextDecoder().decode(h.container.posted[0]!.bytes)).toBe(
			'{"kind":"echo-import"}\nhello'
		);
		expect(record).toEqual({
			kind: 'echo-import',
			key: 'runs/echo-import/result',
			state: 'succeeded',
			message: JOB_MESSAGES.succeeded,
			exitCode: 0,
			instance: 'standard-3',
			enableInternet: false,
			startedAt: record.startedAt,
			readyAt: record.readyAt,
			doneAt: record.doneAt,
			coldStartMs: record.readyAt! - record.startedAt,
			wallMs: record.doneAt - record.startedAt,
			bytesIn: 5,
			bytesOut: 15,
			destroyed: true,
			logTail: null
		});
		expect(record.readyAt).toBeGreaterThan(record.startedAt);
		expect(record.doneAt).toBeGreaterThan(record.readyAt!);
		expect(h.container.destroyReasons).toEqual([undefined]);
		expect(h.container.running).toBe(false);
		expect(h.disarmed()).toBe(1);
	});

	it('starts composer-tree on standard-2 with the network open', async () => {
		const record = await runJob(h.deps, job('composer-tree'), input('tarball'));
		expect(h.container.started[0]).toMatchObject({
			instance: 'standard-2',
			enableInternet: true
		});
		expect(record).toMatchObject({ instance: 'standard-2', enableInternet: true });
	});

	it('starts echo-import with the network closed', async () => {
		await runJob(h.deps, job('echo-import'), input('x'));
		expect(h.container.started[0]!.enableInternet).toBe(false);
	});

	it('reports a non-zero exit as a job failure with the code and stores nothing', async () => {
		h.container.answer = () => reply(70);
		const record = await runJob(h.deps, job('drupal-hop'), null);
		expect(record).toMatchObject({
			state: 'job_failed',
			message: JOB_MESSAGES.job_failed,
			exitCode: 70,
			bytesOut: 0,
			bytesIn: 0,
			destroyed: true
		});
		expect(h.blobs.objects.size).toBe(0);
		expect(h.container.destroyReasons).toHaveLength(1);
	});

	it('puts the output a failed job sent into the record', async () => {
		h.container.answer = () => reply(1, '[composer-tree] could not resolve a package\n');
		const record = await runJob(h.deps, job('composer-tree'), input('x'));
		expect(record.state).toBe('job_failed');
		expect(record.logTail).toBe('[composer-tree] could not resolve a package');
	});

	it('keeps the output of a timed out job', async () => {
		h.container.answer = () => reply('timeout', '[composer-tree] still downloading');
		const record = await runJob(h.deps, job('composer-tree'), input('x'));
		expect(record).toMatchObject({
			state: 'timed_out',
			logTail: '[composer-tree] still downloading'
		});
	});

	it('reads at most 4096 bytes of a failed job output', async () => {
		h.container.answer = () => reply(1, 'z'.repeat(10_000));
		const record = await runJob(h.deps, job('composer-tree'), input('x'));
		expect(record.logTail).toBe('z'.repeat(LOG_TAIL_BYTES));
	});

	it('records no output for a failed job that sent none', async () => {
		h.container.answer = () => reply(1, '   \n');
		expect((await runJob(h.deps, job(), input('x'))).logTail).toBeNull();
	});

	it('records no output when the body cannot be read', async () => {
		h.container.answer = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error('reset'));
					}
				}),
				{ headers: { [EXIT_HEADER]: '1' } }
			);
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'job_failed', exitCode: 1, logTail: null });
	});

	it('keeps the refusal text of a transport error status', async () => {
		h.container.answer = () => reply('', 'The runner failed.', 500);
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'job_failed', logTail: 'The runner failed.' });
	});

	it('records no output for a successful job', async () => {
		h.container.answer = () => reply(0, 'artifact');
		expect((await runJob(h.deps, job(), input('x'))).logTail).toBeNull();
	});

	it('reports a timeout header as a timeout', async () => {
		h.container.answer = () => reply('timeout');
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'timed_out', exitCode: null, destroyed: true });
	});

	it('reports a killed header as killed', async () => {
		h.container.answer = () => reply('killed');
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'killed', exitCode: null, destroyed: true });
	});

	it('reports a transport error status as a job failure without an exit code', async () => {
		h.container.answer = () => reply(0, 'nope', 500);
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'job_failed', exitCode: null, bytesOut: 0 });
	});

	it('reports a missing exit header as a job failure', async () => {
		h.container.answer = () => new Response('data', { headers: { 'content-length': '4' } });
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'job_failed', exitCode: null });
		expect(h.blobs.objects.size).toBe(0);
	});

	it('refuses a result with no length or one over the output limit', async () => {
		h.container.answer = () => new Response('data', { headers: { [EXIT_HEADER]: '0' } });
		expect(await runJob(h.deps, job(), input('x'))).toMatchObject({
			state: 'job_failed',
			exitCode: null,
			bytesOut: 0
		});

		h.container.answer = () =>
			new Response('data', {
				headers: {
					[EXIT_HEADER]: '0',
					'content-length': String(JOBS['echo-import'].outputLimit + 1)
				}
			});
		expect(await runJob(h.deps, job(), input('x'))).toMatchObject({
			state: 'job_failed',
			bytesOut: 0
		});
		expect(h.blobs.objects.size).toBe(0);
	});

	it('reports a container that stops while the job runs as killed', async () => {
		h.container.answer = async (_posted, container) => {
			container.crash(Object.assign(new Error('exited'), { exitCode: 137 }));
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw new Error('connection lost');
		};
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'killed', exitCode: null, destroyed: true });
		expect(h.container.destroyReasons).toHaveLength(1);
	});

	it('reports a forced destroy as killed', async () => {
		h.container.answer = async () => {
			h.interrupt('destroyed');
			throw new Error('connection lost');
		};
		expect(await runJob(h.deps, job(), input('x'))).toMatchObject({ state: 'killed' });
	});

	it('reports a wall limit stop as a timeout', async () => {
		h.container.answer = async () => {
			h.interrupt('timeout');
			throw new Error('connection lost');
		};
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'timed_out', exitCode: null, destroyed: true });
		expect(h.container.destroyReasons).toHaveLength(1);
	});

	it('reports a start that throws as a start failure and still destroys', async () => {
		h.container.startThrows = new Error('no capacity');
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({
			state: 'start_failed',
			message: JOB_MESSAGES.start_failed,
			readyAt: null,
			coldStartMs: null,
			bytesIn: 0,
			bytesOut: 0,
			exitCode: null,
			destroyed: true
		});
		expect(h.container.destroyReasons).toHaveLength(1);
	});

	it('reports a container that never answers its health check as a start failure', async () => {
		h.container.healthyAfter = Number.POSITIVE_INFINITY;
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'start_failed', readyAt: null, destroyed: true });
		expect(h.container.healthChecks).toBe(READY_ATTEMPTS);
		expect(h.container.posted).toHaveLength(0);
		expect(h.sleeps).toHaveLength(READY_ATTEMPTS);
	});

	it('reports a container that exits before it is ready as a start failure', async () => {
		h.container.healthyAfter = Number.POSITIVE_INFINITY;
		const crash = h.container.start.bind(h.container);
		h.container.start = (options) => {
			crash(options);
			queueMicrotask(() => h.container.crash(new Error('image failed')));
		};
		const record = await runJob(h.deps, job(), input('x'));
		expect(record.state).toBe('start_failed');
		expect(h.container.healthChecks).toBeLessThan(READY_ATTEMPTS);
	});

	it('reports a thrown storage error as a job failure and still destroys', async () => {
		h.blobs.failWith = new Error('r2 down');
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({
			state: 'job_failed',
			exitCode: null,
			bytesOut: 0,
			destroyed: true
		});
		expect(h.container.destroyReasons).toHaveLength(1);
		expect(logged).toHaveBeenCalledWith(
			'job echo-import stopped while running',
			h.blobs.failWith
		);
	});

	it('destroys a stale instance before it starts a new one', async () => {
		h.container.running = true;
		await runJob(h.deps, job(), input('x'));
		expect(h.container.destroyReasons).toHaveLength(2);
		expect(h.container.started).toHaveLength(1);
	});

	it('reports destroyed false when destroy throws and the instance still runs', async () => {
		h.container.destroyThrows = true;
		const record = await runJob(h.deps, job(), input('x'));
		expect(record.state).toBe('succeeded');
		expect(record.destroyed).toBe(false);
		expect(h.disarmed()).toBe(0);
	});

	it('reports destroyed true when destroy throws on an instance that is already gone', async () => {
		h.container.destroyThrows = true;
		h.container.answer = (_posted, container) => {
			container.running = false;
			return reply(0, 'out');
		};
		const record = await runJob(h.deps, job(), input('x'));
		expect(record.destroyed).toBe(true);
	});

	it('survives a disarm that throws', async () => {
		h.deps.disarm = async () => {
			throw new Error('storage down');
		};
		const record = await runJob(h.deps, job(), input('x'));
		expect(record).toMatchObject({ state: 'succeeded', destroyed: true });
	});

	it('counts the bytes the container pulled when the job ends early', async () => {
		h.container.answer = () => reply(2);
		const record = await runJob(h.deps, job(), input('abcdef'));
		expect(record.bytesIn).toBeLessThanOrEqual(6);
		expect(record.state).toBe('job_failed');
	});
});

describe('JobRunner', () => {
	class FakeStorage {
		alarm: number | null = null;
		async setAlarm(at: number) {
			this.alarm = at;
		}
		async deleteAlarm() {
			this.alarm = null;
		}
	}

	let container: FakeContainer;
	let storage: FakeStorage;
	let blobs: Blobs;
	let runner: JobRunner;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		container = new FakeContainer();
		storage = new FakeStorage();
		blobs = new Blobs();
		runner = new (JobRunner as unknown as new (ctx: unknown, env: unknown) => JobRunner)(
			{ container, storage },
			{ BLOB: blobs }
		);
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
			queueMicrotask(fn);
			return 0;
		}) as never);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const run = (
		query: string,
		body: BodyInit | null = 'hello',
		headers: Record<string, string> = {}
	) =>
		runner.fetch(
			new Request(`http://runner/run?${query}`, {
				method: 'POST',
				headers: body === null ? headers : { 'x-input-bytes': '5', ...headers },
				body
			})
		);

	const recordOf = async (response: Response) => (await response.json()) as RunRecord;

	it('runs a job and answers with the record as json', async () => {
		const response = await run('kind=echo-import&key=runs/a/out');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await recordOf(response)).toMatchObject({
			state: 'succeeded',
			key: 'runs/a/out',
			bytesIn: 5,
			destroyed: true
		});
		expect(blobs.objects.get('runs/a/out')).toBe('out');
		expect(storage.alarm).toBeNull();
	});

	it('sets the wall alarm before the container starts', async () => {
		container.answer = async () => {
			expect(storage.alarm).toBe(NOW + JOBS['composer-tree'].wallMs);
			return reply(0, 'out');
		};
		const record = await recordOf(await run('kind=composer-tree&key=runs/b/out'));
		expect(record.state).toBe('succeeded');
		expect(storage.alarm).toBeNull();
	});

	it('answers a job that exits non-zero with a record, not an error status', async () => {
		container.answer = () => reply(70);
		const response = await run('kind=template-build&key=runs/c/out', null);
		expect(response.status).toBe(200);
		expect(await recordOf(response)).toMatchObject({ state: 'job_failed', exitCode: 70 });
	});

	it('turns the alarm into a timeout record and destroys the container', async () => {
		let release!: () => void;
		container.answer = (_posted, c) =>
			new Promise<Response>((_resolve, reject) => {
				release = () => reject(new Error(`connection lost ${c.running}`));
			});
		const pending = run('kind=composer-tree&key=runs/d/out');
		await vi.waitFor(() => expect(container.posted).toHaveLength(1));

		const alarm = runner.alarm();
		await alarm;
		expect(container.destroyReasons).toEqual(['wall limit']);
		release();

		expect(await recordOf(await pending)).toMatchObject({
			state: 'timed_out',
			exitCode: null,
			destroyed: true
		});
		expect(container.running).toBe(false);
	});

	it('destroys a running container on an alarm that finds no job', async () => {
		container.running = true;
		await runner.alarm();
		expect(container.destroyReasons).toEqual(['wall limit']);
	});

	it('does nothing on an alarm when no container is running', async () => {
		await runner.alarm();
		expect(container.destroyReasons).toEqual([]);
	});

	it('lets an alarm that cannot destroy fail so it retries', async () => {
		container.running = true;
		container.destroyThrows = true;
		await expect(runner.alarm()).rejects.toThrow('destroy failed');
	});

	it('forces a destroy and records the running job as killed', async () => {
		let release!: () => void;
		container.answer = () =>
			new Promise<Response>((_resolve, reject) => {
				release = () => reject(new Error('connection lost'));
			});
		const pending = run('kind=echo-import&key=runs/e/out');
		await vi.waitFor(() => expect(container.posted).toHaveLength(1));

		const response = await runner.fetch(
			new Request('http://runner/destroy', { method: 'POST' })
		);
		expect(await response.json()).toEqual({ destroyed: true });
		release();
		expect(await recordOf(await pending)).toMatchObject({ state: 'killed', destroyed: true });
	});

	it('reports a forced destroy with nothing running', async () => {
		const response = await runner.fetch(
			new Request('http://runner/destroy', { method: 'POST' })
		);
		expect(await response.json()).toEqual({ destroyed: false });
		expect(container.destroyReasons).toEqual(['forced']);
	});

	it('refuses an input over the limit before it starts a container', async () => {
		const response = await run('kind=echo-import&key=runs/f/out', 'x', {
			'x-input-bytes': String(JOBS['echo-import'].inputLimit + 1)
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			refused: 'input_too_large',
			message: 'The job input is larger than the limit for this job type.'
		});
		expect(container.started).toHaveLength(0);
		expect(container.destroyReasons).toHaveLength(0);
		expect(storage.alarm).toBeNull();
	});

	it.each([
		['kind=nope&key=a', 400, 'unknown_kind'],
		['kind=echo-import&key=../a', 400, 'bad_key'],
		['kind=echo-import', 400, 'bad_key']
	])('refuses %s with %i', async (query, status, code) => {
		const response = await run(query);
		expect(response.status).toBe(status);
		expect(((await response.json()) as { refused: string }).refused).toBe(code);
		expect(container.started).toHaveLength(0);
	});

	it('refuses a body with no declared size and a size that is not a number', async () => {
		const body = new Blob(['hello']).stream();
		const missing = await runner.fetch(
			new Request('http://runner/run?kind=echo-import&key=a', {
				method: 'POST',
				body,
				duplex: 'half'
			} as RequestInit)
		);
		expect(missing.status).toBe(411);
		const garbled = await run('kind=echo-import&key=a', 'hello', { 'x-input-bytes': '5x' });
		expect(garbled.status).toBe(411);
		expect(container.started).toHaveLength(0);
	});

	it('runs a job with no body and no declared size as a zero-byte input', async () => {
		const record = await recordOf(await run('kind=drupal-hop&key=runs/g/out', null));
		expect(record).toMatchObject({ bytesIn: 0, state: 'succeeded' });
	});

	it('refuses a second job while one is running', async () => {
		let release!: () => void;
		container.answer = () =>
			new Promise<Response>((resolve) => {
				release = () => resolve(reply(0, 'out'));
			});
		const first = run('kind=echo-import&key=runs/h/out');
		await vi.waitFor(() => expect(container.posted).toHaveLength(1));

		const second = await run('kind=echo-import&key=runs/h/two');
		expect(second.status).toBe(409);
		expect(((await second.json()) as { refused: string }).refused).toBe('busy');

		release();
		expect((await recordOf(await first)).state).toBe('succeeded');
		container.answer = () => reply(0, 'out');
		const third = await run('kind=echo-import&key=runs/h/three');
		expect(third.status).toBe(200);
	});

	it('answers a wrong method or path without touching the container', async () => {
		const get = await runner.fetch(new Request('http://runner/run'));
		expect(get.status).toBe(405);
		const other = await runner.fetch(new Request('http://runner/other', { method: 'POST' }));
		expect(other.status).toBe(404);
		expect(container.started).toHaveLength(0);
	});

	it('answers 500 when the object has no container', async () => {
		const bare = new (JobRunner as unknown as new (ctx: unknown, env: unknown) => JobRunner)(
			{ storage },
			{ BLOB: blobs }
		);
		const response = await bare.fetch(
			new Request('http://runner/run?kind=echo-import&key=a', { method: 'POST' })
		);
		expect(response.status).toBe(500);
		expect(
			await bare.fetch(new Request('http://runner/destroy', { method: 'POST' }))
		).toBeDefined();
	});
});
