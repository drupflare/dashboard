import { z } from 'zod';
import { isBillingAdmin, listPlans } from '../../../services/billing';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['billing'],
		summary: 'List plans',
		description:
			'Lists the plans. A price appears only after it has been reviewed, and platform administrators see every price.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					kind: z.string(),
					lookupKey: z.string(),
					sites: z.number().nullable(),
					views: z.number().nullable(),
					support: z.string(),
					disabled: z.boolean(),
					monthly: z.number().nullable().optional(),
					annual: z.number().nullable().optional(),
					unreviewed: z.boolean().optional()
				})
			)
		})
	},
	({ facts }) => ({ items: listPlans(isBillingAdmin(facts)) })
);
