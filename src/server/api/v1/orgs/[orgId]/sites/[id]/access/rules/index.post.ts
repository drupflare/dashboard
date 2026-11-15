import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../../shared/errors';
import {
	accessServices,
	addAccessRule,
	addRuleSchema,
	addedRuleSchema
} from '../../../../../../../../services/access-rules';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.access.manage',
		rateClass: 'write',
		tags: ['gate'],
		summary: 'Add an access rule to a site',
		description:
			'Adds one rule to the production site or one of its environments. Rules combine, so a visitor who matches any of them gets in. A password or review link is stored as a hash; a review link token is returned once, in this response.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: addRuleSchema,
		response: addedRuleSchema,
		successStatus: 201
	},
	async ({ principal, resource, params, body }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return addAccessRule(accessServices(), { orgId, siteId: resolved, principal, body });
	}
);
