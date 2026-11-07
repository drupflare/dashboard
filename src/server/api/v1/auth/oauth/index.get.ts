import { setResponseHeader } from 'h3';
import { z } from 'zod';
import { OAUTH_PROVIDERS } from '../../../../integrations/oauth';
import { identityDeps } from '../../../../services/identities';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.oauth.providers',
		rateClass: 'read',
		tags: ['auth'],
		summary: 'List the provider sign-ins that are set up',
		description:
			'Names the providers whose client id and secret are both configured, so the sign-in screen shows only buttons that can work.',
		response: z.object({ providers: z.array(z.enum(OAUTH_PROVIDERS)) })
	},
	({ event }) => {
		setResponseHeader(event, 'cache-control', 'no-store');
		const { clients } = identityDeps();
		return { providers: OAUTH_PROVIDERS.filter((provider) => clients[provider] !== undefined) };
	}
);
