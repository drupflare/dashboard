import { z } from 'zod';
import { TEMPLATE_CATEGORIES, TEMPLATES } from '../../../../shared/templates';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['templates'],
		summary: 'List site templates',
		description:
			'Lists the site templates with their category, whether they are free and whether they can be used now. Disabled templates carry a Coming Soon label.',
		response: z.object({
			items: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					category: z.enum(TEMPLATE_CATEGORIES).nullable(),
					free: z.boolean(),
					enabled: z.boolean(),
					comingSoon: z.string().nullable()
				})
			)
		})
	},
	() => ({
		items: TEMPLATES.map(({ id, name, category, free, enabled, comingSoon }) => ({
			id,
			name,
			category,
			free,
			enabled,
			comingSoon
		}))
	})
);
