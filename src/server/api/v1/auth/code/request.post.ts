import { getRequestHeader } from 'h3';
import { z } from 'zod';
import { requestCode } from '../../../../services/auth';
import { authServices } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.code.request',
		rateClass: 'auth-code',
		tags: ['auth'],
		summary: 'Request a sign-in code',
		description:
			'Sends a six-digit code to the address. A new address creates an account when the code is verified. The same answer comes back for every address.',
		body: z.object({
			email: z.email().max(254),
			turnstileToken: z.string().min(1).max(2048).optional()
		}),
		response: z.object({ sent: z.literal(true) }),
		successStatus: 202
	},
	async ({ event, body }) => {
		await requestCode(authServices(), {
			email: body.email,
			turnstileToken: body.turnstileToken,
			ip: getRequestHeader(event, 'cf-connecting-ip')
		});
		return { sent: true as const };
	}
);
