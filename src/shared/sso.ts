import { z } from 'zod';

// roles a sign-in claim may grant; owner is never one of them
export const SSO_CLAIM_ROLES = ['viewer', 'billing', 'developer', 'admin'] as const;
export type SsoRole = (typeof SSO_CLAIM_ROLES)[number];

export const SSO_DEFAULT_ROLE: SsoRole = 'viewer';

// placeholder: a sign-in through an organisation ends after this long, whatever the cookie says
export const SSO_SESSION_MAX_MS = 8 * 60 * 60 * 1000;

export const SSO_DEFAULT_GROUP_CLAIM = 'groups';

export const SSO_STATE_COOKIE = '__Host-drupflare_sso';

export const SSO_DOMAIN_LABEL = '_drupflare-sso';

// the TXT record that shows an organisation controls an allowed domain
export function ssoDomainRecord(orgId: string, domain: string): { name: string; value: string } {
	return { name: `${SSO_DOMAIN_LABEL}.${domain}`, value: `drupflare-sso=${orgId}` };
}

export const ssoSlugSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3 to 40 letters, numbers or hyphens');

export const ssoRoleMapSchema = z
	.array(z.object({ group: z.string().trim().min(1).max(256), role: z.enum(SSO_CLAIM_ROLES) }))
	.max(50);

export type SsoRoleMap = z.infer<typeof ssoRoleMapSchema>;

const domainSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Enter a domain');

export const ssoConfigBodySchema = z.object({
	slug: ssoSlugSchema,
	issuer: z.url().max(512),
	clientId: z.string().trim().min(1).max(256),
	// left out on an update, the stored secret stays
	clientSecret: z.string().min(1).max(2048).optional(),
	allowedDomains: z.array(domainSchema).min(1).max(20),
	roleMap: ssoRoleMapSchema,
	groupClaim: z.string().trim().min(1).max(64).default(SSO_DEFAULT_GROUP_CLAIM),
	defaultRole: z.enum(SSO_CLAIM_ROLES).default(SSO_DEFAULT_ROLE),
	enabled: z.boolean().default(false)
});

export type SsoConfigBody = z.infer<typeof ssoConfigBodySchema>;

export const ssoViewSchema = z.object({
	configured: z.boolean(),
	slug: z.string().nullable(),
	issuer: z.string().nullable(),
	clientId: z.string().nullable(),
	secretSet: z.boolean(),
	allowedDomains: z.array(z.string()),
	roleMap: ssoRoleMapSchema,
	groupClaim: z.string(),
	defaultRole: z.enum(SSO_CLAIM_ROLES),
	enabled: z.boolean(),
	lastVerifiedAt: z.iso.datetime().nullable(),
	redirectUri: z.string().nullable()
});

export type SsoView = z.infer<typeof ssoViewSchema>;

export const ssoTestResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export type SsoTestResult = z.infer<typeof ssoTestResultSchema>;

// the callback sends the browser back to the sign-in page with one of these
export const SSO_FAILURES = {
	failed: 'The sign-in could not be completed. Try again, or ask your administrator.',
	disabled: 'Sign-in through this organisation is not turned on.',
	domain: 'Your email address is not one this organisation signs in.',
	unverified: 'Your organisation has not confirmed your email address.',
	unknown: 'No organisation sign-in was found at that address.'
} as const;

export type SsoFailure = keyof typeof SSO_FAILURES;

export const isSsoFailure = (value: unknown): value is SsoFailure =>
	typeof value === 'string' && value in SSO_FAILURES;
