import { z } from 'zod';
import { ApiError } from '../../../../shared/errors';
import { invitePreviewSchema } from '../../../../shared/members';
import { membersServices, previewInvite, userIdOf } from '../../../services/members';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'invite.accept',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Preview an invitation',
		description:
			'Shows the organization and role an invitation offers, and whether it was sent to the signed-in address. The token goes in the body so it stays out of logs. An API key is refused.',
		body: z.strictObject({ token: z.string().min(1).max(512) }),
		response: invitePreviewSchema
	},
	({ principal, body }) => {
		if (principal === null) throw new ApiError('unauthenticated', 'Authentication is required');
		return previewInvite(membersServices(), body.token, userIdOf(principal));
	}
);
