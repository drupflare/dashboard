import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { inviteViewSchema } from '../../../../../../shared/members';
import { listOrgInvites, membersServices } from '../../../../../services/members';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.read',
		rateClass: 'read',
		tags: ['members'],
		summary: 'List pending invitations',
		description:
			'Lists the invitations that are waiting to be accepted. The invitation link is never shown again after the email is sent.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.array(inviteViewSchema)
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listOrgInvites(membersServices(), orgId);
	}
);
