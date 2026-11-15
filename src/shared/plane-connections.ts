import { z } from 'zod';
import { capability } from './cloudflare-probe';

export const CONNECTION_STATES = ['active', 'invalid', 'revoked'] as const;

export const planeConnectionViewSchema = z.strictObject({
	id: z.string(),
	provider: z.literal('cloudflare'),
	accountId: z.string(),
	accountName: z.string(),
	tokenKind: z.enum(['user', 'account']),
	expiresOn: z.string().nullable(),
	state: z.enum(CONNECTION_STATES),
	capabilities: z.array(capability),
	workersSubdomain: z.string().nullable(),
	// true when Drupflare made the stored token, so the broader one you gave was not kept
	narrowerToken: z.boolean(),
	createdAt: z.number(),
	lastValidatedAt: z.number(),
	revokedAt: z.number().nullable()
});
export type PlaneConnectionView = z.infer<typeof planeConnectionViewSchema>;

export const planeConnectionListSchema = z.strictObject({
	items: z.array(planeConnectionViewSchema)
});

export const connectResultSchema = z.strictObject({
	connection: planeConnectionViewSchema,
	message: z.string()
});
export type ConnectResult = z.infer<typeof connectResultSchema>;

export const TOKEN_REMOVALS = ['deleted', 'owner-must-delete', 'not-ours'] as const;

export const revokeResultSchema = z.strictObject({
	connection: planeConnectionViewSchema,
	tokenRemoval: z.enum(TOKEN_REMOVALS),
	message: z.string()
});
export type RevokeResult = z.infer<typeof revokeResultSchema>;

// the storage capability decides the config; the create screen reads the reason from here
export function storageNote(view: Pick<PlaneConnectionView, 'capabilities'>): string | null {
	const storage = view.capabilities.find((item) => item.id === 'storage');
	if (storage?.state === 'granted') return null;
	return 'Your Cloudflare account has no object storage turned on, so this site runs without file mirroring and Strata off-site backups.';
}

export const SELF_MANAGED_HOST_SUFFIX = 'workers.dev';

export function workersDevHost(script: string, subdomain: string): string {
	return `${script}.${subdomain}.${SELF_MANAGED_HOST_SUFFIX}`;
}
