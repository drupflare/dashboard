interface RunnerStub {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface Env {
	SPIKE_TOKEN?: string;
	JOB_RUNNER: { getByName(name: string): RunnerStub };
}

const encoder = new TextEncoder();

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

// both sides are hashed first, so the compare runs over equal lengths
export async function tokenMatches(header: string | null, token: string): Promise<boolean> {
	const given = /^Bearer (.+)$/.exec(header ?? '')?.[1];
	if (given === undefined) return false;
	const [a, b] = await Promise.all([digest(given), digest(token)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!env.SPIKE_TOKEN) return new Response('Not configured', { status: 500 });
		if (!(await tokenMatches(request.headers.get('authorization'), env.SPIKE_TOKEN)))
			return new Response('Unauthorized', {
				status: 401,
				headers: { 'www-authenticate': 'Bearer' }
			});

		const url = new URL(request.url);
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
		if (url.pathname !== '/run' && url.pathname !== '/destroy')
			return new Response('Not found', { status: 404 });

		const runner = env.JOB_RUNNER.getByName(url.searchParams.get('name') ?? 'spike');
		if (url.pathname === '/destroy')
			return runner.fetch('http://runner/destroy', { method: 'POST' });

		const kind = url.searchParams.get('kind') ?? '';
		const key = url.searchParams.get('key') ?? `spike/${kind}/${crypto.randomUUID()}`;
		const headers = new Headers();
		const length = request.headers.get('content-length');
		if (length !== null) headers.set('x-input-bytes', length);
		return runner.fetch(`http://runner/run?${new URLSearchParams({ kind, key })}`, {
			method: 'POST',
			headers,
			body: request.body
		});
	}
};
