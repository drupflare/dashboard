import type { KvLike, MirrorDeps } from '../../../../src/server/services/doc-mirror';

const enc = new TextEncoder();
export function header(name: string, size: number, type = '0'): Uint8Array {
	const block = new Uint8Array(512);
	const put = (text: string, at: number) => block.set(enc.encode(text), at);
	put(name, 0);
	put('0000644\0', 100);
	put(`${size.toString(8).padStart(11, '0')}\0`, 124);
	put(type, 156);
	put('ustar\0', 257);
	put('00', 263);
	return block;
}

export interface Member {
	name: string;
	body?: Uint8Array | string;
	type?: string;
}

export function tar(sha: string | null, members: Member[]): Uint8Array {
	const parts: Uint8Array[] = [];
	const add = (name: string, body: Uint8Array, type?: string) => {
		parts.push(header(name, body.length, type));
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		if (body.length) parts.push(padded);
	};
	if (sha) add('pax_global_header', enc.encode(`52 comment=${sha}\n`), 'g');
	for (const m of members) {
		const body =
			typeof m.body === 'string' ? enc.encode(m.body) : (m.body ?? new Uint8Array(0));
		add(m.name, body, m.type);
	}
	parts.push(new Uint8Array(1024));
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

export const docsRepo = (top = 'worker-master'): Member[] => [
	{ name: `${top}/`, type: '5' },
	{ name: `${top}/README.md`, body: '# Home\n\nSee [start](docs/getting-started/index.md).' },
	{ name: `${top}/docs/README.md`, body: '# repository map' },
	{
		name: `${top}/docs/getting-started/index.md`,
		body: '# Getting Started\n\n![logo](../img/x.png) [next](install.md)'
	},
	{ name: `${top}/docs/getting-started/install.md`, body: '# Install\n\n## Steps\n\ntext' },
	{ name: `${top}/docs/operating/index.md`, body: '# Operating\n\ntext' },
	{ name: `${top}/docs/img/x.png`, body: PNG },
	{ name: `${top}/docs/logo.svg`, body: '<svg onload="alert(1)"></svg>' },
	{ name: `${top}/src/index.ts`, body: 'export {}' }
];

export function memoryKv() {
	const store = new Map<string, string | ArrayBuffer>();
	const kv: KvLike = {
		async get(key, type) {
			const value = store.get(key);
			if (value === undefined) return null;
			if (type === 'json') return JSON.parse(value as string);
			return value;
		},
		async put(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		},
		async list({ prefix }) {
			return {
				keys: [...store.keys()]
					.filter((k) => k.startsWith(prefix))
					.map((name) => ({ name })),
				list_complete: true
			};
		}
	};
	return { kv, store };
}

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function harness(handler: Handler, start = 1_000_000) {
	const { kv, store } = memoryKv();
	const calls: { url: string; init?: RequestInit }[] = [];
	let clock = start;
	const deps: MirrorDeps = {
		kv,
		fetch: async (url, init) => {
			calls.push({ url, init });
			// workerd throws on redirect: 'error'; only 'follow' and 'manual' exist at the edge
			if (
				init?.redirect !== undefined &&
				init.redirect !== 'follow' &&
				init.redirect !== 'manual'
			) {
				throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
			}
			return handler(url, init);
		},
		now: () => clock
	};
	return {
		deps,
		store,
		calls,
		advance: (ms: number) => (clock += ms),
		set now(value: number) {
			clock = value;
		}
	};
}

export async function archive(sha: string | null, members: Member[]) {
	return gzip(tar(sha, members));
}

export const ok = (body: Uint8Array, etag = '"e1"') =>
	new Response(body as BodyInit, { status: 200, headers: { etag } });
