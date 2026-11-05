import { z } from 'zod';
import { identityDeps, listPasskeys } from '../../../services/identities';
import type { UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'read',
		tags: ['me'],
		summary: 'List passkeys',
		description:
			'Lists your registered passkeys, newest first. Keys and counters are never returned.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					deviceType: z.enum(['singleDevice', 'multiDevice']),
					backedUp: z.boolean(),
					createdAt: z.iso.datetime(),
					lastUsedAt: z.iso.datetime().nullable()
				})
			),
			nextCursor: z.null()
		})
	},
	async ({ principal }) => {
		const { userId } = principal as UserPrincipal;
		const passkeys = await listPasskeys(identityDeps(), userId);
		return {
			items: passkeys
				.toSorted((a, b) => b.createdAt - a.createdAt)
				.map((passkey) => ({
					id: passkey.id,
					name: passkey.name,
					deviceType: passkey.deviceType,
					backedUp: passkey.backedUp,
					createdAt: new Date(passkey.createdAt).toISOString(),
					lastUsedAt:
						passkey.lastUsedAt === null
							? null
							: new Date(passkey.lastUsedAt).toISOString()
				})),
			nextCursor: null
		};
	}
);
