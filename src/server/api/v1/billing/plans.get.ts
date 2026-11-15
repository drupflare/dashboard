import { z } from 'zod';
import { PLANES } from '../../../../shared/plans';
import { isBillingAdmin, listPlans } from '../../../services/billing';
import { defineApi } from '../../../utils/define-api';

const figure = z.number().nullable();

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['billing'],
		summary: 'List plans',
		description:
			'Lists the plans with what each includes. A price appears only after it has been reviewed, and platform administrators see every price. A null figure is unknown or negotiated, and sitesUnlimited marks a plan with no site limit.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					kind: z.string(),
					plane: z.enum(PLANES),
					lookupKey: z.string(),
					sites: figure,
					sitesUnlimited: z.boolean(),
					views: figure,
					support: z.string(),
					supportHoursPerYear: figure,
					included: z.object({
						storageGb: figure,
						writes: figure,
						backupGb: figure,
						mailSends: figure,
						containerHours: figure,
						invitees: figure,
						customDomains: figure,
						backupDays: figure
					}),
					disabled: z.boolean(),
					monthly: figure.optional(),
					annual: figure.optional(),
					unreviewed: z.boolean().optional()
				})
			)
		})
	},
	({ facts }) => ({ items: listPlans(isBillingAdmin(facts)) })
);
