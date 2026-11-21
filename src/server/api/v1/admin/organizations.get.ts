import { z } from 'zod';
import { listAdminOrganizations } from '../../../db/repos/admin';
import { organizationServices } from '../../../services/organizations';
import { adminPageOf, adminPageQuery } from '../../../utils/admin';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List organizations',
		description:
			'The newest organizations first across every shard. A name search matches any part of the name.',
		query: adminPageQuery.extend({ q: z.string().trim().max(100).optional() }),
		response: adminPageOf(
			z.object({
				id: z.string(),
				name: z.string(),
				personal: z.boolean(),
				createdBy: z.string(),
				createdAt: z.number()
			})
		)
	},
	async ({ query }) => listAdminOrganizations(await organizationServices().getDb(), query)
);
