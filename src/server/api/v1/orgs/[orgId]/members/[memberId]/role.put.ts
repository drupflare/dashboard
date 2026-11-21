import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { memberViewSchema, roleBodySchema } from '../../../../../../../shared/members';
import { actorOf, changeRole, membersServices } from '../../../../../../services/members';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.update',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Change a member role',
		description:
			'Sets the role of a member. You can give only roles you hold yourself, and only an owner can give the admin role. The last owner cannot be demoted.',
		params: z.object({ orgId: z.string().min(1), memberId: z.string().min(1).max(64) }),
		body: roleBodySchema,
		response: memberViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		const role = facts?.membership?.role;
		if (principal === null || orgId === undefined || orgId !== params.orgId || !role) {
			throw new ApiError('not_found', 'Not found');
		}
		return changeRole(
			membersServices(),
			orgId,
			actorOf(principal, role),
			params.memberId,
			body.role
		);
	}
);
