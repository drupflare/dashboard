import { ApiError } from '../../shared/errors';
import {
	PREFLIGHT_FAILURES,
	PREFLIGHT_REFUSALS,
	type PreflightFailure,
	type PreflightRefusal,
	type PreflightResult
} from '../../shared/preflight';
import {
	conclude,
	followUps,
	merge,
	readChangelog,
	readHome,
	readRobots,
	sameSite,
	type Page,
	type Reading
} from '../domain/preflight';
import {
	checkUrl,
	dohResolve,
	guardedFetch,
	UrlGuardError,
	type FetchLike,
	type GuardedResponse,
	type Resolver,
	type UrlGuardCode
} from '../integrations/url-guard';

// the whole run stops at 15 seconds and 1.5 MB; the home page may use 1 MB of that, and each of the
// three follow-up files reads at most its first 16 KB, where a version or a default file shows
export const PREFLIGHT_LIMITS = {
	totalMs: 15_000,
	totalBytes: 1_500_000,
	homeMs: 8_000,
	homeBytes: 1_000_000,
	followMs: 3_000,
	followBytes: 16_384,
	redirects: 3,
	minMs: 500
} as const;

export interface PreflightServices {
	fetch: FetchLike;
	resolve: Resolver;
	now: () => number;
	// the public page that says what the check sends; it goes in the User-Agent
	contactUrl: string;
}

let installed: PreflightServices = {
	fetch: (input, init) => fetch(input, init),
	resolve: (hostname) => dohResolve(hostname),
	now: Date.now,
	contactUrl: 'https://app.drupflare.com/migrate/preflight'
};
const production = installed;

export function setPreflightServices(over: Partial<PreflightServices>): void {
	installed = { ...installed, ...over };
}

export function resetPreflightServices(): void {
	installed = production;
}

export const preflightServices = (): PreflightServices => installed;

// #region guard codes

type Outcome = { refusal: PreflightRefusal } | { failure: PreflightFailure };

const CODES: Record<UrlGuardCode, Outcome> = {
	invalid_url: { refusal: 'invalid_url' },
	credentials: { refusal: 'invalid_url' },
	protocol: { refusal: 'protocol' },
	port: { refusal: 'port' },
	ip_literal: { refusal: 'ip_literal' },
	hostname: { refusal: 'non_public_address' },
	non_public_address: { refusal: 'non_public_address' },
	unresolvable: { failure: 'unresolvable' },
	redirect_limit: { failure: 'redirect_limit' },
	too_large: { failure: 'too_large' },
	timeout: { failure: 'timeout' }
};

const refuse = (reason: PreflightRefusal) =>
	new ApiError('unprocessable', PREFLIGHT_REFUSALS[reason], { reason });

function failed(url: string, reason: PreflightFailure): PreflightResult {
	return {
		url,
		reachable: false,
		cms: 'unknown',
		version: null,
		versionSource: null,
		hosting: null,
		signals: [],
		verdict: 'cannot tell',
		notes: [PREFLIGHT_FAILURES[reason]]
	};
}

// #endregion

const toPage = (response: GuardedResponse): Page => ({
	url: response.url,
	status: response.status,
	headers: Object.fromEntries(response.headers.entries()),
	body: new TextDecoder().decode(response.body)
});

export async function runPreflight(
	services: PreflightServices,
	input: string
): Promise<PreflightResult> {
	let entered: URL;
	try {
		entered = checkUrl(input);
	} catch (error) {
		if (!(error instanceof UrlGuardError)) throw error;
		const outcome = CODES[error.code];
		throw refuse('refusal' in outcome ? outcome.refusal : 'invalid_url');
	}

	const userAgent = `Drupflare-Preflight/1 (+${services.contactUrl}; support@drupflare.com)`;
	let sawRedirect = false;
	// the request carries a User-Agent and an Accept header, and nothing else
	const send: FetchLike = async (url, init) => {
		const response = await services.fetch(url, {
			...init,
			headers: { 'user-agent': userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' }
		});
		if (response.status >= 300 && response.status < 400) sawRedirect = true;
		return response;
	};

	const started = services.now();
	const left = () => PREFLIGHT_LIMITS.totalMs - (services.now() - started);

	let home: GuardedResponse;
	try {
		home = await guardedFetch(
			entered.href,
			{ fetch: send, resolve: services.resolve, follow: (from, to) => sameSite(from, to) },
			{
				maxRedirects: PREFLIGHT_LIMITS.redirects,
				maxBytes: PREFLIGHT_LIMITS.homeBytes,
				timeoutMs: Math.min(PREFLIGHT_LIMITS.homeMs, left())
			}
		);
	} catch (error) {
		if (!(error instanceof UrlGuardError)) throw error;
		const outcome = CODES[error.code];
		if ('failure' in outcome) return failed(entered.href, outcome.failure);
		if (sawRedirect) return failed(entered.href, 'redirect_refused');
		throw refuse(outcome.refusal);
	}

	const page = toPage(home);
	let reading: Reading = readHome(page);
	if (page.url !== entered.href) {
		reading.signals.push({ kind: 'redirect', detail: `The address redirects to ${page.url}.` });
	}
	if (home.redirect) {
		const detail = `The address redirects to ${clipHost(home.redirect)}, a different domain. The check stopped there.`;
		reading.signals.push({ kind: 'redirect', detail });
		return conclude({ url: page.url, reading });
	}

	let used = home.body.byteLength;
	const origin = new URL(page.url).origin;
	const probe = async (path: string): Promise<Page | null> => {
		const room = PREFLIGHT_LIMITS.totalBytes - used;
		if (left() < PREFLIGHT_LIMITS.minMs || room <= 0) return null;
		try {
			const response = await guardedFetch(
				`${origin}${path}`,
				{ fetch: send, resolve: services.resolve },
				{
					maxRedirects: 0,
					maxBytes: Math.min(PREFLIGHT_LIMITS.followBytes, room),
					timeoutMs: Math.min(PREFLIGHT_LIMITS.followMs, left()),
					truncate: true
				}
			);
			used += response.body.byteLength;
			return toPage(response);
		} catch {
			return null;
		}
	};

	if (followUps(reading).core) {
		const file = await probe('/core/CHANGELOG.txt');
		if (file) reading = merge([reading, readChangelog(file.url, file.status, file.body, true)]);
	}
	if (followUps(reading).root) {
		const file = await probe('/CHANGELOG.txt');
		if (file)
			reading = merge([reading, readChangelog(file.url, file.status, file.body, false)]);
	}
	if (followUps(reading).robots) {
		const file = await probe('/robots.txt');
		if (file) reading = merge([reading, readRobots(file.status, file.body)]);
	}
	return conclude({ url: page.url, reading });
}

const clipHost = (url: URL): string => url.hostname.slice(0, 80) || 'another address';
