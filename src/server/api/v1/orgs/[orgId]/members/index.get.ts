import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { memberPageSchema } from '../../../../../../shared/members';
import { listOrgMembers, membersServices } from '../../../../../services/members';
import { defineApi } from '../../../../../utils/define-api';
import { resolveLimit } from '../../../../../utils/pagination';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.read',
		rateClass: 'read',
		tags: ['members'],
		summary: 'List members',
		description:
			'Lists the members of the organization in the path with their role and the day they joined. Pass the last id from a page as cursor to read the next one.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			cursor: z.string().min(1).max(64).optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: memberPageSchema
	},
	({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listOrgMembers(membersServices(), orgId, {
			after: query.cursor,
			limit: resolveLimit(query.limit === undefined ? undefined : Number(query.limit))
		});
	}
);
