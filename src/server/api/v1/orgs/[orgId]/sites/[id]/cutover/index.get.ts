import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	cutoverPlanSchema,
	cutoverServices,
	readCutover
} from '../../../../../../../services/migration-cutover';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.cutover.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the plan and state of a site move',
		description:
			'Returns whether the site can take a move, the expected write window of each write policy, the four points at which the new site is checked, and the latest move on the site with its steps, its write count and whether going back is still a DNS reversal. A site that has had no move has no latest move.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: cutoverPlanSchema
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
		return readCutover(siteServices(), cutoverServices(), { orgId, siteId: resolved });
	}
);
