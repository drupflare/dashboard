import { checkUrl, isPublicAddress, UrlGuardError, type Resolver } from '../url-guard';
import { ProviderError, type ProviderFetch } from './index';

const TIMEOUT_MS = 10_000;

const DENIED = 'The host address must be a public https name';
const PRIVATE = 'The host resolves to a private address, so it was refused';
const UNRESOLVED = 'The host name could not be resolved';

// checks one URL before a request leaves the dashboard; every provider call passes through here
export async function publicHost(input: string, resolve: Resolver): Promise<URL> {
	let url: URL;
	try {
		url = checkUrl(input);
	} catch (error) {
		if (error instanceof UrlGuardError) throw new ProviderError(DENIED);
		throw error;
	}
	// checkUrl also allows http, which a token must never travel over
	if (url.protocol !== 'https:') throw new ProviderError(DENIED);
	let addresses: string[];
	try {
		addresses = await resolve(url.hostname);
	} catch {
		throw new ProviderError(UNRESOLVED);
	}
	if (addresses.length === 0) throw new ProviderError(UNRESOLVED);
	if (!addresses.every((address) => isPublicAddress(address))) throw new ProviderError(PRIVATE);
	return url;
}

// the token goes with every call, so the guard runs on each one and never follows a redirect
export function guardedProviderFetch(deps: {
	fetch: ProviderFetch;
	resolve: Resolver;
}): ProviderFetch {
	return async (input, init) => {
		const url = await publicHost(input, deps.resolve);
		const response = await deps.fetch(url.href, {
			...init,
			redirect: 'manual',
			signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS)
		});
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => undefined);
			throw new ProviderError('The host redirected the request, so it was refused');
		}
		return response;
	};
}
