import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { inviteCreateBodySchema, inviteViewSchema } from '../../../../../../shared/members';
import {
	actorOf,
	inviteMember,
	inviterNameOf,
	membersServices
} from '../../../../../services/members';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.invite',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Invite a member',
		description:
			'Emails an invitation to join the organization with a role. The link works once and expires after seven days. Owners cannot be invited, and only an owner can invite an admin.',
		params: z.object({ orgId: z.string().min(1) }),
		body: inviteCreateBodySchema,
		response: inviteViewSchema,
		successStatus: 201
	},
	async ({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		const role = facts?.membership?.role;
		if (principal === null || orgId === undefined || orgId !== params.orgId || !role) {
			throw new ApiError('not_found', 'Not found');
		}
		const deps = membersServices();
		return inviteMember(
			deps,
			orgId,
			actorOf(principal, role),
			body,
			await inviterNameOf(deps, principal)
		);
	}
);
