import { z } from 'zod';
import { TEMPLATE_ENTRY_IDS, TEMPLATE_STATES } from '../../../../shared/template-entries';
import { TEMPLATE_CATEGORIES, TEMPLATES } from '../../../../shared/templates';
import { siteServices } from '../../../services/sites';
import { listTemplates } from '../../../services/templates';
import { defineApi } from '../../../utils/define-api';

const advisory = z.object({ id: z.string(), package: z.string() });

export default defineApi(
	{
		scope: 'session',
		action: 'account.read',
		rateClass: 'read',
		tags: ['templates'],
		summary: 'List site templates',
		description:
			'Lists the site templates with their category, whether they are free and whether they can be used now. Disabled templates carry a Coming Soon label. The Drupal templates built from the corpus are listed apart, each with its build state, any security advisories its Drupal core carries, any patch that did not apply, and whether it fits the Free plan.',
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
			),
			drupal: z.array(
				z.object({
					id: z.enum(TEMPLATE_ENTRY_IDS),
					name: z.string(),
					summary: z.string(),
					state: z.enum(TEMPLATE_STATES),
					commit: z.string(),
					advisories: z.array(advisory),
					patchNotes: z.array(z.object({ package: z.string(), patch: z.string() })),
					fit: z
						.object({
							fits: z.boolean(),
							rows: z.number(),
							limit: z.number(),
							percent: z.number()
						})
						.nullable(),
					usable: z.boolean(),
					reason: z.string().nullable(),
					builtAt: z.number().nullable()
				})
			)
		})
	},
	async () => ({
		items: TEMPLATES.map(({ id, name, category, free, enabled, comingSoon }) => ({
			id,
			name,
			category,
			free,
			enabled,
			comingSoon
		})),
		drupal: await listTemplates(siteServices())
	})
);
