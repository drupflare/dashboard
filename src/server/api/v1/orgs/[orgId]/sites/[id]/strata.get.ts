import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { strataStatusSchema } from '../../../../../../../shared/strata';
import { getStrataStatus, moduleServices } from '../../../../../../services/modules';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the Strata allocation for a site',
		description:
			'Returns how much of the site allowance Strata may use: the setting, whether it records statements, how often history is saved in seconds, whether the site has accepted it, and when the free plan warning was confirmed. A site that never chose gets light.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: strataStatusSchema
	},
	async ({ principal, resource, params }) => {
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
		return getStrataStatus(moduleServices(), { orgId, siteId: resolvedSite });
	}
);
