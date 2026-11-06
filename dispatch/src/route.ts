import { siteId, type Verified } from '@contracts/common';
import { z } from 'zod';

export const routeSchema = z
	.object({
		v: z.literal(1),
		siteId,
		script: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
		epoch: z.int().nonnegative()
	})
	.strict();

export type Route = { siteId: string; script: string; epoch: number };
export type RouteRefusal = 'unknown_host' | 'malformed_route';

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHost(host: string): string | null {
	const name = host.toLowerCase().replace(/\.$/, '');
	return name.length > 0 && name.length <= 253 && HOST.test(name) ? name : null;
}

// a route is a hint: it names the site and the epoch to check a lease against and authorizes nothing
export function resolveRoute(host: string, raw: string | null): Verified<Route, RouteRefusal> {
	if (normalizeHost(host) === null || raw === null) return { ok: false, code: 'unknown_host' };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return { ok: false, code: 'malformed_route' };
	}
	const parsed = routeSchema.safeParse(json);
	if (!parsed.success) return { ok: false, code: 'malformed_route' };
	const { siteId: id, script, epoch } = parsed.data;
	return { ok: true, value: { siteId: id, script, epoch } };
}
