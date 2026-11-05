import { z } from 'zod';
import { defineApi } from '../../../../../../../../src/server/utils/define-api';

export const deploys: string[] = [];

export default defineApi(
	{
		scope: 'site',
		action: 'site.deploy',
		rateClass: 'heavy',
		tags: ['sites'],
		summary: 'Deploy a site',
		params: z.object({ id: z.string().min(1) }),
		body: z.object({ ref: z.string().min(1) }),
		response: z.object({ operationId: z.string() }),
		successStatus: 202
	},
	(ctx) => {
		deploys.push(`${ctx.params.id}@${ctx.body.ref}`);
		return { operationId: `op_${deploys.length}` };
	}
);
