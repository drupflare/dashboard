import { z } from 'zod';
import { listAdminUsers } from '../../../db/repos/admin';
import { organizationServices } from '../../../services/organizations';
import { adminPageOf, adminPageQuery } from '../../../utils/admin';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'List users',
		description:
			'The newest users first: address, name, platform role and when they joined. Never a credential or a session.',
		query: adminPageQuery,
		response: adminPageOf(
			z.object({
				id: z.string(),
				email: z.string(),
				displayName: z.string().nullable(),
				platformRole: z.string().nullable(),
				createdAt: z.number()
			})
		)
	},
	async ({ query }) => listAdminUsers(await organizationServices().getDb(), query)
);
