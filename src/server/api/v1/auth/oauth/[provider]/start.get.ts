import { setResponseHeader } from 'h3';
import { z } from 'zod';
import {
	OAUTH_CONSENT_TEXT,
	OAUTH_PROVIDERS,
	OAUTH_STATE_COOKIE,
	OAUTH_STATE_TTL_MS,
	beginOAuth,
	setShortCookie
} from '../../../../../integrations/oauth';
import { identityDeps } from '../../../../../services/identities';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.oauth.start',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Start a provider sign-in',
		description:
			'Returns the provider address to send the browser to, and sets a short-lived cookie that ties the callback to this browser. The request carries state and a PKCE challenge, and asks for name and email only.',
		params: z.object({ provider: z.enum(OAUTH_PROVIDERS) }),
		response: z.object({ url: z.url(), consent: z.string() })
	},
	async ({ event, params }) => {
		const { url, state } = await beginOAuth(identityDeps(), params.provider);
		setShortCookie(event, OAUTH_STATE_COOKIE, state, OAUTH_STATE_TTL_MS);
		setResponseHeader(event, 'cache-control', 'no-store');
		return { url, consent: OAUTH_CONSENT_TEXT };
	}
);
