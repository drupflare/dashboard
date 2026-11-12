import { DurableObject } from 'cloudflare:workers';
import {
	checkRequest,
	EXIT_HEADER,
	exitOf,
	HEALTH_URL,
	INACTIVITY_MS,
	INPUT_BYTES_HEADER,
	JOB_MESSAGES,
	JOB_REFUSAL_MESSAGES,
	JOB_REFUSAL_STATUS,
	JOB_URL,
	jobBody,
	JobRefused,
	JOBS,
	READY_ATTEMPTS,
	READY_DELAY_MS,
	READY_TIMEOUT_MS,
	RUNNER_PORT,
	startOptions,
	type JobRequest,
	type JobState,
	type RunRecord,
	type RunRefusal,
	type StartOptions
} from './jobs';

export interface JobContainer {
	readonly running: boolean;
	start(options: StartOptions): void;
	getTcpPort(port: number): { fetch(input: string, init?: RequestInit): Promise<Response> };
	monitor(): Promise<void>;
	destroy(reason?: unknown): Promise<void>;
	setInactivityTimeout(ms: number): Promise<void>;
}

export interface BlobSink {
	put(key: string, value: ReadableStream<Uint8Array> | string): Promise<unknown>;
}

export interface RunDeps {
	container: JobContainer;
	image: string;
	blob: BlobSink;
	now(): number;
	sleep(ms: number): Promise<void>;
	arm(ms: number): Promise<void>;
	disarm(): Promise<void>;
	interrupted(): 'timeout' | 'destroyed' | null;
}

export class NotReady extends Error {
	constructor(override readonly cause: unknown) {
		super('The container did not become ready.');
		this.name = 'NotReady';
	}
}

export async function waitReady(
	container: JobContainer,
	sleep: (ms: number) => Promise<void>,
	stopped: () => boolean
): Promise<void> {
	const port = container.getTcpPort(RUNNER_PORT);
	let last: unknown;
	for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
		if (stopped()) throw new NotReady('the container exited');
		try {
			const response = await port.fetch(HEALTH_URL, {
				signal: AbortSignal.timeout(READY_TIMEOUT_MS)
			});
			await response.body?.cancel();
			if (response.ok) return;
			last = `health check returned ${response.status}`;
		} catch (error) {
			last = error;
		}
		await sleep(READY_DELAY_MS);
	}
	throw new NotReady(last);
}

export async function runJob(
	deps: RunDeps,
	request: JobRequest,
	input: ReadableStream<Uint8Array> | null
): Promise<RunRecord> {
	const { container } = deps;
	const spec = JOBS[request.kind];
	const sending = jobBody(request.kind, input);
	let stage: 'starting' | 'running' = 'starting';
	let stopped = false;
	let readyAt: number | null = null;
	let state: JobState = 'job_failed';
	let exitCode: number | null = null;
	let bytesOut = 0;
	let startedAt = deps.now();
	let destroyed = false;

	try {
		// an instance left by an earlier run must not serve this one
		if (container.running) await container.destroy();
		startedAt = deps.now();
		await deps.arm(spec.wallMs);
		container.start(startOptions(request.kind, deps.image));
		container.monitor().then(
			() => {
				stopped = true;
			},
			() => {
				stopped = true;
			}
		);
		await container.setInactivityTimeout(INACTIVITY_MS);
		await waitReady(container, deps.sleep, () => stopped);
		readyAt = deps.now();
		stage = 'running';

		const response = await container
			.getTcpPort(RUNNER_PORT)
			.fetch(JOB_URL, { method: 'POST', body: sending.body });
		const ended =
			response.status === 200
				? exitOf(response.headers.get(EXIT_HEADER))
				: { state: 'job_failed' as JobState, exitCode: null };
		state = ended.state;
		exitCode = ended.exitCode;
		if (state === 'succeeded') {
			const declared = response.headers.get('content-length');
			const length = declared !== null && /^\d+$/.test(declared) ? Number(declared) : -1;
			if (!Number.isSafeInteger(length) || length < 0 || length > spec.outputLimit) {
				state = 'job_failed';
				exitCode = null;
				await response.body?.cancel();
			} else {
				await deps.blob.put(request.key, response.body ?? '');
				bytesOut = length;
			}
		} else {
			await response.body?.cancel();
		}
	} catch (error) {
		console.error(`job ${request.kind} stopped while ${stage}`, error);
		exitCode = null;
		const interrupted = deps.interrupted();
		if (interrupted === 'timeout') state = 'timed_out';
		else if (interrupted === 'destroyed' || (stopped && stage === 'running')) state = 'killed';
		else if (stage === 'starting') state = 'start_failed';
		else state = 'job_failed';
	} finally {
		try {
			await container.destroy();
			destroyed = true;
		} catch {
			destroyed = !container.running;
		}
		if (destroyed) {
			// a stale alarm only finds nothing running
			await deps.disarm().catch(() => undefined);
		}
	}
	const doneAt = deps.now();
	return {
		kind: request.kind,
		key: request.key,
		state,
		message: JOB_MESSAGES[state],
		exitCode,
		instance: spec.instance,
		enableInternet: spec.enableInternet,
		startedAt,
		readyAt,
		doneAt,
		coldStartMs: readyAt === null ? null : readyAt - startedAt,
		wallMs: doneAt - startedAt,
		bytesIn: sending.sent(),
		bytesOut,
		destroyed
	};
}

export interface JobRunnerEnv {
	BLOB: BlobSink;
}

interface RunnerContext {
	container?: JobContainer & { images: Record<string, string> };
	storage: { setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void> };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});

export class JobRunner extends DurableObject<JobRunnerEnv> {
	private busy = false;
	private why: 'timeout' | 'destroyed' | null = null;

	private get runtime(): RunnerContext {
		return this.ctx as unknown as RunnerContext;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
		if (url.pathname === '/destroy') return this.forceDestroy();
		if (url.pathname !== '/run') return new Response('Not found', { status: 404 });

		try {
			const declared = request.headers.get(INPUT_BYTES_HEADER);
			const job = checkRequest({
				kind: url.searchParams.get('kind'),
				key: url.searchParams.get('key'),
				inputBytes:
					declared === null
						? request.body
							? null
							: 0
						: /^\d+$/.test(declared)
							? Number(declared)
							: NaN
			});
			if (this.busy) throw new JobRefused('busy');
			const { container } = this.runtime;
			if (!container) return new Response('No container is configured', { status: 500 });

			this.busy = true;
			this.why = null;
			try {
				const record = await runJob(
					{
						container,
						image: container.images.runner as string,
						blob: this.env.BLOB,
						now: Date.now,
						sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
						arm: (ms) => this.runtime.storage.setAlarm(Date.now() + ms),
						disarm: () => this.runtime.storage.deleteAlarm(),
						interrupted: () => this.why
					},
					job,
					request.body
				);
				return json(record);
			} finally {
				this.busy = false;
			}
		} catch (error) {
			if (!(error instanceof JobRefused)) throw error;
			await request.body?.cancel();
			const refusal: RunRefusal = {
				refused: error.code,
				message: JOB_REFUSAL_MESSAGES[error.code]
			};
			return json(refusal, JOB_REFUSAL_STATUS[error.code]);
		}
	}

	async alarm(): Promise<void> {
		if (this.busy) this.why = 'timeout';
		if (this.runtime.container?.running) await this.runtime.container.destroy('wall limit');
	}

	private async forceDestroy(): Promise<Response> {
		const { container } = this.runtime;
		const running = container?.running ?? false;
		if (this.busy) this.why = 'destroyed';
		if (container) await container.destroy('forced');
		return json({ destroyed: running });
	}
}
