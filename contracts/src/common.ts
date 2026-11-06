import { z } from 'zod';

// #region ids

const idSchema = <P extends string>(prefix: P) =>
	z
		.string()
		.regex(new RegExp(`^${prefix}_[0-9a-z]{8,40}$`))
		.brand<P>();

export const userId = idSchema('usr');
export const orgId = idSchema('org');
export const siteId = idSchema('site');
export const operationId = idSchema('op');
export const nodeId = idSchema('nod');

export type UserId = z.infer<typeof userId>;
export type OrgId = z.infer<typeof orgId>;
export type SiteId = z.infer<typeof siteId>;
export type OperationId = z.infer<typeof operationId>;
export type NodeId = z.infer<typeof nodeId>;

export type IdPrefix = 'usr' | 'org' | 'site' | 'op' | 'nod';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function newId(prefix: IdPrefix): string {
	const bytes = crypto.getRandomValues(new Uint8Array(26));
	let body = '';
	for (const byte of bytes) body += ID_ALPHABET[byte & 31];
	return `${prefix}_${body}`;
}

// #endregion

// #region envelopes

export const isoTimestamp = z.iso.datetime();

export const errorEnvelope = z.object({
	code: z.string().min(1),
	message: z.string(),
	details: z.record(z.string(), z.unknown()),
	requestId: z.string()
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

export const pageSchema = <T extends z.ZodType>(item: T) =>
	z.object({
		items: z.array(item),
		nextCursor: z.string().min(1).nullable()
	});

export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export type Verified<T, C extends string> = { ok: true; value: T } | { ok: false; code: C };

export const COMMON_VERSION = { major: 1, minor: 0 } as const;

// #endregion

// #region canonical json

// keys sort by utf-16 code unit and numbers print as JSON.stringify does, which matches rfc 8785
// for the value ranges these contracts use
export function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) throw new TypeError('canonical json: non-finite number');
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value.map((item) => canonicalJson(item === undefined ? throwUndefined() : item)).join(',')}]`;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				throw new TypeError('canonical json: only plain objects');
			}
			const record = value as Record<string, unknown>;
			const parts: string[] = [];
			for (const key of Object.keys(record).sort()) {
				if (record[key] === undefined) continue;
				parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
			}
			return `{${parts.join(',')}}`;
		}
		default:
			throw new TypeError(`canonical json: unsupported ${typeof value}`);
	}
}

function throwUndefined(): never {
	throw new TypeError('canonical json: undefined in array');
}

// #endregion

// #region bytes and digests

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(encoder.encode(text));
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
		throw new TypeError('invalid base64url');
	}
	const padded =
		text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Digest(data: string | Uint8Array): Promise<string> {
	return `sha256:${await sha256Hex(data)}`;
}

// #endregion

// #region ed25519

export const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const publicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const PKCS8_ED25519_PREFIX = new Uint8Array([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

export type SigningKey = { privateKey: CryptoKey; publicKey: string };

export async function signingKeyFromSeed(seed: Uint8Array): Promise<SigningKey> {
	if (seed.length !== 32) throw new TypeError('ed25519 seed must be 32 bytes');
	const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
	pkcs8.set(PKCS8_ED25519_PREFIX);
	pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
	const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
	const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
	if (!jwk.x) throw new Error('ed25519 export returned no public key');
	return { privateKey, publicKey: jwk.x };
}

export function generateSigningKey(): Promise<SigningKey> {
	return signingKeyFromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

// the signed bytes are the context line, a newline and the canonical json, so a signature made for
// one contract never verifies under another
export function signingInput(context: string, value: unknown): string {
	return `${context}\n${canonicalJson(value)}`;
}

export async function signCanonical(
	context: string,
	value: unknown,
	privateKey: CryptoKey
): Promise<string> {
	const sig = await crypto.subtle.sign('Ed25519', privateKey, utf8(signingInput(context, value)));
	return toBase64Url(new Uint8Array(sig));
}

export async function verifyCanonical(
	context: string,
	value: unknown,
	sig: string,
	publicKey: string
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			fromBase64Url(publicKey),
			'Ed25519',
			false,
			['verify']
		);
		return await crypto.subtle.verify(
			'Ed25519',
			key,
			fromBase64Url(sig),
			utf8(signingInput(context, value))
		);
	} catch {
		return false;
	}
}

export async function publicKeyDigest(publicKey: string): Promise<string> {
	return sha256Digest(fromBase64Url(publicKey));
}

export function omitSig<T extends { sig: string }>(message: T): Omit<T, 'sig'> {
	const { sig: _sig, ...rest } = message;
	return rest;
}

// #endregion

// #region versions

export const CONTRACT_HEADER = 'Drupflare-Contract';

export const versionSchema = z.object({
	major: z.int().nonnegative(),
	minor: z.int().nonnegative()
});

export const versionRangeSchema = z.object({
	min: versionSchema,
	max: versionSchema
});

export type ContractVersion = z.infer<typeof versionSchema>;
export type VersionRange = z.infer<typeof versionRangeSchema>;

export const COMPAT_WINDOW = { minorReleases: 2, days: 180 } as const;

export type SupportPolicy = {
	current: ContractVersion;
	previous?: { major: number; lastMinor: number; supersededAt: string };
};

export type Negotiation =
	| { ok: true; version: ContractVersion }
	| {
			ok: false;
			status: 426;
			body: ErrorEnvelope & { details: { supported: VersionRange } };
	  };

export function compareVersions(a: ContractVersion, b: ContractVersion): number {
	return a.major - b.major || a.minor - b.minor;
}

export function formatVersion(version: ContractVersion): string {
	return `${version.major}.${version.minor}`;
}

export function parseVersion(text: string): ContractVersion | null {
	const match = /^(\d{1,4})\.(\d{1,5})$/.exec(text);
	return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export function formatRange(range: VersionRange): string {
	const min = formatVersion(range.min);
	const max = formatVersion(range.max);
	return min === max ? min : `${min}-${max}`;
}

export function parseRange(text: string): VersionRange | null {
	const [first, second, ...rest] = text.split('-');
	if (rest.length > 0 || first === undefined) return null;
	const min = parseVersion(first);
	const max = second === undefined ? min : parseVersion(second);
	if (!min || !max || compareVersions(min, max) > 0) return null;
	return { min, max };
}

export function formatContractHeader(contract: string, range: VersionRange): string {
	return `${contract}=${formatRange(range)}`;
}

export function parseContractHeader(
	value: string
): { contract: string; range: VersionRange } | null {
	const at = value.indexOf('=');
	if (at < 1) return null;
	const range = parseRange(value.slice(at + 1).trim());
	return range ? { contract: value.slice(0, at).trim(), range } : null;
}

// the previous major stays until both the minor count and the day count have run out
export function previousMajorInWindow(policy: SupportPolicy, now: Date): boolean {
	const previous = policy.previous;
	if (!previous || previous.major !== policy.current.major - 1) return false;
	const elapsedDays = (now.getTime() - Date.parse(previous.supersededAt)) / 86_400_000;
	return !(
		policy.current.minor >= COMPAT_WINDOW.minorReleases && elapsedDays >= COMPAT_WINDOW.days
	);
}

export function supportedRange(policy: SupportPolicy, now: Date): VersionRange {
	const min = previousMajorInWindow(policy, now)
		? { major: policy.current.major - 1, minor: 0 }
		: { major: policy.current.major, minor: 0 };
	return { min, max: policy.current };
}

export function negotiate(
	client: VersionRange,
	policy: SupportPolicy,
	opts: { now?: Date; requestId?: string } = {}
): Negotiation {
	const now = opts.now ?? new Date();
	const candidates: { min: ContractVersion; max: ContractVersion }[] = [
		{ min: { major: policy.current.major, minor: 0 }, max: policy.current }
	];
	if (previousMajorInWindow(policy, now) && policy.previous) {
		candidates.push({
			min: { major: policy.previous.major, minor: 0 },
			max: { major: policy.previous.major, minor: policy.previous.lastMinor }
		});
	}
	for (const server of candidates) {
		const low = compareVersions(client.min, server.min) > 0 ? client.min : server.min;
		const high = compareVersions(client.max, server.max) < 0 ? client.max : server.max;
		if (compareVersions(low, high) <= 0) return { ok: true, version: high };
	}
	const supported = supportedRange(policy, now);
	return {
		ok: false,
		status: 426,
		body: {
			code: 'contract_unsupported',
			message: `This server supports contract versions ${formatRange(supported)}.`,
			details: { supported },
			requestId: opts.requestId ?? ''
		}
	};
}

// #endregion

export const schemas = {
	errorEnvelope,
	versionRange: versionRangeSchema,
	digest: digestSchema,
	signature: signatureSchema,
	publicKey: publicKeySchema
};
