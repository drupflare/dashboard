import { z } from 'zod';
import { identityDeps, unlinkIdentity } from '../../../../services/identities';
import { stepUpAtOf, type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Unlink a provider',
		description:
			'Removes a linked provider identity. It needs a fresh authentication and refuses to remove your last sign-in method.',
		params: z.object({ id: z.uuid() }),
		successStatus: 204
	},
	async ({ principal, params }) => {
		const user = principal as UserPrincipal;
		await unlinkIdentity(identityDeps(), {
			userId: user.userId,
			identityId: params.id,
			stepUpAt: stepUpAtOf(user)
		});
		return undefined;
	}
);
