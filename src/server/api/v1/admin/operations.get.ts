import { z } from 'zod';
import { listAdminOperations } from '../../../db/repos/admin';
import { organizationServices } from '../../../services/organizations';
import { adminPageOf, adminPageQuery } from '../../../utils/admin';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List operations',
		description:
			'The newest operations first across every shard: type, status, verification and, for a failed one, the plain reason it stopped.',
		query: adminPageQuery,
		response: adminPageOf(
			z.object({
				id: z.string(),
				organizationId: z.string(),
				siteId: z.string().nullable(),
				type: z.string(),
				status: z.string(),
				verification: z.string(),
				reason: z.string().nullable(),
				createdAt: z.number(),
				updatedAt: z.number()
			})
		)
	},
	async ({ query }) => listAdminOperations(await organizationServices().getDb(), query)
);
