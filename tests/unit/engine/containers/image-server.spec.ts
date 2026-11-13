import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	childEnv,
	composerSteps,
	createRunner,
	createTail,
	EXIT_HEADER,
	EXIT_NOT_BUILT,
	EXIT_OUTPUT_TOO_LARGE,
	KINDS,
	RUNNERS,
	type JobContext,
	type JobRunnerFn,
	type RunnerOptions
} from '../../../../engine/src/containers/image/server.mjs';

let root: string;
let server: ReturnType<typeof createRunner>;
let logs: string[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'runner-spec-'));
	logs = [];
});

afterEach(async () => {
	server?.closeAllConnections();
	await new Promise((resolve) => server?.close(resolve));
	await rm(root, { recursive: true, force: true });
});

async function start(options: RunnerOptions = {}): Promise<string> {
	server = createRunner({
		root,
		inputLimit: 1024,
		outputLimit: 1024,
		wallMs: 5000,
		log: (line) => logs.push(line),
		...options
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const head = (kind: string) => `{"kind":"${kind}"}\n`;

const post = (base: string, body: string | Buffer, headers: Record<string, string> = {}) =>
	fetch(`${base}/run`, {
		method: 'POST',
		body: typeof body === 'string' ? body : new Uint8Array(body),
		headers
	});

const withRunner = (fn: JobRunnerFn, kind = 'echo-import') => ({
	runners: { ...RUNNERS, [kind]: fn }
});

describe('health and routing', () => {
	it('answers the readiness check', async () => {
		const base = await start();
		const response = await fetch(`${base}/health`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('refuses an unknown path and a wrong method', async () => {
		const base = await start();
		expect((await fetch(`${base}/other`)).status).toBe(404);
		expect((await fetch(`${base}/run`)).status).toBe(405);
		expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
	});
});

describe('echo-import', () => {
	it('returns the sha256 of the body with a length and an exit header', async () => {
		const base = await start();
		const input = Buffer.from('some import body');
		const response = await post(base, Buffer.concat([Buffer.from(head('echo-import')), input]));
		expect(response.status).toBe(200);
		expect(response.headers.get(EXIT_HEADER)).toBe('0');
		const expected = `${createHash('sha256').update(input).digest('hex')}\n`;
		expect(response.headers.get('content-length')).toBe(String(expected.length));
		expect(await response.text()).toBe(expected);
	});

	it('hashes an empty body', async () => {
		const base = await start();
		const response = await post(base, head('echo-import'));
		expect(await response.text()).toBe(`${createHash('sha256').digest('hex')}\n`);
	});

	it('removes the job directory after the response', async () => {
		const base = await start();
		await (await post(base, head('echo-import') + 'abc')).text();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await readdir(root)).toEqual([]);
	});
});

describe('createTail', () => {
	it('returns every line while they fit', () => {
		const tail = createTail(100);
		tail.add('a');
		tail.add('b');
		expect(tail.text()).toBe('a\nb');
	});

	it('drops the oldest lines first when the limit is passed', () => {
		const tail = createTail(10);
		for (const line of ['aaaa', 'bbbb', 'cccc']) tail.add(line);
		expect(tail.text()).toBe('bbbb\ncccc');
	});

	it('cuts a line longer than 400 characters and marks the cut', () => {
		const tail = createTail(4096);
		tail.add('y'.repeat(500));
		expect(tail.text()).toBe(`${'y'.repeat(400)}...`);
	});

	it('keeps the last bytes of a single line that is over the limit', () => {
		const tail = createTail(8);
		tail.add('0123456789');
		expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(8);
		expect(tail.text().endsWith('789')).toBe(true);
	});

	it('is empty before any line', () => {
		expect(createTail().text()).toBe('');
	});
});

describe('kinds that are not built', () => {
	it.each(['template-build', 'drupal-hop'])(
		'fails %s with a fixed code and a log line',
		async (kind) => {
			const base = await start();
			const response = await post(base, head(kind));
			expect(response.status).toBe(200);
			expect(response.headers.get(EXIT_HEADER)).toBe(String(EXIT_NOT_BUILT));
			expect(await response.text()).toBe(`[${kind}] ${kind} is not built`);
			expect(logs).toContain(`[${kind}] ${kind} is not built`);
		}
	);
});

describe('job outcomes', () => {
	const write =
		(text: string): JobRunnerFn =>
		async ({ output }: JobContext) => {
			await writeFile(output, text);
			return 0;
		};

	it('streams the artifact a runner writes', async () => {
		const base = await start(withRunner(write('artifact bytes')));
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('0');
		expect(response.headers.get('content-length')).toBe('14');
		expect(await response.text()).toBe('artifact bytes');
	});

	it('hands the runner its input file and a log function that tags the kind', async () => {
		let seen = '';
		const base = await start(
			withRunner(async ({ input, output, log }) => {
				const { readFile } = await import('node:fs/promises');
				seen = await readFile(input, 'utf8');
				log('working');
				await writeFile(output, 'x');
				return 0;
			})
		);
		await (await post(base, head('echo-import') + 'payload')).text();
		expect(seen).toBe('payload');
		expect(logs).toContain('[echo-import] working');
	});

	it('reports a non-zero exit with an empty body', async () => {
		const base = await start(withRunner(async () => 3));
		const response = await post(base, head('echo-import'));
		expect(response.status).toBe(200);
		expect(response.headers.get(EXIT_HEADER)).toBe('3');
		expect(response.headers.get('content-length')).toBe('0');
		expect(await response.text()).toBe('');
	});

	it('reports a killed runner', async () => {
		const base = await start(withRunner(async () => 'killed'));
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('killed');
	});

	it('reports a runner that returns timeout', async () => {
		const base = await start(withRunner(async () => 'timeout'));
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('timeout');
	});

	it('turns the wall limit into a timeout even when the runner reports success', async () => {
		const base = await start({
			wallMs: 50,
			...withRunner(async ({ signal, output }) => {
				await new Promise((resolve) => signal.addEventListener('abort', resolve));
				await writeFile(output, 'late');
				return 0;
			})
		});
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('timeout');
		expect(response.headers.get('content-length')).toBe('0');
	});

	it('reports a runner that throws as exit 1 and logs the message', async () => {
		const base = await start(
			withRunner(async () => {
				throw new Error('boom');
			})
		);
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('1');
		expect(logs).toContain('[echo-import] runner error: boom');
	});

	it('reports a runner that throws a non-error as exit 1', async () => {
		const base = await start(
			withRunner(async () => {
				throw 'plain';
			})
		);
		expect((await post(base, head('echo-import'))).headers.get(EXIT_HEADER)).toBe('1');
		expect(logs).toContain('[echo-import] runner error: plain');
	});

	it('reports success without an artifact as exit 1', async () => {
		const base = await start(withRunner(async () => 0));
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('1');
		expect(logs).toContain('[echo-import] the job did not write a result');
	});

	it('reports an artifact over the output limit', async () => {
		const base = await start({ outputLimit: 8, ...withRunner(write('123456789')) });
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe(String(EXIT_OUTPUT_TOO_LARGE));
		expect(await response.text()).toBe('[echo-import] the result is larger than the limit');
	});

	it('returns the end of a failed job output as the body, tagged with the kind', async () => {
		const base = await start(
			withRunner(async ({ log }) => {
				log('first');
				log('second');
				return 2;
			})
		);
		const response = await post(base, head('echo-import'));
		expect(response.headers.get(EXIT_HEADER)).toBe('2');
		expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		const body = await response.text();
		expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
		expect(body).toBe('[echo-import] first\n[echo-import] second');
	});

	it('keeps only the last 4096 bytes of a failed job output', async () => {
		const base = await start(
			withRunner(async ({ log }) => {
				for (let i = 0; i < 200; i++) log(`line ${i} ${'x'.repeat(60)}`);
				return 1;
			})
		);
		const text = await (await post(base, head('echo-import'))).text();
		expect(new Blob([text]).size).toBeLessThanOrEqual(4096);
		expect(text.endsWith(`line 199 ${'x'.repeat(60)}`)).toBe(true);
		expect(text).not.toContain('line 0 ');
	});

	it('sends no output body after a job that succeeded', async () => {
		const base = await start(
			withRunner(async ({ log, output }) => {
				log('noise');
				await writeFile(output, 'ok');
				return 0;
			})
		);
		expect(await (await post(base, head('echo-import'))).text()).toBe('ok');
	});

	it('accepts an artifact of exactly the output limit', async () => {
		const base = await start({ outputLimit: 8, ...withRunner(write('12345678')) });
		expect((await post(base, head('echo-import'))).headers.get(EXIT_HEADER)).toBe('0');
	});

	it('refuses a second job while one is running', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let entered!: () => void;
		const inside = new Promise<void>((resolve) => (entered = resolve));
		const base = await start(
			withRunner(async ({ output }) => {
				entered();
				await gate;
				await writeFile(output, 'ok');
				return 0;
			})
		);
		const first = post(base, head('echo-import'));
		await inside;
		const second = await post(base, head('echo-import'));
		expect(second.status).toBe(409);
		release();
		const done = await first;
		expect(done.headers.get(EXIT_HEADER)).toBe('0');
		await done.text();
		await vi.waitFor(async () => {
			const third = await post(base, head('echo-import'));
			expect(third.status).toBe(200);
		});
	});
});

describe('request refusals', () => {
	it.each([
		['text that is not json', 'not json\nabc'],
		['json that is not an object', '[1]\nabc'],
		['null', 'null\nabc'],
		['an unknown kind', '{"kind":"sh"}\nabc'],
		['a missing kind', '{}\nabc'],
		['an extra argument field', '{"kind":"echo-import","args":["rm"]}\nabc'],
		['a body with no newline', '{"kind":"echo-import"}'],
		['an empty body', ''],
		['a header line over the limit', `${'x'.repeat(2000)}\nabc`],
		['a newline after the limit', `{"kind":"echo-import","pad":"${'x'.repeat(1100)}"}\nabc`]
	])('answers 400 for %s', async (_name, body) => {
		const base = await start();
		const response = await post(base, body);
		expect(response.status).toBe(400);
		expect(response.headers.get(EXIT_HEADER)).toBeNull();
		await response.text();
	});

	it('answers 413 when the declared length is over the limit', async () => {
		const base = await start({ inputLimit: 100 });
		const response = await post(base, head('echo-import') + 'x'.repeat(2000));
		expect(response.status).toBe(413);
		await response.text();
	});

	it('answers 413 when a body with no declared length runs over the limit', async () => {
		const base = await start({ inputLimit: 100 });
		const chunks = [head('echo-import'), 'x'.repeat(80), 'x'.repeat(80)];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			}
		});
		const response = await fetch(`${base}/run`, {
			method: 'POST',
			body,
			duplex: 'half'
		} as RequestInit);
		expect(response.status).toBe(413);
		await response.text();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await readdir(root)).toEqual([]);
	});

	it('takes an input of exactly the limit', async () => {
		const base = await start({ inputLimit: 10 });
		const response = await post(base, head('echo-import') + 'x'.repeat(10));
		expect(response.status).toBe(200);
		await response.text();
	});

	it('reports a known kind with no runner as exit 1', async () => {
		const base = await start({ runners: {} });
		const response = await post(base, head('echo-import'));
		expect(response.status).toBe(200);
		expect(response.headers.get(EXIT_HEADER)).toBe('1');
	});
});

describe('composer-tree commands', () => {
	it('lists three fixed commands with the tarball paths as separate arguments', () => {
		expect(composerSteps('/w/project', '/w/input', '/w/output')).toEqual([
			[
				'tar',
				['-xzf', '/w/input', '-C', '/w/project', '--no-same-owner', '--no-same-permissions']
			],
			[
				'composer',
				['install', '--no-dev', '--prefer-dist', '--no-interaction', '--no-progress']
			],
			['tar', ['-czf', '/w/output', '-C', '/w/project', '.']]
		]);
	});

	it('keeps a path with shell characters as one argument', () => {
		const [extract] = composerSteps('/w/p', '/w/in put; rm -rf', '/w/o');
		expect(extract![1][1]).toBe('/w/in put; rm -rf');
	});

	it('gives children only the listed variables', () => {
		process.env.SPEC_SECRET_VALUE = 'x';
		try {
			const env = childEnv('/w');
			expect(Object.keys(env).sort()).toEqual([
				'COMPOSER_HOME',
				'COMPOSER_NO_INTERACTION',
				'HOME',
				'PATH'
			]);
			expect(env.HOME).toBe('/w/home');
			expect(env.COMPOSER_HOME).toBe('/w/home/composer');
			expect(env.COMPOSER_NO_INTERACTION).toBe('1');
		} finally {
			delete process.env.SPEC_SECRET_VALUE;
		}
	});

	it('has a runner for every kind', () => {
		expect(Object.keys(RUNNERS).sort()).toEqual([...KINDS].sort());
	});
});

describe('composer-tree with stub tools', () => {
	let bin: string;
	let savedPath: string | undefined;

	const mode = (value: string) => writeFile(join(bin, 'mode'), value);

	// the stubs are written once and read a mode file, so each test runs already-scanned binaries
	beforeAll(async () => {
		bin = await mkdtemp(join(tmpdir(), 'runner-bin-'));
		const tool = async (name: string, script: string) => {
			await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
			await chmod(join(bin, name), 0o755);
		};
		await tool('tar', 'case "$1" in -czf) echo packed > "$2";; esac');
		await tool(
			'composer',
			[
				'case "$(cat "$(dirname "$0")/mode")" in',
				'ok) echo installing; echo warn >&2; printf tail;;',
				'fail) exit 4;;',
				'hang) sleep 30;;',
				'kill) kill -9 $$;;',
				'esac'
			].join('\n')
		);
	});

	afterAll(() => rm(bin, { recursive: true, force: true }));

	beforeEach(() => {
		savedPath = process.env.PATH;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
	});

	afterEach(() => {
		process.env.PATH = savedPath;
	});

	it('extracts, installs and packs, logging each line of tool output and a last line without a newline', async () => {
		await mode('ok');
		const base = await start({ runners: RUNNERS });
		const response = await post(base, head('composer-tree') + 'tarball');
		expect(response.headers.get(EXIT_HEADER)).toBe('0');
		expect(await response.text()).toBe('packed\n');
		expect(logs).toEqual(
			expect.arrayContaining([
				'[composer-tree] installing',
				'[composer-tree] warn',
				'[composer-tree] tail'
			])
		);
	});

	it('stops at the first failing command and reports its exit code', async () => {
		await mode('fail');
		const base = await start({ runners: RUNNERS });
		const response = await post(base, head('composer-tree'));
		expect(response.headers.get(EXIT_HEADER)).toBe('4');
		expect(response.headers.get('content-length')).toBe('0');
	});

	it('reports a command that is not installed as exit 127', async () => {
		const base = await start({ runners: RUNNERS });
		process.env.PATH = join(bin, 'missing');
		const response = await post(base, head('composer-tree'));
		expect(response.headers.get(EXIT_HEADER)).toBe('127');
		expect(logs.some((line) => line.includes('could not run tar'))).toBe(true);
	});

	it('kills a command that outlives the wall limit and reports a timeout', async () => {
		await mode('hang');
		const base = await start({ runners: RUNNERS, wallMs: 300 });
		const started = Date.now();
		const response = await post(base, head('composer-tree'));
		expect(response.headers.get(EXIT_HEADER)).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('reports a command killed by a signal as killed', async () => {
		await mode('kill');
		const base = await start({ runners: RUNNERS });
		const response = await post(base, head('composer-tree'));
		expect(response.headers.get(EXIT_HEADER)).toBe('killed');
	});

	it('kills at once when the wall limit has already passed', async () => {
		await mode('hang');
		const base = await start({ runners: RUNNERS, wallMs: 1 });
		const started = Date.now();
		const response = await post(base, head('composer-tree'));
		expect(response.headers.get(EXIT_HEADER)).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(5000);
	});
});
