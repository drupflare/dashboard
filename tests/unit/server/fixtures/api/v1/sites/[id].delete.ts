import { z } from 'zod';
import { defineApi } from '../../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.delete',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Delete a site',
		params: z.object({ id: z.string().min(1) }),
		successStatus: 204
	},
	() => undefined
);
