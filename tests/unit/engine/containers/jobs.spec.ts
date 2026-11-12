import { describe, expect, it } from 'vitest';
import {
	checkRequest,
	exitOf,
	JOB_KINDS,
	JOB_MESSAGES,
	JOB_REFUSAL_MESSAGES,
	JOB_REFUSAL_STATUS,
	JOB_REFUSALS,
	JOB_STATES,
	jobBody,
	JobRefused,
	jobRequestSchema,
	JOBS,
	MAX_WALL_MS,
	startOptions,
	type JobKind
} from '../../../../engine/src/containers/jobs';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const refusal = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return (error as JobRefused).code;
	}
	return undefined;
};

describe('job table', () => {
	it('names the four kinds with the instance each one runs on', () => {
		expect(JOB_KINDS).toEqual(['composer-tree', 'template-build', 'echo-import', 'drupal-hop']);
		expect(JOBS['composer-tree'].instance).toBe('standard-2');
		expect(JOBS['template-build'].instance).toBe('standard-2');
		expect(JOBS['echo-import'].instance).toBe('standard-3');
		expect(JOBS['drupal-hop'].instance).toBe('standard-3');
	});

	it('gives every kind a positive wall limit of at most thirty minutes', () => {
		expect(MAX_WALL_MS).toBe(1_800_000);
		for (const kind of JOB_KINDS) {
			expect(JOBS[kind].wallMs).toBeGreaterThan(0);
			expect(JOBS[kind].wallMs).toBeLessThanOrEqual(MAX_WALL_MS);
			expect(JOBS[kind].inputLimit).toBeGreaterThan(0);
			expect(JOBS[kind].outputLimit).toBeGreaterThan(0);
		}
	});

	it('opens the network only for the kinds that reach a registry', () => {
		expect(JOBS['composer-tree'].enableInternet).toBe(true);
		expect(JOBS['template-build'].enableInternet).toBe(true);
		expect(JOBS['echo-import'].enableInternet).toBe(false);
		expect(JOBS['drupal-hop'].enableInternet).toBe(false);
	});
});

describe('startOptions', () => {
	it.each(JOB_KINDS)('builds the start call for %s from the table', (kind: JobKind) => {
		const spec = JOBS[kind];
		expect(startOptions(kind, 'image-ref')).toEqual({
			image: 'image-ref',
			instance: spec.instance,
			enableInternet: spec.enableInternet,
			env: {
				JOB_INPUT_LIMIT: String(spec.inputLimit),
				JOB_OUTPUT_LIMIT: String(spec.outputLimit),
				JOB_WALL_MS: String(spec.wallMs)
			}
		});
	});
});

describe('checkRequest', () => {
	const ok = { kind: 'echo-import', key: 'imports/site_1/out.txt', inputBytes: 10 };

	it('accepts a known kind, a plain key and a size inside the limit', () => {
		expect(checkRequest(ok)).toEqual(ok);
		expect(jobRequestSchema.safeParse(ok).success).toBe(true);
	});

	it('accepts an input of exactly the limit and refuses one byte more', () => {
		const limit = JOBS['echo-import'].inputLimit;
		expect(checkRequest({ ...ok, inputBytes: limit }).inputBytes).toBe(limit);
		expect(refusal(() => checkRequest({ ...ok, inputBytes: limit + 1 }))).toBe(
			'input_too_large'
		);
	});

	it('refuses an unknown or missing kind', () => {
		expect(refusal(() => checkRequest({ ...ok, kind: 'rm-rf' }))).toBe('unknown_kind');
		expect(refusal(() => checkRequest({ ...ok, kind: null }))).toBe('unknown_kind');
	});

	it.each(['', '/lead', 'a/../b', 'a//b', 'trail/', 'sp ace', '..', null])(
		'refuses the key %j',
		(key) => {
			expect(refusal(() => checkRequest({ ...ok, key }))).toBe('bad_key');
		}
	);

	it.each([null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'refuses the size %j as unknown',
		(inputBytes) => {
			expect(refusal(() => checkRequest({ ...ok, inputBytes }))).toBe('length_required');
		}
	);

	it('rejects an unknown field in the strict schema', () => {
		expect(jobRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
	});

	it('maps each refusal to a status and a fixed message', () => {
		expect(new JobRefused('busy').message).toBe(JOB_REFUSAL_MESSAGES.busy);
		for (const code of JOB_REFUSALS) {
			expect(JOB_REFUSAL_STATUS[code]).toBeGreaterThanOrEqual(400);
			expect(JOB_REFUSAL_MESSAGES[code].length).toBeGreaterThan(0);
		}
		expect(new Set(Object.values(JOB_REFUSAL_MESSAGES)).size).toBe(JOB_REFUSALS.length);
	});
});

describe('jobBody', () => {
	it('puts a json header line before the input and counts only the input', async () => {
		const input = new Blob(['hello world']).stream();
		const sending = jobBody('echo-import', input);
		const bytes = await drain(sending.body);
		expect(text(bytes)).toBe('{"kind":"echo-import"}\nhello world');
		expect(sending.headBytes).toBe('{"kind":"echo-import"}\n'.length);
		expect(sending.sent()).toBe(11);
	});

	it('sends only the header line when there is no input', async () => {
		const sending = jobBody('drupal-hop', null);
		expect(text(await drain(sending.body))).toBe('{"kind":"drupal-hop"}\n');
		expect(sending.sent()).toBe(0);
	});

	it('hands a cancel to the input stream', async () => {
		let cancelled: unknown;
		const input = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel(reason) {
				cancelled = reason;
			}
		});
		const sending = jobBody('echo-import', input);
		const reader = sending.body.getReader();
		await reader.read();
		await reader.cancel('stop');
		expect(cancelled).toBe('stop');
	});
});

describe('exitOf', () => {
	it.each([
		['0', 'succeeded', 0],
		['1', 'job_failed', 1],
		['70', 'job_failed', 70],
		['137', 'job_failed', 137],
		['timeout', 'timed_out', null],
		['killed', 'killed', null],
		[null, 'job_failed', null],
		['', 'job_failed', null],
		['-1', 'job_failed', null],
		['1000', 'job_failed', null],
		['0x1', 'job_failed', null]
	])('reads the header %j as %s', (header, state, exitCode) => {
		expect(exitOf(header)).toEqual({ state, exitCode });
	});

	it('has one distinct message for each state', () => {
		for (const state of JOB_STATES) expect(JOB_MESSAGES[state].length).toBeGreaterThan(0);
		expect(new Set(Object.values(JOB_MESSAGES)).size).toBe(JOB_STATES.length);
	});
});
