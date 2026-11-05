import { revokeSessionByToken } from '../../../services/sessions';
import { authServices, clearSessionCookie, sessionTokenOf } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'public',
		action: 'auth.logout',
		rateClass: 'write',
		tags: ['auth'],
		summary: 'Sign out',
		description:
			'Ends the session named by the cookie and clears it. A missing session still succeeds.',
		successStatus: 204
	},
	async ({ event }) => {
		const token = sessionTokenOf(event);
		if (token) await revokeSessionByToken(authServices().kv, token);
		clearSessionCookie(event);
		return undefined;
	}
);
