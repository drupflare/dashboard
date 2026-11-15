import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { strataAllocationBodySchema, strataStatusSchema } from '../../../../../../../shared/strata';
import { moduleServices, setStrataAllocation } from '../../../../../../services/modules';
import { principalActor } from '../../../../../../services/owner-tokens';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.install',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Set the Strata allocation for a site',
		description:
			'Sets how much of the site allowance Strata may use: light records changes made through the site, and detailed also records every database statement and uses about twice as much. History is saved every 15 minutes either way. The free plan allows light only. The change is recorded and audited, and the status shows whether the site has accepted it.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: strataAllocationBodySchema,
		response: strataStatusSchema
	},
	async ({ principal, resource, params, body }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return setStrataAllocation(moduleServices(), {
			orgId,
			siteId: resolvedSite,
			allocation: body.allocation,
			actor: principalActor(principal)
		});
	}
);
