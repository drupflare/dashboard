import { z } from 'zod';
import { defineApi } from '../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'Read the signed-in account',
		response: z.object({ kind: z.enum(['user', 'key']) })
	},
	(ctx) => ({ kind: ctx.principal?.kind ?? 'user' })
);
