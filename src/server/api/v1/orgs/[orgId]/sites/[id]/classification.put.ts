import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import {
	siteClassificationBodySchema,
	siteClassificationViewSchema
} from '../../../../../../../shared/policies';
import { actorOf } from '../../../../../../services/departments';
import { classifySite, policyServices } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.classification.set',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Set the data classification of a site',
		description:
			'Labels the site public, internal, restricted or regulated, or clears the label with null. The label picks the default policy group of the site.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: siteClassificationBodySchema,
		response: siteClassificationViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, siteId } = resource;
		if (orgId === undefined || orgId !== params.orgId || siteId === undefined) {
			throw new ApiError('not_found', 'Not found');
		}
		return classifySite(
			policyServices(),
			orgId,
			actorOf(principal, facts),
			siteId,
			body.classification
		);
	}
);
