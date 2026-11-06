import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { SUPPORT_LEVELS } from '../../../../../shared/plans';
import { FEATURES } from '../../../../domain/entitlements';
import { siteServices } from '../../../../services/sites';
import { defineApi } from '../../../../utils/define-api';

const limit = z.number().nullable();

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the plan',
		description:
			'Reads what the organisation in the path may do on its current plan. A null limit is unknown or negotiated and counts as no allowance. Only an activated subscription changes the plan; every other account reads as the free plan.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({
			planId: z.string(),
			addOns: z.array(z.string()),
			dashboard: z.boolean(),
			sites: limit,
			views: limit,
			viewsPooled: z.boolean().nullable(),
			nodes: limit,
			support: z.enum(SUPPORT_LEVELS),
			supportHours: limit,
			assurance: z.boolean(),
			environments: z.boolean(),
			customDomains: limit,
			backupDays: limit,
			features: z.object(Object.fromEntries(FEATURES.map((name) => [name, z.boolean()])))
		})
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const plan = await siteServices().planOf(orgId);
		return { ...plan, addOns: [...plan.addOns] };
	}
);
