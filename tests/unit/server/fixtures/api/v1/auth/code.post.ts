import { z } from 'zod';
import { defineApi } from '../../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.code.request',
		rateClass: 'auth-code',
		tags: ['auth'],
		summary: 'Request a sign-in code',
		body: z.object({ email: z.email() }),
		response: z.object({ sent: z.literal(true) }),
		successStatus: 202
	},
	() => ({ sent: true as const })
);
