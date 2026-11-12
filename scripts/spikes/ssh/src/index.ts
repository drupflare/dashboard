import { connect, type SshSession } from 'edgeport/ssh';
import { runSurvey } from '../../../../../drangler/src/migrate/survey';
import type { Transport } from '../../../../../drangler/src/migrate/transport';

interface Body {
	host: string;
	connectHost?: string;
	port: number;
	user: string;
	privateKey: string;
	root: string;
	command?: string;
}

class EdgeportTransport implements Transport {
	readonly label: string;
	private session: SshSession | null = null;

	constructor(private readonly body: Body) {
		this.label = `${body.user}@${body.host}:${body.port}`;
	}

	private async open(): Promise<SshSession> {
		this.session ??= await connect({
			hostname: this.body.connectHost ?? this.body.host,
			port: this.body.port,
			username: this.body.user,
			privateKey: { pem: this.body.privateKey },
			timeoutMs: 15_000
		});
		return this.session;
	}

	async exec(command: string) {
		const result = await (await this.open()).exec(command);
		return { code: result.code, stdout: result.stdoutText, stderr: result.stderrText };
	}

	async download(): Promise<never> {
		throw new Error('not used by the survey');
	}

	async close() {
		await this.session?.close();
	}
}

async function survey(body: Body) {
	const transport = new EdgeportTransport(body);
	const started = Date.now();
	try {
		const result = await runSurvey({ transport, now: () => new Date(0) }, body.host, body.root);
		return { ms: Date.now() - started, survey: result };
	} finally {
		await transport.close();
	}
}

async function stream(body: Body) {
	const session = await connect({
		hostname: body.connectHost ?? body.host,
		port: body.port,
		username: body.user,
		privateKey: { pem: body.privateKey },
		timeoutMs: 15_000
	});
	const started = Date.now();
	let bytes = 0;
	let chunks = 0;
	let firstByteMs: number | null = null;
	try {
		const channel = await session.execStream(body.command ?? '');
		const reader = channel.stdout.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (firstByteMs === null) firstByteMs = Date.now() - started;
			bytes += value.byteLength;
			chunks += 1;
		}
		const exit = await channel.exit;
		return { bytes, chunks, firstByteMs, ms: Date.now() - started, exit };
	} finally {
		await session.close();
	}
}

interface Env {
	SPIKE_TOKEN?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function authorized(request: Request, env: Env): boolean {
	if (!env.SPIKE_TOKEN) return false;
	const given = new TextEncoder().encode(request.headers.get('authorization') ?? '');
	const want = new TextEncoder().encode(`Bearer ${env.SPIKE_TOKEN}`);
	if (given.length !== want.length) return false;
	let diff = 0;
	for (let i = 0; i < given.length; i++) diff |= given[i]! ^ want[i]!;
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (!authorized(request, env)) return new Response('no', { status: 401 });
		if (request.method !== 'POST') return new Response('post only', { status: 405 });
		const body = (await request.json()) as Body;
		if (!LOOPBACK.has(body.connectHost ?? body.host))
			return new Response('loopback only', { status: 403 });
		try {
			const out = url.pathname === '/stream' ? await stream(body) : await survey(body);
			return Response.json(out);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof Error ? `${error.name}: ${error.message}` : String(error)
				},
				{ status: 500 }
			);
		}
	}
};
