import { requireFresh } from '../../../services/identities';
import { revokeAllSessions } from '../../../services/sessions';
import { authServices, stepUpAtOf, type UserPrincipal } from '../../../utils/auth';
import { defineApi } from '../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Sign out other devices',
		description:
			'Ends every session except the one making this request. It needs a fresh authentication.',
		successStatus: 204
	},
	async ({ principal }) => {
		const user = principal as UserPrincipal;
		requireFresh(stepUpAtOf(user));
		await revokeAllSessions(authServices().kv, user.userId, user.sessionId);
		return undefined;
	}
);
