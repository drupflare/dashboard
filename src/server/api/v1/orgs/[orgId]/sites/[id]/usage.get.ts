import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import {
	MONTH_PATTERN,
	siteMonthUsageSchema,
	type SiteMonthUsage
} from '../../../../../../../shared/usage';
import { currentMonth } from '../../../../../../domain/cost-centers';
import { siteMonthUsage, usageServices } from '../../../../../../services/usage';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the views of a site for one month',
		description:
			'Shows the views of one site for one UTC month, per day, with the accounting state of each day. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({ month: z.string().regex(MONTH_PATTERN).optional() }),
		response: siteMonthUsageSchema
	},
	async ({ principal, resource, params, query }): Promise<SiteMonthUsage> => {
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
		const deps = usageServices();
		return siteMonthUsage(deps, orgId, resolved, query.month ?? currentMonth(deps.now()));
	}
);
