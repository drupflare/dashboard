import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { getRequestHeader } from 'h3';
import { z } from 'zod';
import { authenticationResponseSchema } from '../../../../integrations/webauthn';
import { identityDeps, signInWithPasskey } from '../../../../services/identities';
import { setSessionCookie } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.passkey.verify',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Finish a passkey sign-in',
		description:
			'Verifies the signed challenge and sets the session cookie. Every failure answers the same way.',
		body: authenticationResponseSchema,
		response: z.object({
			user: z.object({
				id: z.string(),
				email: z.string(),
				displayName: z.string().nullable()
			}),
			isNew: z.boolean()
		})
	},
	async ({ event, body }) => {
		const signedIn = await signInWithPasskey(
			identityDeps(),
			body as AuthenticationResponseJSON,
			{
				userAgent: getRequestHeader(event, 'user-agent'),
				ip: getRequestHeader(event, 'cf-connecting-ip')
			}
		);
		setSessionCookie(event, signedIn.token, signedIn.session);
		const { id, email, displayName } = signedIn.user;
		return { user: { id, email, displayName }, isNew: false };
	}
);
