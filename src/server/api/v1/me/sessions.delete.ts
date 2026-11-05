import { revokeAllSessions } from '../../../services/sessions';
import { authServices, type UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Sign out other devices',
		description: 'Ends every session except the one making this request.',
		successStatus: 204
	},
	async ({ principal }) => {
		const { userId, sessionId } = principal as UserPrincipal;
		await revokeAllSessions(authServices().kv, userId, sessionId);
		return undefined;
	}
);
