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

// a box sends a status frame every five minutes; one more minute allows for a slow send
export const LINK_FRESH_MS = 6 * 60_000;

export type NodeLinkState = 'connected' | 'quiet' | 'never' | 'revoked';

export function linkStateOf(
	node: { state: 'active' | 'revoked'; lastSeenAt: string | number | null },
	now: number
): NodeLinkState {
	if (node.state === 'revoked') return 'revoked';
	if (node.lastSeenAt === null) return 'never';
	const seen =
		typeof node.lastSeenAt === 'number' ? node.lastSeenAt : Date.parse(node.lastSeenAt);
	return Number.isNaN(seen) || now - seen > LINK_FRESH_MS ? 'quiet' : 'connected';
}

export const LINK_STATE_COPY: Record<NodeLinkState, string> = {
	connected: 'Connected',
	quiet: 'Not connected right now. Check that bastion is running on the box.',
	never: 'Paired, but the box has not connected yet. Start bastion on it.',
	revoked: 'Unpaired. Pair the box again to use it.'
};
