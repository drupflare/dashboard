import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { inviteViewSchema } from '../../../../../../../shared/members';
import {
	actorOf,
	inviterNameOf,
	membersServices,
	resendInvite
} from '../../../../../../services/members';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.invite',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Resend an invitation',
		description:
			'Sends the invitation again with a new link and a new seven day expiry. The link from the earlier email stops working.',
		params: z.object({ orgId: z.string().min(1), inviteId: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: inviteViewSchema
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		const role = facts?.membership?.role;
		if (principal === null || orgId === undefined || orgId !== params.orgId || !role) {
			throw new ApiError('not_found', 'Not found');
		}
		const deps = membersServices();
		return resendInvite(
			deps,
			orgId,
			actorOf(principal, role),
			params.inviteId,
			await inviterNameOf(deps, principal)
		);
	}
);
