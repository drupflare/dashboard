const encoder = new TextEncoder();

const ALPHABET = encoder.encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
const PAD = 61;

// a multiple of 3, so every slice but the last encodes without padding
const SLICE = 48 * 1024;

export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

export function base64Encode(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(base64Length(source.byteLength));
	let at = 0;
	let i = 0;
	for (; i + 2 < source.byteLength; i += 3) {
		const n = (source[i]! << 16) | (source[i + 1]! << 8) | source[i + 2]!;
		out[at++] = ALPHABET[n >> 18]!;
		out[at++] = ALPHABET[(n >> 12) & 63]!;
		out[at++] = ALPHABET[(n >> 6) & 63]!;
		out[at++] = ALPHABET[n & 63]!;
	}
	const left = source.byteLength - i;
	if (left === 1) {
		const n = source[i]! << 16;
		out[at++] = ALPHABET[n >> 18]!;
		out[at++] = ALPHABET[(n >> 12) & 63]!;
		out[at++] = PAD;
		out[at++] = PAD;
	} else if (left === 2) {
		const n = (source[i]! << 16) | (source[i + 1]! << 8);
		out[at++] = ALPHABET[n >> 18]!;
		out[at++] = ALPHABET[(n >> 12) & 63]!;
		out[at++] = ALPHABET[(n >> 6) & 63]!;
		out[at++] = PAD;
	}
	return out;
}

export interface BodyPart {
	name: string;
	filename?: string;
	contentType?: string;
	bytes: Uint8Array;
	base64?: boolean;
}

export interface MultipartBody {
	contentType: string;
	length: number;
	body: ReadableStream<Uint8Array>;
}

// the escapes the form-data encoding gives a quote and a line break in a name
const field = (value: string) =>
	value.replaceAll('"', '%22').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const head = (boundary: string, part: BodyPart) =>
	encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="${field(part.name)}"` +
			(part.filename === undefined ? '' : `; filename="${field(part.filename)}"`) +
			`\r\n${part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`}\r\n`
	);

const CRLF = encoder.encode('\r\n');

// written a slice at a time so the body never sits in memory twice; the upload APIs refuse a
// chunked body, so the length is worked out here and a FixedLengthStream carries it
export function multipartBody(
	parts: readonly BodyPart[],
	boundary = `----drupflare${crypto.randomUUID().replaceAll('-', '')}`
): MultipartBody {
	const heads = parts.map((part) => head(boundary, part));
	const tail = encoder.encode(`--${boundary}--\r\n`);
	const payload = parts.map((part) =>
		part.base64 === true ? base64Length(part.bytes.byteLength) : part.bytes.byteLength
	);
	const length =
		heads.reduce((sum, h) => sum + h.byteLength, 0) +
		payload.reduce((sum, n) => sum + n, 0) +
		parts.length * CRLF.byteLength +
		tail.byteLength;

	let part = 0;
	let offset = 0;
	let started = false;
	const source = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (part >= parts.length) {
				controller.enqueue(tail);
				controller.close();
				return;
			}
			const current = parts[part]!;
			if (!started) {
				started = true;
				controller.enqueue(heads[part]!);
				return;
			}
			if (offset < current.bytes.byteLength) {
				const slice = current.bytes.subarray(offset, offset + SLICE);
				offset += slice.byteLength;
				controller.enqueue(current.base64 === true ? base64Encode(slice) : slice);
				return;
			}
			controller.enqueue(CRLF);
			part++;
			offset = 0;
			started = false;
		}
	});

	const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream })
		.FixedLengthStream;
	let body: ReadableStream<Uint8Array> = source;
	if (Fixed !== undefined) {
		const fixed = new Fixed(length) as TransformStream<Uint8Array, Uint8Array>;
		body = source.pipeThrough(fixed);
	}
	return { contentType: `multipart/form-data; boundary=${boundary}`, length, body };
}
