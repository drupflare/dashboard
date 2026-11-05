import { z } from 'zod';
import { identityDeps, removePasskey } from '../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Remove a passkey',
		description:
			'Removes one of your passkeys. It needs a fresh authentication and refuses to remove your last sign-in method.',
		params: z.object({ id: z.string().min(1).max(512) }),
		successStatus: 204
	},
	async ({ principal, params }) => {
		const user = principal as UserPrincipal;
		await removePasskey(identityDeps(), {
			userId: user.userId,
			passkeyId: params.id,
			stepUpAt: stepUpAtOf(user)
		});
		return undefined;
	}
);
