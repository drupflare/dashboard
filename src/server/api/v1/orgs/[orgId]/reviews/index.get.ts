import { z } from 'zod';
import { reviewListSchema } from '../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../shared/errors';
import { listReviews } from '../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../services/governance';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'read',
		tags: ['access-reviews'],
		summary: 'List access reviews',
		description:
			'Lists the access reviews of the organization, newest first, with how many items each has and how many are still waiting. Owners and admins see every item. A department admin sees only the reviews with items in their own departments, and the counts cover only those items. Anyone else is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		response: reviewListSchema
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const actor = governanceActor(principal, facts);
		return { items: await listReviews(governanceServices(), orgId, actor) };
	}
);
