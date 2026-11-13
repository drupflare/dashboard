import { z } from 'zod';

export const PROVIDER_IDS = ['github', 'gitlab', 'bitbucket', 'gitea', 'forgejo'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const connectionViewSchema = z.strictObject({
	id: z.string(),
	provider: z.enum(PROVIDER_IDS),
	displayName: z.string(),
	scopes: z.array(z.string()),
	state: z.enum(['active', 'revoked']),
	createdAt: z.number()
});
export type ConnectionView = z.infer<typeof connectionViewSchema>;

export const connectionListSchema = z.strictObject({ items: z.array(connectionViewSchema) });

export const connectStartSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('redirect'), url: z.string() }),
	z.strictObject({ kind: z.literal('connected'), connection: connectionViewSchema })
]);

export const repoSummarySchema = z.strictObject({
	fullName: z.string(),
	defaultBranch: z.string().nullable()
});

export const repoListSchema = z.strictObject({ items: z.array(repoSummarySchema) });

export const remoteViewSchema = z.strictObject({
	id: z.string(),
	siteId: z.string(),
	connectionId: z.string(),
	repo: z.string(),
	branch: z.string(),
	mountPath: z.string(),
	intervalMinutes: z.number().int(),
	lastPullStatus: z.enum(['installed', 'failed']).nullable(),
	lastPullAt: z.number().nullable(),
	lastPullReason: z.string().nullable().optional(),
	createdAt: z.number()
});

export type RemoteView = z.infer<typeof remoteViewSchema>;

export const remoteListSchema = z.strictObject({ items: z.array(remoteViewSchema) });
