import { z } from 'zod';

export const SUPPORT_GRANT_SCOPES = ['read-metadata', 'act'] as const;
export type SupportGrantScope = (typeof SUPPORT_GRANT_SCOPES)[number];

export const SUPPORT_GRANT_SCOPE_LABELS: Record<SupportGrantScope, string> = {
	'read-metadata': 'Read Metadata',
	act: 'Act on the Organization'
};

export const SUPPORT_GRANT_SCOPE_TEXT: Record<SupportGrantScope, string> = {
	'read-metadata':
		'Support can see the organization, its sites and its settings. Support cannot change anything or read site content.',
	act: 'Support can also change settings and run operations for you. Support still cannot read site content.'
};

const DAY_MS = 24 * 60 * 60 * 1000;

// unreviewed: the longest a grant may last
export const SUPPORT_GRANT_MAX_MS = 7 * DAY_MS;
export const SUPPORT_GRANT_MIN_MS = 60 * 60 * 1000;
// unreviewed: how long break-glass access lasts
export const BREAK_GLASS_MS = 60 * 60 * 1000;
// unreviewed: break-glass starts one admin may make in a day
export const BREAK_GLASS_MAX_PER_DAY = 3;
export const BREAK_GLASS_DAY_MS = DAY_MS;
export const BREAK_GLASS_REASON_MIN = 10;
export const BREAK_GLASS_REASON_MAX = 500;

export const supportGrantView = z.object({
	id: z.string(),
	organizationId: z.string(),
	grantedBy: z.string(),
	scope: z.enum(SUPPORT_GRANT_SCOPES),
	reason: z.string(),
	createdAt: z.number(),
	expiresAt: z.number(),
	revokedAt: z.number().nullable(),
	live: z.boolean()
});
export type SupportGrantView = z.infer<typeof supportGrantView>;

export const supportGrantBody = z.strictObject({
	scope: z.enum(SUPPORT_GRANT_SCOPES),
	hours: z
		.number()
		.int()
		.min(SUPPORT_GRANT_MIN_MS / 3_600_000)
		.max(SUPPORT_GRANT_MAX_MS / 3_600_000),
	reason: z.string().trim().min(1).max(500)
});

export const breakGlassBody = z.strictObject({
	organizationId: z.string().min(1).max(128),
	reason: z.string().trim().min(BREAK_GLASS_REASON_MIN).max(BREAK_GLASS_REASON_MAX)
});

export const breakGlassView = z.object({
	id: z.string(),
	organizationId: z.string(),
	admin: z.string(),
	reason: z.string(),
	startedAt: z.number(),
	expiresAt: z.number(),
	ownersNotified: z.number(),
	live: z.boolean()
});
export type BreakGlassView = z.infer<typeof breakGlassView>;
