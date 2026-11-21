import { getCookie, getRequestHeader } from 'h3';
import { z } from 'zod';
import { SSO_STATE_COOKIE, ssoSlugSchema } from '../../../../../../shared/sso';
import { clearShortCookie, setShortCookie } from '../../../../../integrations/oauth';
import { LINK_COOKIE, LINK_TTL_MS } from '../../../../../services/identities';
import { completeSsoSignIn, ssoServices } from '../../../../../services/sso';
import { setSessionCookie } from '../../../../../utils/auth';
import { defineApi } from '../../../../../utils/define-api';
import { ssoFailureRedirect } from '../../../../../utils/sso-redirect';

const back = (to: string) =>
	new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });

export default defineApi(
	{
		scope: 'public',
		action: 'auth.sso.callback',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Finish an organisation sign-in',
		description:
			'The address the identity provider sends the browser back to. It checks the state against the cookie, exchanges the code, checks the token and the email domain, and signs in, creating the account and membership on the first visit. An address that already has an account never merges: the browser goes on to confirm the link from that account. Every answer is a redirect.',
		params: z.object({ orgSlug: ssoSlugSchema }),
		query: z.object({
			code: z.string().max(4096).optional(),
			state: z.string().max(256).optional(),
			error: z.string().max(256).optional(),
			error_description: z.string().max(1024).optional()
		})
	},
	async ({ event, params, query }) => {
		const cookieState = getCookie(event, SSO_STATE_COOKIE);
		clearShortCookie(event, SSO_STATE_COOKIE);
		try {
			const result = await completeSsoSignIn(
				ssoServices(),
				params.orgSlug,
				{ code: query.code, state: query.state, error: query.error, cookieState },
				{
					userAgent: getRequestHeader(event, 'user-agent'),
					ip: getRequestHeader(event, 'cf-connecting-ip')
				}
			);
			if (result.status === 'link_required') {
				setShortCookie(event, LINK_COOKIE, result.token, LINK_TTL_MS);
				return back(`/auth/callback?link=sso&email=${encodeURIComponent(result.email)}`);
			}
			setSessionCookie(event, result.token, result.session);
			return back('/sites');
		} catch (error) {
			return ssoFailureRedirect(error);
		}
	}
);
