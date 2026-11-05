import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { revokeSession } from '../../../../services/sessions';
import { authServices, clearSessionCookie, type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Revoke a session',
		description:
			'Ends one of your sessions. Revoking the session you are using also clears its cookie.',
		params: z.object({ id: z.string().regex(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/) }),
		successStatus: 204
	},
	async ({ event, principal, params }) => {
		const { userId, sessionId } = principal as UserPrincipal;
		if (!(await revokeSession(authServices().kv, userId, params.id))) {
			throw new ApiError('not_found', 'Not found');
		}
		if (params.id === sessionId) clearSessionCookie(event);
		return undefined;
	}
);
