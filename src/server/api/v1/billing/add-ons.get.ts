import { z } from 'zod';
import { METER_IDS, PLANES } from '../../../../shared/plans';
import { isBillingAdmin, listAddOns } from '../../../services/billing';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['billing'],
		summary: 'List add-ons',
		description:
			'Lists what can be bought on top of a plan, as a subscription, a one-time pack or both. Prices follow the same review rule as plans, and an add-on that is not on sale carries the reason.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					meter: z.enum(METER_IDS),
					lookupKey: z.string(),
					unit: z.string(),
					grants: z.number(),
					planes: z.array(z.enum(PLANES)),
					requires: z.array(z.string()).nullable(),
					subscription: z.boolean(),
					packSizes: z.array(z.number()),
					available: z.boolean(),
					availableNote: z.string().nullable(),
					monthly: z.number().nullable().optional(),
					annual: z.number().nullable().optional(),
					packs: z
						.array(z.object({ units: z.number(), price: z.number().nullable() }))
						.optional(),
					unreviewed: z.boolean().optional()
				})
			)
		})
	},
	({ facts }) => ({ items: listAddOns(isBillingAdmin(facts)) })
);
