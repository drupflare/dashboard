import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { adminOrganizationCounts } from '../../../../db/repos/admin';
import { getAccount } from '../../../../db/repos/billing';
import { getOrganization } from '../../../../db/repos/organization';
import { organizationServices } from '../../../../services/organizations';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.metadata.read',
		rateClass: 'read',
		tags: ['admin'],
		summary: 'Read one organisation',
		description:
			'Metadata for one organisation: its member count, sites by state, plan and subscription state. Notification activity is not recorded yet. Never site content.',
		params: z.object({ id: z.string().min(1).max(128) }),
		response: z.object({
			id: z.string(),
			name: z.string(),
			personal: z.boolean(),
			createdBy: z.string(),
			createdAt: z.number(),
			members: z.number(),
			sites: z.record(z.string(), z.number()),
			// null when the organisation has no billing row yet, which reads as the free plan
			plan: z.string().nullable(),
			subscription: z.object({ status: z.string(), entitlementState: z.string() }).nullable()
		})
	},
	async ({ params }) => {
		const db = await organizationServices().getDb();
		const org = await getOrganization(db, params.id);
		if (org === null) throw new ApiError('not_found', 'No organization has this id');
		const counts = await adminOrganizationCounts(db, org.id);
		const account = await getAccount(db, org.id);
		return {
			id: org.id,
			name: org.name,
			personal: org.personal,
			createdBy: org.createdBy,
			createdAt: org.createdAt,
			members: counts.members,
			sites: counts.sites,
			plan: account?.planId ?? null,
			subscription: account
				? { status: account.status, entitlementState: account.entitlementState }
				: null
		};
	}
);
