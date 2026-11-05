import { z } from 'zod';
import { isoTimestamp, orgId, siteId, type SiteId } from './common';

export const SITES_VERSION = { major: 1, minor: 0 } as const;

export const SITE_KINDS = ['drupal', 'nuxtpress', 'smoke', 'mylora', 'custom'] as const;
export const SITE_PLANES = ['managed', 'self-managed', 'self-hosted'] as const;
export const SITE_STATES = [
	'active',
	'suspended',
	'tombstoned',
	'purge-eligible',
	'deleted'
] as const;
export const SITE_RINGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;

export const siteKind = z.enum(SITE_KINDS);
export const sitePlane = z.enum(SITE_PLANES);
export const siteState = z.enum(SITE_STATES);
export const siteRing = z.enum(SITE_RINGS);

export const hostname = z
	.string()
	.max(253)
	.regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export const siteSchema = z.object({
	id: siteId,
	orgId,
	name: z.string().min(1).max(100),
	kind: siteKind,
	plane: sitePlane,
	state: siteState,
	ring: siteRing,
	primaryHostname: hostname.nullable(),
	hostnames: z.array(hostname),
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp
});

export type Site = z.infer<typeof siteSchema>;

export function scriptName(id: SiteId | string): string {
	return `s-${id}`;
}

export const schemas = { site: siteSchema };
