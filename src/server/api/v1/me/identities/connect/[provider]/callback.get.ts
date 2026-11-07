import { getCookie, setResponseHeader } from 'h3';
import { z } from 'zod';
import {
	OAUTH_PROVIDERS,
	OAUTH_STATE_COOKIE,
	clearShortCookie,
	completeOAuth
} from '../../../../../../integrations/oauth';
import { connectIdentity, identityDeps } from '../../../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../../../utils/auth';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Finish connecting a provider account',
		description:
			'Checks the state against the cookie and against this session, exchanges the code and connects the provider account to the signed-in account. It needs a fresh authentication. A provider account that is already connected, here or to another account, is a conflict.',
		params: z.object({ provider: z.enum(OAUTH_PROVIDERS) }),
		query: z.object({
			code: z.string().max(2048).optional(),
			state: z.string().max(256).optional(),
			error: z.string().max(256).optional(),
			error_description: z.string().max(1024).optional()
		}),
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
	async ({ event, principal, params, query }) => {
		setResponseHeader(event, 'cache-control', 'no-store');
		const user = principal as UserPrincipal;
		const cookieState = getCookie(event, OAUTH_STATE_COOKIE);
		clearShortCookie(event, OAUTH_STATE_COOKIE);
		const deps = identityDeps();
		const profile = await completeOAuth(
			deps,
			params.provider,
			{ code: query.code, state: query.state, error: query.error, cookieState },
			{ purpose: 'link', userId: user.userId }
		);
		const identity = await connectIdentity(deps, {
			userId: user.userId,
			stepUpAt: stepUpAtOf(user),
			provider: params.provider,
			profile
		});
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
