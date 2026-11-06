import type { KVNamespace } from '@cloudflare/workers-types';
import { normalizeHost, resolveRoute } from '../../../dispatch/src/route';
import type { HostRoute } from '../ports';
import { PermanentError } from '../step';

export interface Hosts {
	put(host: string, route: HostRoute): Promise<void>;
	deleteIfOwned(host: string, siteId: string): Promise<'deleted' | 'absent' | 'foreign'>;
}

// the exact shape dispatch/src/route.ts parses: a strict object with a version
export function hostValue(route: HostRoute): string {
	return JSON.stringify({
		v: 1,
		siteId: route.siteId,
		script: route.script,
		epoch: route.epoch
	});
}

function keyOf(host: string): string {
	const key = normalizeHost(host);
	if (key === null) throw new PermanentError('invalid_host', `${host} is not a hostname`);
	return key;
}

// a value the dispatch parser would refuse is never written, so a bad route fails here and not as a 404
export function hostsOf(kv: Pick<KVNamespace, 'get' | 'put' | 'delete'>): Hosts {
	return {
		async put(host, route) {
			const key = keyOf(host);
			const value = hostValue(route);
			const parsed = resolveRoute(key, value);
			if (!parsed.ok) {
				throw new PermanentError(
					'invalid_route',
					`the route for ${key} would not parse: ${parsed.code}`
				);
			}
			await kv.put(key, value);
		},
		// a value that does not parse is not provably ours, so it counts as foreign
		// ponytail: get then delete is not atomic, so a repoint between them can still be deleted
		async deleteIfOwned(host, siteId) {
			const key = keyOf(host);
			const raw = await kv.get(key);
			if (raw === null) return 'absent';
			const parsed = resolveRoute(key, raw);
			if (!parsed.ok || parsed.value.siteId !== siteId) return 'foreign';
			await kv.delete(key);
			return 'deleted';
		}
	};
}
