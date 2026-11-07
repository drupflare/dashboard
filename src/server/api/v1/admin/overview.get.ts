import { z } from 'zod';
import { adminOverview } from '../../../db/repos/admin';
import { organizationServices } from '../../../services/organizations';
import { defineApi } from '../../../utils/define-api';

const counts = z.record(z.string(), z.number());

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.aggregates.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read the platform totals',
		description:
			'Counts of users, organisations, sites by state and operations by status. Needs the admin role and a Cloudflare Access login.',
		response: z.object({
			users: z.number(),
			organizations: z.number(),
			sites: counts,
			operations: counts
		})
	},
	async () => adminOverview(await organizationServices().getDb())
);
