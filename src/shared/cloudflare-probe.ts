import { z } from 'zod';

export const PROBE_STATUSES = ['active', 'expired', 'disabled', 'invalid', 'unknown'] as const;
export const CAPABILITY_IDS = [
	'scripts',
	'key-value',
	'storage',
	'databases',
	'routes',
	'token-management'
] as const;
export const CAPABILITY_STATES = ['granted', 'missing', 'unknown'] as const;

const account = z.strictObject({ id: z.string().min(1), name: z.string() });

const capability = z.strictObject({
	id: z.enum(CAPABILITY_IDS),
	label: z.string(),
	state: z.enum(CAPABILITY_STATES),
	permission: z.string(),
	retryHint: z.string().nullable()
});

export const probeReportSchema = z.strictObject({
	status: z.enum(PROBE_STATUSES),
	kind: z.enum(['user', 'account']).nullable(),
	tokenId: z.string().nullable(),
	expiresOn: z.string().nullable(),
	accounts: z.array(account),
	account: account.nullable(),
	capabilities: z.array(capability),
	canDownscope: z.boolean()
});

export type ProbeReport = z.infer<typeof probeReportSchema>;
export type ProbeCapability = z.infer<typeof capability>;
export type ProbeAccount = z.infer<typeof account>;
export type ProbeKind = 'user' | 'account';
export type ProbeStatus = (typeof PROBE_STATUSES)[number];
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

// keys from the Cloudflare token template reference; one per capability the probe checks
export const TOKEN_TEMPLATE_PERMISSIONS = [
	{ key: 'workers_scripts', type: 'edit' },
	{ key: 'workers_kv_storage', type: 'edit' },
	{ key: 'workers_r2', type: 'edit' },
	{ key: 'd1', type: 'edit' },
	{ key: 'workers_routes', type: 'edit' },
	{ key: 'account_api_tokens', type: 'edit' }
] as const;

const TOKEN_TEMPLATE_NAME = 'Drupflare Site Connection';

export function tokenTemplateUrl(): string {
	const keys = encodeURIComponent(JSON.stringify(TOKEN_TEMPLATE_PERMISSIONS));
	const name = encodeURIComponent(TOKEN_TEMPLATE_NAME);
	return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${keys}&name=${name}`;
}
