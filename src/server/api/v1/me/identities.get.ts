import { z } from 'zod';
import { identityDeps, listIdentities } from '../../../services/identities';
import type { UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'read',
		tags: ['me'],
		summary: 'List linked providers',
		description:
			'Lists the provider identities linked to your account. The email code is always available and is not listed.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					provider: z.string(),
					email: z.string().nullable(),
					verified: z.boolean(),
					createdAt: z.iso.datetime()
				})
			),
			nextCursor: z.null()
		})
	},
	async ({ principal }) => {
		const { userId } = principal as UserPrincipal;
		const identities = await listIdentities(identityDeps(), userId);
		return {
			items: identities.map((identity) => ({
				id: identity.id,
				provider: identity.provider,
				email: identity.email,
				verified: identity.verified,
				createdAt: new Date(identity.createdAt).toISOString()
			})),
			nextCursor: null
		};
	}
);
