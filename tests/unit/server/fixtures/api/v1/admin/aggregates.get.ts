import { z } from 'zod';
import { defineApi } from '../../../../../../../src/server/utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.aggregates.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read platform aggregates',
		response: z.object({ sites: z.number() })
	},
	() => ({ sites: 0 })
);
