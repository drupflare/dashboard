import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf, membersServices, revokeInvite } from '../../../../../../services/members';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.invite',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Revoke an invitation',
		description:
			'Stops an invitation from being accepted. The link in the email no longer works.',
		params: z.object({ orgId: z.string().min(1), inviteId: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		const role = facts?.membership?.role;
		if (principal === null || orgId === undefined || orgId !== params.orgId || !role) {
			throw new ApiError('not_found', 'Not found');
		}
		await revokeInvite(membersServices(), orgId, actorOf(principal, role), params.inviteId);
	}
);
