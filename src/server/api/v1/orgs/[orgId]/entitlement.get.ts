import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { PLANES, SUPPORT_LEVELS } from '../../../../../shared/plans';
import { FEATURES } from '../../../../domain/entitlements';
import { creditsOf } from '../../../../services/billing-addons';
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
			'Reads what the organisation in the path may do on its current plan. A null limit is unknown or negotiated and counts as no allowance. Only an activated subscription changes the plan; every other account reads as the free plan. billingAccount is true when the organisation has a Stripe customer, so the billing portal can open for it. credits holds the units bought in one-time packs per meter, with zeros left out.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({
			planId: z.string(),
			managedPlanId: z.string(),
			plane: z.enum(PLANES),
			addOns: z.array(z.object({ id: z.string(), quantity: z.number().int() })),
			dashboard: z.boolean(),
			sites: limit,
			views: limit,
			viewsPooled: z.boolean().nullable(),
			storageGb: limit,
			writes: limit,
			backupGb: limit,
			mailSends: limit,
			containerHours: limit,
			invitees: limit,
			nodes: limit,
			support: z.enum(SUPPORT_LEVELS),
			supportHoursPerYear: limit,
			assurance: z.boolean(),
			environments: z.boolean(),
			customDomains: limit,
			backupDays: limit,
			features: z.object(Object.fromEntries(FEATURES.map((name) => [name, z.boolean()]))),
			billingAccount: z.boolean(),
			credits: z.record(z.string(), z.number())
		})
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const services = siteServices();
		const plan = await services.planOf(orgId);
		return {
			...plan,
			addOns: plan.addOns.map((holding) => ({ ...holding })),
			billingAccount: await services.billingAccountOf(orgId),
			credits: await creditsOf(orgId)
		};
	}
);
