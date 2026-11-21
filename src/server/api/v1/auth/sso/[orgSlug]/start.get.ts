import { z } from 'zod';
import { SSO_STATE_COOKIE, ssoSlugSchema } from '../../../../../../shared/sso';
import { setShortCookie } from '../../../../../integrations/oauth';
import { SSO_STATE_TTL_MS } from '../../../../../integrations/oidc';
import { beginSsoSignIn, ssoServices } from '../../../../../services/sso';
import { defineApi } from '../../../../../utils/define-api';
import { ssoFailureRedirect } from '../../../../../utils/sso-redirect';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.sso.start',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Start an organisation sign-in',
		description:
			'Sends the browser to the identity provider of the organisation with this sign-in name. The request carries state, a nonce and a PKCE challenge, and a short-lived cookie ties the return to this browser.',
		params: z.object({ orgSlug: ssoSlugSchema })
	},
	async ({ event, params }) => {
		try {
			const { url, state } = await beginSsoSignIn(ssoServices(), params.orgSlug);
			setShortCookie(event, SSO_STATE_COOKIE, state, SSO_STATE_TTL_MS);
			return new Response(null, {
				status: 302,
				headers: { location: url, 'cache-control': 'no-store' }
			});
		} catch (error) {
			return ssoFailureRedirect(error);
		}
	}
);
