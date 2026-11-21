import { z } from 'zod';
import {
	reviewDecideBodySchema,
	reviewItemViewSchema
} from '../../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../../shared/errors';
import { decideItem } from '../../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../../services/governance';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'write',
		tags: ['access-reviews'],
		summary: 'Decide one item in a review',
		description:
			'Keeps or removes one item. Owners and admins decide any item. A department admin decides only items inside their own departments, and only while the organization setting allows it. A removal is carried out when the review closes, or right away when applyNow is true, which only an owner or admin can ask for. You cannot decide an item about yourself.',
		params: z.object({ orgId: z.string().min(1), reviewId: z.string().min(1).max(64) }),
		body: reviewDecideBodySchema,
		response: reviewItemViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return decideItem(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			params.reviewId,
			body
		);
	}
);
