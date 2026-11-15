import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../../shared/errors';
import {
	accessServices,
	removeAccessRule,
	syncedSchema
} from '../../../../../../../../services/access-rules';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.access.manage',
		rateClass: 'write',
		tags: ['gate'],
		summary: 'Remove an access rule from a site',
		description:
			'Removes one rule and starts the change that applies it to the site. Visitors who got in through it lose access when the site next renews its lease. The response names the operation to follow.',
		params: z.object({ orgId: z.string().min(1), id: siteId, ruleId: z.string().min(1) }),
		response: syncedSchema
	},
	async ({ principal, resource, params }) => {
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
		return removeAccessRule(accessServices(), {
			orgId,
			siteId: resolved,
			ruleId: params.ruleId,
			principal
		});
	}
);
