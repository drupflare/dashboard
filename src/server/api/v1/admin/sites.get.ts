import { z } from 'zod';
import { listAdminSites } from '../../../db/repos/admin';
import { organizationServices } from '../../../services/organizations';
import { adminPageOf, adminPageQuery } from '../../../utils/admin';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List sites',
		description:
			'The newest sites first across every shard. Metadata only, never site content.',
		query: adminPageQuery,
		response: adminPageOf(
			z.object({
				id: z.string(),
				organizationId: z.string(),
				name: z.string(),
				kind: z.string(),
				plane: z.string(),
				state: z.string(),
				primaryHostname: z.string().nullable(),
				createdAt: z.number()
			})
		)
	},
	async ({ query }) => listAdminSites(await organizationServices().getDb(), query)
);
