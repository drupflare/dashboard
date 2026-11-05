import { getRequestHeader } from 'h3';
import { z } from 'zod';
import { verifyCode } from '../../../../services/auth';
import { authServices, setSessionCookie } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.code.verify',
		rateClass: 'auth-code',
		tags: ['auth'],
		summary: 'Verify a sign-in code',
		description:
			'Signs in with the code and sets the session cookie. The body never carries the session token.',
		body: z.object({ email: z.email().max(254), code: z.string().regex(/^\d{6}$/) }),
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
		const signedIn = await verifyCode(authServices(), {
			email: body.email,
			code: body.code,
			userAgent: getRequestHeader(event, 'user-agent'),
			ip: getRequestHeader(event, 'cf-connecting-ip')
		});
		setSessionCookie(event, signedIn.token, signedIn.session);
		const { id, email, displayName } = signedIn.user;
		return { user: { id, email, displayName }, isNew: signedIn.isNew };
	}
);
