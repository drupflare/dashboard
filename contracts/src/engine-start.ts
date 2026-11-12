import { z } from 'zod';

export const START_CONTEXT = 'drupflare.engine.start.v1';
export const START_WINDOW_MS = 300_000;
export const MAX_START_BYTES = 262_144;

export const START_HEADERS = {
	timestamp: 'x-drupflare-timestamp',
	id: 'x-drupflare-id',
	signature: 'x-drupflare-signature'
} as const;

export const START_REFUSALS = [
	'unsigned',
	'malformed',
	'stale',
	'bad_signature',
	'too_large',
	'wrong_method',
	'unknown_path',
	'unknown_workflow',
	'replayed',
	'unconfigured'
] as const;
export type StartRefusal = (typeof START_REFUSALS)[number];

export const START_REFUSAL_STATUS: Record<StartRefusal, number> = {
	unsigned: 401,
	malformed: 400,
	stale: 401,
	bad_signature: 401,
	too_large: 413,
	wrong_method: 405,
	unknown_path: 404,
	unknown_workflow: 400,
	replayed: 409,
	unconfigured: 500
};

export const WORKFLOW_NAMES = [
	'site-create',
	'site-upgrade',
	'site-delete',
	'site-purge',
	'site-cleanup',
	'site-adopt',
	'backup-create',
	'backup-restore'
] as const;
export type WorkflowName = (typeof WORKFLOW_NAMES)[number];

const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const startIdPattern = ID;

export const startBodySchema = z
	.object({
		workflow: z.string(),
		params: z.record(z.string(), z.unknown())
	})
	.strict();

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array<ArrayBuffer> | null => {
	if (!/^(?:[0-9a-f]{2})+$/.test(text)) return null;
	const bytes = new Uint8Array(text.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
	return bytes;
};

export const MIN_SECRET_LENGTH = 32;

// an unset binding reaches here as undefined and would otherwise sign as the text "undefined"
export const secretUsable = (secret: unknown): secret is string =>
	typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;

function hmacKey(secret: string, usages: ('sign' | 'verify')[]) {
	if (!secretUsable(secret))
		throw new Error(`the start secret needs ${MIN_SECRET_LENGTH} characters`);
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		usages
	);
}

// the time and the id are part of what is signed, so neither can be swapped on a captured request
const signedText = (timestamp: string, id: string, body: string) =>
	`${START_CONTEXT}\n${timestamp}\n${id}\n${body}`;

export async function signStart(
	body: string,
	options: { secret: string; now: number; id: string }
): Promise<Record<string, string>> {
	const timestamp = String(options.now);
	const key = await hmacKey(options.secret, ['sign']);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(signedText(timestamp, options.id, body))
	);
	return {
		[START_HEADERS.timestamp]: timestamp,
		[START_HEADERS.id]: options.id,
		[START_HEADERS.signature]: hex(mac)
	};
}

export type Started = { workflow: WorkflowName; id: string; params: Record<string, unknown> };
export type StartVerdict = { ok: true; value: Started } | { ok: false; code: StartRefusal };

// checks the signature before it reads the body as anything but bytes
export async function verifyStart(
	headers: { get(name: string): string | null },
	body: string,
	options: { secret: string; now: number }
): Promise<StartVerdict> {
	const timestamp = headers.get(START_HEADERS.timestamp);
	const id = headers.get(START_HEADERS.id);
	const signature = headers.get(START_HEADERS.signature);
	if (timestamp === null || id === null || signature === null) {
		return { ok: false, code: 'unsigned' };
	}
	const signed = unhex(signature);
	if (signed === null || !/^\d{1,16}$/.test(timestamp) || !ID.test(id)) {
		return { ok: false, code: 'malformed' };
	}
	const key = await hmacKey(options.secret, ['verify']);
	// verify compares in constant time
	const valid = await crypto.subtle.verify(
		'HMAC',
		key,
		signed,
		encoder.encode(signedText(timestamp, id, body))
	);
	if (!valid) return { ok: false, code: 'bad_signature' };
	if (Math.abs(options.now - Number(timestamp)) > START_WINDOW_MS) {
		return { ok: false, code: 'stale' };
	}
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return { ok: false, code: 'malformed' };
	}
	const parsed = startBodySchema.safeParse(json);
	if (!parsed.success) return { ok: false, code: 'malformed' };
	const { workflow, params } = parsed.data;
	if (!(WORKFLOW_NAMES as readonly string[]).includes(workflow)) {
		return { ok: false, code: 'unknown_workflow' };
	}
	return { ok: true, value: { workflow: workflow as WorkflowName, id, params } };
}
