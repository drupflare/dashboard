import { getCookie, getRequestHeader, setResponseHeader } from 'h3';
import { z } from 'zod';
import {
	OAUTH_PROVIDERS,
	OAUTH_STATE_COOKIE,
	clearShortCookie,
	completeOAuth,
	setShortCookie
} from '../../../../../integrations/oauth';
import {
	LINK_COOKIE,
	LINK_TTL_MS,
	identityDeps,
	signInWithProvider
} from '../../../../../services/identities';
import { setSessionCookie } from '../../../../../utils/auth';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.oauth.callback',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Finish a provider sign-in',
		description:
			'Checks the state against the cookie, exchanges the code and signs in. A provider email that matches an existing account never signs in or merges: the answer is link_required, and the person confirms the link from that account in settings.',
		params: z.object({ provider: z.enum(OAUTH_PROVIDERS) }),
		query: z.object({
			code: z.string().max(2048).optional(),
			state: z.string().max(256).optional(),
			error: z.string().max(256).optional(),
			error_description: z.string().max(1024).optional()
		}),
		response: z.discriminatedUnion('status', [
			z.object({
				status: z.literal('signed_in'),
				user: z.object({
					id: z.string(),
					email: z.string(),
					displayName: z.string().nullable()
				}),
				isNew: z.boolean()
			}),
			z.object({
				status: z.literal('link_required'),
				provider: z.enum(OAUTH_PROVIDERS),
				email: z.string()
			})
		])
	},
	async ({ event, params, query }) => {
		setResponseHeader(event, 'cache-control', 'no-store');
		const cookieState = getCookie(event, OAUTH_STATE_COOKIE);
		clearShortCookie(event, OAUTH_STATE_COOKIE);
		const deps = identityDeps();
		const profile = await completeOAuth(deps, params.provider, {
			code: query.code,
			state: query.state,
			error: query.error,
			cookieState
		});
		const result = await signInWithProvider(deps, params.provider, profile, {
			userAgent: getRequestHeader(event, 'user-agent'),
			ip: getRequestHeader(event, 'cf-connecting-ip')
		});
		if (result.status === 'link_required') {
			setShortCookie(event, LINK_COOKIE, result.token, LINK_TTL_MS);
			return {
				status: 'link_required' as const,
				provider: result.provider,
				email: result.email
			};
		}
		setSessionCookie(event, result.token, result.session);
		const { id, email, displayName } = result.user;
		return {
			status: 'signed_in' as const,
			user: { id, email, displayName },
			isNew: result.isNew
		};
	}
);
