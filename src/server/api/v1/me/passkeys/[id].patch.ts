import { z } from 'zod';
import { PASSKEY_NAME_MAX } from '../../../../integrations/webauthn';
import { identityDeps, renamePasskey } from '../../../../services/identities';
import { type UserPrincipal } from '../../../../utils/auth';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'session',
		action: 'account.security.manage',
		rateClass: 'write',
		tags: ['me'],
		summary: 'Rename a passkey',
		description:
			'Changes the label of one of your passkeys. It does not need a fresh authentication.',
		params: z.object({ id: z.string().min(1).max(512) }),
		body: z.object({ name: z.string().min(1).max(PASSKEY_NAME_MAX) }),
		successStatus: 204
	},
	async ({ principal, params, body }) => {
		const user = principal as UserPrincipal;
		await renamePasskey(identityDeps(), {
			userId: user.userId,
			passkeyId: params.id,
			name: body.name
		});
		return undefined;
	}
);
