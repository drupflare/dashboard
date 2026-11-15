const encoder = new TextEncoder();

export type Files = Record<string, string | Uint8Array>;

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0';

function header(name: string, size: number, flag: string, link = ''): Uint8Array {
	const block = new Uint8Array(512);
	const put = (text: string, at: number) => block.set(encoder.encode(text), at);
	put(name, 0);
	put(octal(0o644, 8), 100);
	put(octal(0, 8), 108);
	put(octal(0, 8), 116);
	put(octal(size, 12), 124);
	put(octal(0, 12), 136);
	put('        ', 148);
	put(flag, 156);
	put(link, 157);
	put('ustar\0', 257);
	put('00', 263);
	const sum = block.reduce((total, byte) => total + byte, 0);
	put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	return block;
}

export interface TarOptions {
	// an entry written as a symbolic link, by name
	symlinks?: string[];
}

export function tar(files: Files, options: TarOptions = {}): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const [name, content] of Object.entries(files)) {
		const bytes = typeof content === 'string' ? encoder.encode(content) : content;
		parts.push(header(name, bytes.byteLength, '0'));
		parts.push(bytes);
		const pad = (512 - (bytes.byteLength % 512)) % 512;
		if (pad > 0) parts.push(new Uint8Array(pad));
	}
	for (const name of options.symlinks ?? []) parts.push(header(name, 0, '2', 'target'));
	parts.push(new Uint8Array(1024));
	const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const compress = new CompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>;
	const stream = streamOf(bytes).pipeThrough(compress);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function tarGz(files: Files, options: TarOptions = {}): Promise<Uint8Array> {
	return gzip(tar(files, options));
}

export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	});

export const TODAY = '2026-11-14';

export const MAIN = 'export default { fetch() { return new Response("hello"); } };';

// a bundle that deploys: a built entry, one page and the bindings most Workers carry
export function goodFiles(overrides: Record<string, unknown> = {}, extra: Files = {}): Files {
	const config = {
		name: 'my-app',
		main: 'dist/index.js',
		compatibility_date: '2026-08-01',
		compatibility_flags: ['nodejs_compat'],
		// comments and a trailing comma are part of the format
		kv_namespaces: [{ binding: 'CACHE', id: 'x' }],
		r2_buckets: [{ binding: 'UPLOADS', bucket_name: 'x' }],
		vars: { GREETING: 'hello' },
		assets: { directory: 'dist/public' },
		...overrides
	};
	return {
		'wrangler.jsonc': `// built by the customer\n${JSON.stringify(config, null, 2).replace(/\n}$/, ',\n}')}`,
		'dist/index.js': MAIN,
		'dist/public/index.html': '<h1>hello</h1>',
		...extra
	};
}
