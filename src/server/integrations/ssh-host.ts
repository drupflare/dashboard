import { isPublicAddress, type Resolver } from './url-guard';

const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local', '.localdomain'];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export type DialAddress =
	{ ok: true; address: string } | { ok: false; reason: 'host_private' | 'host_unresolved' };

// the address to dial for a server name, or why none is allowed. Every address a name resolves
// to has to be public, and the caller dials the one returned here and not the name, so a name
// that answers differently on a second lookup cannot change where the connection goes
export async function publicAddressOf(host: string, resolve: Resolver): Promise<DialAddress> {
	if (IPV4.test(host) || host.includes(':')) {
		return isPublicAddress(host)
			? { ok: true, address: host }
			: { ok: false, reason: 'host_private' };
	}
	const name = host.toLowerCase();
	if (BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
		return { ok: false, reason: 'host_private' };
	}
	let addresses: string[];
	try {
		addresses = await resolve(name);
	} catch (error) {
		// a resolver that is not installed is not a name that failed to resolve
		if ((error as { code?: unknown } | null)?.code === 'not_built') throw error;
		return { ok: false, reason: 'host_unresolved' };
	}
	const first = addresses[0];
	if (first === undefined) return { ok: false, reason: 'host_unresolved' };
	if (!addresses.every((address) => isPublicAddress(address))) {
		return { ok: false, reason: 'host_private' };
	}
	return { ok: true, address: first };
}
