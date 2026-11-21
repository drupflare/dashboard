import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { siteClassificationViewSchema } from '../../../../../../../shared/policies';
import { policyServices, siteClassification } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the data classification of a site',
		description: 'Returns the label of the site, or null when it has none.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		response: siteClassificationViewSchema
	},
	({ resource, params }) => {
		const { orgId, siteId } = resource;
		if (orgId === undefined || orgId !== params.orgId || siteId === undefined) {
			throw new ApiError('not_found', 'Not found');
		}
		return siteClassification(policyServices(), orgId, siteId);
	}
);
