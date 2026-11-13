export type UrlGuardCode =
	| 'invalid_url'
	| 'protocol'
	| 'credentials'
	| 'port'
	| 'ip_literal'
	| 'hostname'
	| 'non_public_address'
	| 'unresolvable'
	| 'redirect_limit'
	| 'too_large'
	| 'timeout';

export class UrlGuardError extends Error {
	readonly code: UrlGuardCode;

	constructor(code: UrlGuardCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'UrlGuardError';
	}
}

export interface FetchLimits {
	maxRedirects: number;
	maxBytes: number;
	timeoutMs: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
	maxRedirects: 3,
	maxBytes: 1_000_000,
	timeoutMs: 10_000
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Resolver = (hostname: string) => Promise<string[]>;

export interface GuardDeps {
	fetch: FetchLike;
	resolve: Resolver;
}

export interface GuardedResponse {
	url: string;
	status: number;
	body: Uint8Array;
}

type Octets = [number, number, number, number];

const DEFAULT_PORTS = new Map([
	['https:', 443],
	['http:', 80]
]);
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain'];
const IPV4_TEXT = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV4_DOTTED = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const ADDRESS_RECORD_TYPES = new Set([1, 28]);

export function checkUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new UrlGuardError('invalid_url', 'URL is not valid');
	}
	const defaultPort = DEFAULT_PORTS.get(url.protocol);
	if (defaultPort === undefined) {
		throw new UrlGuardError('protocol', 'Only http and https are allowed');
	}
	if (url.username || url.password) {
		throw new UrlGuardError('credentials', 'URL carries credentials');
	}
	const host = url.hostname;
	if (host.startsWith('[') || IPV4_TEXT.test(host)) {
		throw new UrlGuardError('ip_literal', 'IP literals are not allowed');
	}
	const port = url.port === '' ? defaultPort : Number(url.port);
	if (port !== defaultPort) throw new UrlGuardError('port', 'Only ports 443 and 80 are allowed');
	const name = host.endsWith('.') ? host.slice(0, -1) : host;
	// single-label names resolve through the local search path
	if (!name.includes('.') || BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
		throw new UrlGuardError('hostname', 'Host is not a public name');
	}
	return url;
}

export function isPublicAddress(ip: string): boolean {
	const v4 = parseIPv4(ip);
	if (v4) return isPublicIPv4(v4);
	const v6 = parseIPv6(ip);
	if (!v6) return false;
	const mapped = mappedIPv4(v6);
	if (mapped) return isPublicIPv4(mapped);
	return isPublicIPv6(v6);
}

function parseIPv4(text: string): Octets | undefined {
	const match = IPV4_DOTTED.exec(text);
	if (!match) return undefined;
	const octets: Octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
	return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPublicIPv4(octets: Octets): boolean {
	const [a, b, c] = octets;
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) {
		return false;
	}
	if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	return true;
}

// accepts the full form, compressed form and an embedded IPv4 tail
function parseIPv6(text: string): number[] | undefined {
	let source = text;
	if (source.includes('.')) {
		const cut = source.lastIndexOf(':');
		const v4 = cut < 0 ? undefined : parseIPv4(source.slice(cut + 1));
		if (!v4) return undefined;
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		source = `${source.slice(0, cut + 1)}${hi}:${lo}`;
	}
	const halves = source.split('::');
	if (halves.length > 2) return undefined;
	const [left = '', right] = halves;
	const head = parseGroups(left);
	if (!head) return undefined;
	if (right === undefined) return head.length === 8 ? head : undefined;
	const rest = parseGroups(right);
	if (!rest || head.length + rest.length > 7) return undefined;
	return [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
}

function parseGroups(part: string): number[] | undefined {
	if (part === '') return [];
	const pieces = part.split(':');
	if (!pieces.every((piece) => /^[0-9a-f]{1,4}$/i.test(piece))) return undefined;
	return pieces.map((piece) => parseInt(piece, 16));
}

function mappedIPv4(groups: number[]): Octets | undefined {
	const prefixIsZero = groups.slice(0, 5).every((group) => group === 0);
	if (!prefixIsZero || groups[5] !== 0xffff) return undefined;
	const [hi = 0, lo = 0] = groups.slice(6);
	return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPublicIPv6(groups: number[]): boolean {
	const [g0 = 0, g1 = 0] = groups;
	// only 2000::/3 is global unicast
	if ((g0 & 0xe000) !== 0x2000) return false;
	// teredo, benchmarking and documentation
	if (g0 === 0x2001 && (g1 < 0x0200 || g1 === 0x0db8)) return false;
	// 6to4 embeds an IPv4 address
	if (g0 === 0x2002) return false;
	if (g0 === 0x3fff && g1 < 0x1000) return false;
	return true;
}

export async function dohResolve(hostname: string, fetchFn: FetchLike = fetch): Promise<string[]> {
	const answers = await Promise.all(
		['A', 'AAAA'].map((type) => dohQuery(hostname, type, fetchFn))
	);
	return answers.flat();
}

interface DohAnswer {
	Status: number;
	Answer?: Array<{ type: number; data: string }>;
}

async function dohQuery(hostname: string, type: string, fetchFn: FetchLike): Promise<string[]> {
	const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
	const response = await fetchFn(url, { headers: { accept: 'application/dns-json' } });
	if (!response.ok) {
		throw new UrlGuardError('unresolvable', `DNS lookup failed with ${response.status}`);
	}
	const body = (await response.json()) as DohAnswer;
	if (body.Status !== 0) return [];
	return (body.Answer ?? [])
		.filter((answer) => ADDRESS_RECORD_TYPES.has(answer.type))
		.map((answer) => answer.data);
}

export async function guardedFetch(
	input: string,
	deps: GuardDeps,
	limits: FetchLimits = DEFAULT_FETCH_LIMITS
): Promise<GuardedResponse> {
	const clock = deadline(limits.timeoutMs);
	try {
		let target = checkUrl(input);
		for (let redirects = 0; ; redirects++) {
			await assertPublicHost(target.hostname, deps.resolve, clock);
			// fetch cannot pin the checked address, so a rebind can slip in between
			const response = await clock.race(
				deps.fetch(target.href, { redirect: 'manual', signal: clock.signal })
			);
			const location = response.headers.get('location');
			if (!REDIRECT_STATUS.has(response.status) || location === null) {
				const body = await readCapped(response, limits.maxBytes, clock);
				return { url: target.href, status: response.status, body };
			}
			if (redirects >= limits.maxRedirects) {
				throw new UrlGuardError('redirect_limit', 'Too many redirects');
			}
			void response.body?.cancel().catch(() => undefined);
			target = checkUrl(resolveLocation(location, target));
		}
	} finally {
		clock.clear();
	}
}

async function assertPublicHost(hostname: string, resolve: Resolver, clock: Clock): Promise<void> {
	let addresses: string[];
	try {
		addresses = await clock.race(resolve(hostname));
	} catch (error) {
		if (error instanceof UrlGuardError) throw error;
		throw new UrlGuardError('unresolvable', 'Host could not be resolved');
	}
	if (addresses.length === 0) throw new UrlGuardError('unresolvable', 'Host has no addresses');
	if (!addresses.every((address) => isPublicAddress(address))) {
		throw new UrlGuardError('non_public_address', 'Host resolves to a non-public address');
	}
}

function resolveLocation(location: string, from: URL): string {
	try {
		return new URL(location, from).href;
	} catch {
		throw new UrlGuardError('invalid_url', 'Redirect location is not a URL');
	}
}

async function readCapped(response: Response, maxBytes: number, clock: Clock): Promise<Uint8Array> {
	const declared = response.headers.get('content-length');
	if (declared !== null && Number(declared) > maxBytes) {
		void response.body?.cancel().catch(() => undefined);
		throw tooLarge();
	}
	if (!response.body) return new Uint8Array(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await clock.race(reader.read());
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) throw tooLarge();
			chunks.push(value);
		}
	} catch (error) {
		void reader.cancel().catch(() => undefined);
		throw error;
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

function tooLarge(): UrlGuardError {
	return new UrlGuardError('too_large', 'Response body is larger than the limit');
}

interface Clock {
	signal: AbortSignal;
	race<T>(work: Promise<T>): Promise<T>;
	clear(): void;
}

function deadline(ms: number): Clock {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new UrlGuardError('timeout', 'Request timed out'));
		}, ms);
	});
	expired.catch(() => undefined);
	return {
		signal: controller.signal,
		race: (work) => Promise.race([work, expired]),
		clear: () => {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
}
