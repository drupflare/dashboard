import { z } from 'zod';
import { ApiError } from '../../../../shared/errors';
import { inviteAcceptedSchema } from '../../../../shared/members';
import { acceptInvite, membersServices } from '../../../services/members';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'invite.accept',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Accept an invitation',
		description:
			'Joins the organization with the role the invitation offers. The invitation is used up by this call, and the signed-in address must match the one it was sent to. An API key is refused.',
		body: z.strictObject({ token: z.string().min(1).max(512) }),
		response: inviteAcceptedSchema
	},
	({ principal, body }) => {
		if (principal === null) throw new ApiError('unauthenticated', 'Authentication is required');
		return acceptInvite(membersServices(), body.token, principal);
	}
);
