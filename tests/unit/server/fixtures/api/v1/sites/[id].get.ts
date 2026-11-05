import { z } from 'zod';
import { defineApi } from '../../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read a site',
		description: 'Returns one site.',
		params: z.object({ id: z.string().min(1) }),
		query: z.object({ expand: z.enum(['config']).optional() }),
		response: z.object({ id: z.string(), name: z.string(), expanded: z.boolean() })
	},
	(ctx) => ({ id: ctx.params.id, name: 'fixture', expanded: ctx.query.expand === 'config' })
);
