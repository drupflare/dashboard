import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { actorOf, membersServices, removeOrgMember } from '../../../../../services/members';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.remove',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Remove a member',
		description:
			'Removes a member from the organization. You cannot remove someone whose role is above yours, and the last owner cannot be removed. Removing yourself leaves the organization.',
		params: z.object({ orgId: z.string().min(1), memberId: z.string().min(1).max(64) }),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		const role = facts?.membership?.role;
		if (principal === null || orgId === undefined || orgId !== params.orgId || !role) {
			throw new ApiError('not_found', 'Not found');
		}
		await removeOrgMember(membersServices(), orgId, actorOf(principal, role), params.memberId);
	}
);
