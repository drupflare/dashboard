import { z } from 'zod';
import { defineApi } from '../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['me'],
		summary: 'Params that name nothing in the path',
		params: z.object({ id: z.string() })
	},
	() => ({})
);
