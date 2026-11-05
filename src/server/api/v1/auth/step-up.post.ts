import { z } from 'zod';
import { stepUp, stepUpUntil } from '../../../services/auth';
import { authServices, setSessionCookie, type UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'auth-code',
		tags: ['auth'],
		summary: 'Prove a fresh authentication',
		description:
			'Takes a fresh sign-in code for the signed-in address, marks the session as recently authenticated and rotates the session cookie.',
		body: z.object({ code: z.string().regex(/^\d{6}$/) }),
		response: z.object({ stepUpUntil: z.iso.datetime() })
	},
	async ({ event, principal, body }) => {
		const { userId, sessionId } = principal as UserPrincipal;
		const issued = await stepUp(authServices(), { userId, sessionId, code: body.code });
		setSessionCookie(event, issued.token, issued.session);
		return { stepUpUntil: new Date(stepUpUntil(issued.session) as number).toISOString() };
	}
);
