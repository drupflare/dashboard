import { setResponseHeader } from 'h3';
import { z } from 'zod';
import {
	OAUTH_PROVIDERS,
	OAUTH_STATE_COOKIE,
	OAUTH_STATE_TTL_MS,
	beginOAuth,
	consentTextFor,
	setShortCookie
} from '../../../../../../integrations/oauth';
import { identityDeps, requireFresh } from '../../../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../../../utils/auth';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Start connecting a provider account',
		description:
			'Returns the provider address to send the browser to, and sets a short-lived cookie that ties the callback to this browser. The state records who started it, so only this session can finish the connection. It needs a fresh authentication.',
		params: z.object({ provider: z.enum(OAUTH_PROVIDERS) }),
		response: z.object({ url: z.url(), consent: z.string() })
	},
	async ({ event, principal, params }) => {
		const user = principal as UserPrincipal;
		requireFresh(stepUpAtOf(user));
		const { url, state } = await beginOAuth(identityDeps(), params.provider, {
			purpose: 'link',
			userId: user.userId
		});
		setShortCookie(event, OAUTH_STATE_COOKIE, state, OAUTH_STATE_TTL_MS);
		setResponseHeader(event, 'cache-control', 'no-store');
		return { url, consent: consentTextFor(params.provider) };
	}
);
