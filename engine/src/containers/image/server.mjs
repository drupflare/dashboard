import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export const KINDS = ['composer-tree', 'template-build', 'echo-import', 'drupal-hop'];
export const EXIT_HEADER = 'x-job-exit';
export const EXIT_NOT_BUILT = 70;
export const EXIT_OUTPUT_TOO_LARGE = 71;
const HEAD_LIMIT = 1024;

class Refusal extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function childEnv(dir) {
	return {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: join(dir, 'home'),
		COMPOSER_HOME: join(dir, 'home', 'composer'),
		COMPOSER_NO_INTERACTION: '1'
	};
}

// every command is a fixed file and a fixed argument list; nothing from the request reaches a shell
export function composerSteps(project, input, output) {
	return [
		['tar', ['-xzf', input, '-C', project, '--no-same-owner', '--no-same-permissions']],
		['composer', ['install', '--no-dev', '--prefer-dist', '--no-interaction', '--no-progress']],
		['tar', ['-czf', output, '-C', project, '.']]
	];
}

function runCommand(file, args, { cwd, env, log, signal }) {
	return new Promise((resolve) => {
		const child = spawn(file, args, {
			cwd,
			env,
			shell: false,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const kill = () => {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// the group is already gone
			}
		};
		if (signal.aborted) kill();
		else signal.addEventListener('abort', kill, { once: true });
		for (const stream of [child.stdout, child.stderr]) {
			let rest = '';
			stream.setEncoding('utf8');
			stream.on('data', (text) => {
				const lines = (rest + text).split('\n');
				rest = lines.pop();
				for (const line of lines) log(line);
			});
			stream.on('end', () => rest && log(rest));
		}
		child.on('error', (error) => {
			log(`could not run ${file}: ${error.code ?? error.message}`);
			resolve(127);
		});
		child.on('close', (code) => {
			signal.removeEventListener('abort', kill);
			if (signal.aborted) resolve('timeout');
			else resolve(code === null ? 'killed' : code);
		});
	});
}

async function composerTree({ dir, input, output, log, signal }) {
	const project = join(dir, 'project');
	await mkdir(project, { recursive: true });
	await mkdir(join(dir, 'home'), { recursive: true });
	for (const [file, args] of composerSteps(project, input, output)) {
		const result = await runCommand(file, args, {
			cwd: project,
			env: childEnv(dir),
			log,
			signal
		});
		if (result !== 0) return result;
	}
	return 0;
}

async function echoImport({ input, output }) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(input), hash);
	await writeFile(output, `${hash.digest('hex')}\n`);
	return 0;
}

const notBuilt =
	(kind) =>
	async ({ log }) => {
		log(`${kind} is not built`);
		return EXIT_NOT_BUILT;
	};

export const RUNNERS = {
	'composer-tree': composerTree,
	'template-build': notBuilt('template-build'),
	'echo-import': echoImport,
	'drupal-hop': notBuilt('drupal-hop')
};

async function readHead(request) {
	const chunks = request[Symbol.asyncIterator]();
	let held = Buffer.alloc(0);
	let at = -1;
	while (at < 0) {
		const { done, value } = await chunks.next();
		if (done) throw new Refusal(400, 'The job header is missing.');
		held = Buffer.concat([held, value]);
		at = held.indexOf(10);
		if (at < 0 && held.length > HEAD_LIMIT)
			throw new Refusal(400, 'The job header is too long.');
	}
	if (at > HEAD_LIMIT) throw new Refusal(400, 'The job header is too long.');
	let head;
	try {
		head = JSON.parse(held.subarray(0, at).toString('utf8'));
	} catch {
		throw new Refusal(400, 'The job header is not valid.');
	}
	const keys = head && typeof head === 'object' && !Array.isArray(head) ? Object.keys(head) : [];
	if (keys.length !== 1 || keys[0] !== 'kind' || !KINDS.includes(head.kind))
		throw new Refusal(400, 'The job header is not valid.');
	const left = held.subarray(at + 1);
	async function* rest() {
		if (left.length) yield left;
		for (;;) {
			const { done, value } = await chunks.next();
			if (done) return;
			yield value;
		}
	}
	return { kind: head.kind, body: Readable.from(rest()) };
}

function limited(limit) {
	let seen = 0;
	return new Transform({
		transform(chunk, _encoding, done) {
			seen += chunk.length;
			if (seen > limit) done(new Refusal(413, 'The job input is larger than the limit.'));
			else done(null, chunk);
		}
	});
}

function finish(response, status, headers, body) {
	response.writeHead(status, headers);
	if (body === null) {
		response.end();
		return Promise.resolve();
	}
	return pipeline(body, response).catch(() => undefined);
}

export function createRunner(options = {}) {
	const {
		runners = RUNNERS,
		root = tmpdir(),
		inputLimit = Number(process.env.JOB_INPUT_LIMIT ?? 0),
		outputLimit = Number(process.env.JOB_OUTPUT_LIMIT ?? 0),
		wallMs = Number(process.env.JOB_WALL_MS ?? 0),
		log = (line) => process.stderr.write(`${line}\n`)
	} = options;
	let busy = false;

	async function run(request, response) {
		const length = request.headers['content-length'];
		if (length !== undefined && Number(length) > inputLimit + HEAD_LIMIT)
			throw new Refusal(413, 'The job input is larger than the limit.');
		const dir = await mkdtemp(join(root, 'job-'));
		try {
			const { kind, body } = await readHead(request);
			const input = join(dir, 'input');
			const output = join(dir, 'output');
			await pipeline(body, limited(inputLimit), createWriteStream(input));

			const signal = AbortSignal.timeout(wallMs);
			const say = (line) => log(`[${kind}] ${line}`);
			let result;
			try {
				result = await runners[kind]({ dir, input, output, log: say, signal });
			} catch (error) {
				say(`runner error: ${error instanceof Error ? error.message : String(error)}`);
				result = 1;
			}
			if (result === 0 && signal.aborted) result = 'timeout';

			let size = 0;
			if (result === 0) {
				try {
					size = (await stat(output)).size;
				} catch {
					say('the job did not write a result');
					result = 1;
				}
				if (result === 0 && size > outputLimit) {
					say('the result is larger than the limit');
					result = EXIT_OUTPUT_TOO_LARGE;
				}
			}
			const headers = {
				'content-type': 'application/octet-stream',
				'content-length': result === 0 ? size : 0,
				[EXIT_HEADER]: String(result)
			};
			await finish(response, 200, headers, result === 0 ? createReadStream(output) : null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	return createServer({ requestTimeout: wallMs || 0 }, async (request, response) => {
		const refuse = (status, message) => {
			response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
			response.end(message);
		};
		try {
			const { pathname } = new URL(request.url ?? '/', 'http://container');
			if (pathname === '/health' && request.method === 'GET') {
				response.writeHead(200, { 'content-type': 'text/plain' });
				response.end('ok');
				return;
			}
			if (pathname !== '/run') return refuse(404, 'Not found');
			if (request.method !== 'POST') return refuse(405, 'Method not allowed');
			if (busy) return refuse(409, 'A job is already running.');
			busy = true;
			try {
				await run(request, response);
			} finally {
				busy = false;
			}
		} catch (error) {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof Refusal) return refuse(error.status, error.message);
			log(`server error: ${error instanceof Error ? error.message : String(error)}`);
			refuse(500, 'The runner failed.');
		}
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	createRunner().listen(8080, '0.0.0.0');
}
