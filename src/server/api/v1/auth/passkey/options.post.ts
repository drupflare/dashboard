import { setResponseHeader } from 'h3';
import { authenticationOptions, requestOptionsSchema } from '../../../../integrations/webauthn';
import { identityDeps } from '../../../../services/identities';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.passkey.options',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Start a passkey sign-in',
		description:
			'Returns the options to pass to navigator.credentials.get. The challenge works once and expires after five minutes.',
		response: requestOptionsSchema
	},
	async ({ event }) => {
		setResponseHeader(event, 'cache-control', 'no-store');
		const { once, webauthn } = identityDeps();
		return authenticationOptions({ once, config: webauthn });
	}
);
