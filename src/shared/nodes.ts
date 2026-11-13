import { z } from 'zod';

export const nodeViewSchema = z.strictObject({
	id: z.string(),
	state: z.enum(['active', 'revoked']),
	name: z.string(),
	os: z.string(),
	arch: z.string(),
	bastionVersion: z.string(),
	workerdVersion: z.string(),
	mode: z.string(),
	pairedAt: z.string(),
	lastSeenAt: z.string().nullable(),
	revokedAt: z.string().nullable()
});
export type NodeView = z.infer<typeof nodeViewSchema>;

export const nodePageSchema = z.strictObject({
	items: z.array(nodeViewSchema),
	nextCursor: z.string().nullable()
});
export type NodePage = z.infer<typeof nodePageSchema>;

export const pairingViewSchema = z.strictObject({
	pairingId: z.string(),
	claimToken: z.string(),
	pairUrl: z.string(),
	expiresAt: z.string()
});
export type PairingView = z.infer<typeof pairingViewSchema>;

export const pairLine = (pairUrl: string): string => `bastion pair ${pairUrl}`;
