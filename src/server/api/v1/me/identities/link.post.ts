import { getCookie } from 'h3';
import { z } from 'zod';
import { clearShortCookie } from '../../../../integrations/oauth';
import { LINK_COOKIE, confirmLink, identityDeps } from '../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Confirm a provider link',
		description:
			'Links the provider identity from the last provider sign-in in this browser to your account. It needs a fresh authentication, and the provider email must match your account email.',
		successStatus: 201,
		response: z.object({
			identity: z.object({
				id: z.string(),
				provider: z.string(),
				email: z.string().nullable(),
				verified: z.boolean(),
				createdAt: z.iso.datetime()
			})
		})
	},
	async ({ event, principal }) => {
		const user = principal as UserPrincipal;
		const identity = await confirmLink(identityDeps(), {
			userId: user.userId,
			stepUpAt: stepUpAtOf(user),
			token: getCookie(event, LINK_COOKIE)
		});
		clearShortCookie(event, LINK_COOKIE);
		return {
			identity: {
				id: identity.id,
				provider: identity.provider,
				email: identity.email,
				verified: identity.verified,
				createdAt: new Date(identity.createdAt).toISOString()
			}
		};
	}
);
