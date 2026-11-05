import { z } from 'zod';
import { defineApi } from '../../../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'key.create',
		rateClass: 'write',
		tags: ['api-keys'],
		summary: 'Create an API key',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.object({ name: z.string().min(1).max(64) }),
		response: z.object({ id: z.string() }),
		successStatus: 201
	},
	(ctx) => ({ id: `key_${ctx.body.name}` })
);
