import { z } from 'zod';

export const JOB_KINDS = ['composer-tree', 'template-build', 'echo-import', 'drupal-hop'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const RUNNER_PORT = 8080;
export const JOB_URL = 'http://container/run';
export const HEALTH_URL = 'http://container/health';
export const EXIT_HEADER = 'x-job-exit';
export const INPUT_BYTES_HEADER = 'x-input-bytes';

export const MAX_WALL_MS = 30 * 60_000;

// the readiness loop and the inactivity timeout follow the Containers docs examples
export const READY_ATTEMPTS = 100;
export const READY_DELAY_MS = 200;
export const READY_TIMEOUT_MS = 1000;
export const INACTIVITY_MS = 120_000;

const MIB = 1024 * 1024;
const MINUTE = 60_000;

export interface JobSpec {
	instance: 'standard-2' | 'standard-3';
	enableInternet: boolean;
	inputLimit: number;
	outputLimit: number;
	wallMs: number;
}

// limits are unmeasured starting points; the instance names come from the Containers limits page
export const JOBS: Record<JobKind, JobSpec> = {
	'composer-tree': {
		instance: 'standard-2',
		enableInternet: true,
		inputLimit: 256 * MIB,
		outputLimit: 1024 * MIB,
		wallMs: 20 * MINUTE
	},
	'template-build': {
		instance: 'standard-2',
		enableInternet: true,
		inputLimit: 256 * MIB,
		outputLimit: 1024 * MIB,
		wallMs: 25 * MINUTE
	},
	'echo-import': {
		instance: 'standard-3',
		enableInternet: false,
		inputLimit: 1024 * MIB,
		outputLimit: 4096,
		wallMs: 10 * MINUTE
	},
	'drupal-hop': {
		instance: 'standard-3',
		enableInternet: false,
		inputLimit: 1024 * MIB,
		outputLimit: 1024 * MIB,
		wallMs: MAX_WALL_MS
	}
};

// #region request

export const JOB_REFUSALS = [
	'unknown_kind',
	'bad_key',
	'length_required',
	'input_too_large',
	'busy'
] as const;
export type JobRefusalCode = (typeof JOB_REFUSALS)[number];

export const JOB_REFUSAL_STATUS: Record<JobRefusalCode, number> = {
	unknown_kind: 400,
	bad_key: 400,
	length_required: 411,
	input_too_large: 413,
	busy: 409
};

export const JOB_REFUSAL_MESSAGES: Record<JobRefusalCode, string> = {
	unknown_kind: 'The job type is not supported.',
	bad_key: 'The result key is not valid.',
	length_required: 'The job input needs a known size.',
	input_too_large: 'The job input is larger than the limit for this job type.',
	busy: 'This runner is already running a job.'
};

export class JobRefused extends Error {
	constructor(readonly code: JobRefusalCode) {
		super(JOB_REFUSAL_MESSAGES[code]);
		this.name = 'JobRefused';
	}
}

export const jobKeySchema = z
	.string()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
	.refine((key) => !key.includes('..') && !key.includes('//') && !key.endsWith('/'));

export const jobRequestSchema = z
	.object({
		kind: z.enum(JOB_KINDS),
		key: jobKeySchema,
		inputBytes: z.number().int().min(0)
	})
	.strict();
export type JobRequest = z.infer<typeof jobRequestSchema>;

export function checkRequest(raw: {
	kind: string | null;
	key: string | null;
	inputBytes: number | null;
}): JobRequest {
	const kind = z.enum(JOB_KINDS).safeParse(raw.kind);
	if (!kind.success) throw new JobRefused('unknown_kind');
	if (!jobKeySchema.safeParse(raw.key).success) throw new JobRefused('bad_key');
	if (raw.inputBytes === null || !Number.isSafeInteger(raw.inputBytes) || raw.inputBytes < 0)
		throw new JobRefused('length_required');
	if (raw.inputBytes > JOBS[kind.data].inputLimit) throw new JobRefused('input_too_large');
	return { kind: kind.data, key: raw.key as string, inputBytes: raw.inputBytes };
}

// #endregion

// #region start and send

export interface StartOptions {
	image: string;
	instance: JobSpec['instance'];
	enableInternet: boolean;
	env: Record<string, string>;
}

export function startOptions(kind: JobKind, image: string): StartOptions {
	const spec = JOBS[kind];
	return {
		image,
		instance: spec.instance,
		enableInternet: spec.enableInternet,
		env: {
			JOB_INPUT_LIMIT: String(spec.inputLimit),
			JOB_OUTPUT_LIMIT: String(spec.outputLimit),
			JOB_WALL_MS: String(spec.wallMs)
		}
	};
}

const encoder = new TextEncoder();

export interface JobBody {
	body: ReadableStream<Uint8Array>;
	headBytes: number;
	// input bytes the container has pulled so far, not counting the head line
	sent(): number;
}

export function jobBody(kind: JobKind, input: ReadableStream<Uint8Array> | null): JobBody {
	const head = encoder.encode(`${JSON.stringify({ kind })}\n`);
	const reader = input?.getReader();
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(head);
			if (!reader) controller.close();
		},
		async pull(controller) {
			if (!reader) return;
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			sent += value.byteLength;
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader?.cancel(reason);
		}
	});
	return { body, headBytes: head.byteLength, sent: () => sent };
}

// #endregion

// #region ending

export const JOB_STATES = [
	'succeeded',
	'job_failed',
	'timed_out',
	'killed',
	'start_failed'
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_MESSAGES: Record<JobState, string> = {
	succeeded: 'The job finished.',
	job_failed: 'The job ran but did not finish.',
	timed_out: 'The job ran past its time limit and was stopped.',
	killed: 'The job was stopped before it finished.',
	start_failed: 'The job could not start.'
};

export const LOG_TAIL_BYTES = 4096;

// the header carries a process exit code, or one of two words when there is no code
export function exitOf(header: string | null): { state: JobState; exitCode: number | null } {
	if (header === 'timeout') return { state: 'timed_out', exitCode: null };
	if (header === 'killed') return { state: 'killed', exitCode: null };
	if (header !== null && /^\d{1,3}$/.test(header)) {
		const exitCode = Number(header);
		return { state: exitCode === 0 ? 'succeeded' : 'job_failed', exitCode };
	}
	return { state: 'job_failed', exitCode: null };
}

export interface RunRecord {
	kind: JobKind;
	key: string;
	state: JobState;
	message: string;
	exitCode: number | null;
	instance: JobSpec['instance'];
	enableInternet: boolean;
	startedAt: number;
	readyAt: number | null;
	doneAt: number;
	coldStartMs: number | null;
	wallMs: number;
	bytesIn: number;
	bytesOut: number;
	destroyed: boolean;
	logTail: string | null;
}

export interface RunRefusal {
	refused: JobRefusalCode;
	message: string;
}

// #endregion
