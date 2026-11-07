import { z } from 'zod';
import { isoTimestamp, orgId, siteId, type SiteId } from './common';

export const SITES_VERSION = { major: 1, minor: 1 } as const;

export const SITE_KINDS = ['drupal', 'nuxtpress', 'smoke', 'mylora', 'custom'] as const;
export const SITE_CATEGORIES = ['cms', 'workers'] as const;
export const SITE_CONFIGS = ['managed', 'canonical'] as const;
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
export const siteCategory = z.enum(SITE_CATEGORIES);
export const siteConfig = z.enum(SITE_CONFIGS);
export const sitePlane = z.enum(SITE_PLANES);
export const siteState = z.enum(SITE_STATES);
export const siteRing = z.enum(SITE_RINGS);

export const hostname = z
	.string()
	.max(253)
	.regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

export const cloudflareAccountId = z.string().regex(/^[0-9a-f]{32}$/);

export type SiteKind = z.infer<typeof siteKind>;
export type SiteCategory = z.infer<typeof siteCategory>;
export type SiteConfig = z.infer<typeof siteConfig>;
export type SitePlane = z.infer<typeof sitePlane>;
export type SiteRing = z.infer<typeof siteRing>;

export function categoryOfKind(kind: SiteKind): SiteCategory {
	return kind === 'drupal' ? 'cms' : 'workers';
}

// a 1.0 document has no category, config or accountId, and one from before releases has no release;
// each gets the value such a site had
function withSiteDefaults(input: unknown): unknown {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
	const doc = input as Record<string, unknown>;
	const kind = siteKind.safeParse(doc.kind);
	return {
		category: kind.success ? categoryOfKind(kind.data) : undefined,
		config: 'canonical',
		accountId: null,
		release: { current: null, available: null },
		...doc
	};
}

const siteObject = z.object({
	id: siteId,
	orgId,
	name: z.string().min(1).max(100),
	kind: siteKind,
	category: siteCategory,
	plane: sitePlane,
	config: siteConfig,
	accountId: cloudflareAccountId.nullable(),
	state: siteState,
	ring: siteRing,
	primaryHostname: hostname.nullable(),
	hostnames: z.array(hostname),
	release: z.object({ current: z.string().nullable(), available: z.string().nullable() }),
	createdAt: isoTimestamp,
	updatedAt: isoTimestamp
});

export const siteSchema = z.preprocess(
	withSiteDefaults,
	siteObject.refine((site) => site.category === categoryOfKind(site.kind), {
		message: 'category does not match kind',
		path: ['category']
	})
);

export type Site = z.infer<typeof siteObject>;

const SITE_PREFIX = 'site_';

// the id's underscore is not allowed in a Worker name, so the name carries the id body only
export function scriptName(id: SiteId | string): string {
	return `s-${id.startsWith(SITE_PREFIX) ? id.slice(SITE_PREFIX.length) : id}`;
}

export function siteIdFromScript(name: string): SiteId | null {
	const match = /^s-([0-9a-z]{8,40})$/.exec(name);
	return match ? siteId.parse(`${SITE_PREFIX}${match[1]}`) : null;
}

export const schemas = { site: siteSchema };
